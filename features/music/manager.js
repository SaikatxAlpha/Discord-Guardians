// Music playback manager. One GuildMusic per guild (no duplicate players,
// no shared state between servers); playback transitions run under a mutex
// (no queue races); failures skip to the next track; disconnects are
// recovered or cleaned up; queue, volume and loop mode persist.
import { EventEmitter } from 'node:events';
import { MusicQueue, Mutex } from './queue.js';

const MAX_CONSECUTIVE_FAILURES = 3;
export const MAX_VOLUME = 100;
const START_TIMEOUT_MS = 20000;
export const LOOP_MODES = ['off', 'track', 'queue'];

export class GuildMusic extends EventEmitter {
  /**
   * @param {object} o
   * @param {{connect:(channelId:string)=>Promise<any>, createPlayer:()=>any, createResource:(track:object)=>Promise<any>, waitReconnect:(conn:any)=>Promise<boolean>, subscribe:(conn:any, player:any)=>void, disconnect:(conn:any)=>void}} o.adapter
   */
  constructor({ guildId, db, adapter, logger, idleLeaveMs = 300000, maxQueue = 100, defaultVolume = 70, startTimeoutMs = START_TIMEOUT_MS }) {
    super();
    Object.assign(this, { guildId, db, adapter, logger, idleLeaveMs, maxQueue, startTimeoutMs });
    this.starting = false; // a track is being started; its outcome is handled by playNext
    this.startErrors = [];
    this.queue = new MusicQueue([], { max: maxQueue });
    this.lock = new Mutex();
    this.player = null;
    this.resource = null;
    this.connection = null;
    this.voiceChannelId = null;
    this.textChannelId = null;
    this.failures = 0;
    this.lastError = null;
    this.idleTimer = null;
    this.volume = Math.min(MAX_VOLUME, defaultVolume);
    this.loop = 'off';
    this.stopping = false;
    this.restore();
  }

  get status() {
    return this.player?.state?.status ?? 'idle';
  }

  /** Milliseconds into the current track (0 if unknown). */
  get position() {
    return this.resource?.playbackDuration ?? 0;
  }

  restore() {
    const row = this.db.get('SELECT * FROM music_state WHERE guild_id = ?', this.guildId);
    if (!row) return;
    try {
      const tracks = JSON.parse(row.queue);
      const np = row.now_playing ? JSON.parse(row.now_playing) : null;
      // An interrupted track goes back to the front of the queue.
      this.queue = new MusicQueue(np && !np.live ? [np, ...tracks] : tracks, { max: this.maxQueue });
      this.textChannelId = row.text_channel_id;
      const s = JSON.parse(row.settings ?? '{}');
      if (Number.isFinite(s.volume)) this.volume = Math.min(MAX_VOLUME, s.volume);
      if (LOOP_MODES.includes(s.loop)) this.loop = s.loop;
    } catch {
      /* corrupt state is ignored */
    }
  }

  persist() {
    this.db.run(
      `INSERT INTO music_state (guild_id, voice_channel_id, text_channel_id, queue, now_playing, settings, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET voice_channel_id = excluded.voice_channel_id, text_channel_id = excluded.text_channel_id,
         queue = excluded.queue, now_playing = excluded.now_playing, settings = excluded.settings, updated_at = excluded.updated_at`,
      this.guildId,
      this.voiceChannelId,
      this.textChannelId,
      JSON.stringify(this.queue.tracks),
      this.queue.current ? JSON.stringify(this.queue.current) : null,
      JSON.stringify({ volume: this.volume, loop: this.loop }),
      Date.now(),
    );
  }

  ensurePlayer() {
    if (this.player) return this.player;
    const p = this.adapter.createPlayer();
    p.on('stateChange', (oldS, newS) => {
      if (newS.status === 'idle' && oldS.status !== 'idle') {
        // While a track is starting, playNext decides what happens next.
        if (this.starting) return;
        // Ignore the end of a resource that is no longer the current one.
        if (oldS.resource && this.resource && oldS.resource !== this.resource) return;
        if (this.lastError) this.failures++;
        else this.failures = 0;
        const failed = Boolean(this.lastError);
        this.lastError = null;
        this.resource = null;
        this.lock.run(() => this.advance({ failed })).catch((err) => this.logger?.error('music advance failed', { err }));
      }
    });
    p.on('error', (err) => {
      this.lastError = err;
      this.logger?.warn('playback error', { guildId: this.guildId, err: err.message, provider: this.queue.current?.provider });
      if (!this.starting) this.emit('trackError', this.queue.current, err);
    });
    this.player = p;
    return p;
  }

  async ensureConnection(voiceChannelId) {
    if (this.connection && this.voiceChannelId === voiceChannelId && this.connection.state?.status !== 'destroyed') return this.connection;
    const conn = await this.adapter.connect(voiceChannelId);
    this.connection = conn;
    this.voiceChannelId = voiceChannelId;
    this.adapter.subscribe(conn, this.ensurePlayer());
    conn.on?.('stateChange', async (_o, n) => {
      if (n.status === 'disconnected') {
        const recovered = await this.adapter.waitReconnect(conn);
        if (!recovered && this.connection === conn) {
          this.logger?.warn('voice disconnected; cleaning up', { guildId: this.guildId });
          this.emit('disconnected');
          this.teardown({ keepQueue: true });
        }
      } else if (n.status === 'destroyed' && this.connection === conn) {
        this.connection = null;
      }
    });
    return conn;
  }

  /** Add one track; starts playback if nothing is playing. */
  enqueue(track, { voiceChannelId, textChannelId }) {
    return this.enqueueMany([track], { voiceChannelId, textChannelId }).then((r) => ({ position: r.started ? 0 : r.firstPosition, started: r.started, errors: r.errors, playing: r.playing }));
  }

  /** Add several tracks (playlist); returns how many were added. */
  enqueueMany(tracks, { voiceChannelId, textChannelId }) {
    return this.lock.run(async () => {
      clearTimeout(this.idleTimer);
      if (!tracks.length) throw new Error('Nothing to add.');
      if (this.queue.length >= this.maxQueue) throw new Error(`The queue is full (${this.maxQueue} tracks).`);
      await this.ensureConnection(voiceChannelId);
      this.textChannelId = textChannelId ?? this.textChannelId;
      const firstPosition = this.queue.length + 1;
      const added = this.queue.addMany(tracks);
      let started = null;
      this.startErrors = [];
      this.inRequest = true;
      try {
        if (!this.queue.current || this.status === 'idle') started = await this.playNext();
      } finally {
        this.inRequest = false;
      }
      this.persist();
      // started is only set once audio is actually flowing (player state "playing").
      return { added, skipped: tracks.length - added, started, firstPosition, errors: [...this.startErrors], playing: this.queue.current };
    });
  }

  /** Called on idle (under the lock): apply loop mode, then play the next track. */
  async advance({ failed }) {
    const cur = this.queue.current;
    if (cur && !failed && !this.stopping) {
      if (this.loop === 'track') this.queue.tracks.unshift(cur);
      else if (this.loop === 'queue') this.queue.tracks.push(cur);
    }
    return this.playNext();
  }

  /** Must be called while holding the lock. */
  async playNext() {
    clearTimeout(this.idleTimer);
    this.stopping = false;
    for (;;) {
      if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.emit('halted', this.failures);
        this.failures = 0;
        this.queue.clear();
        this.persist();
        this.scheduleIdleLeave();
        return null;
      }
      const track = this.queue.next();
      this.persist();
      if (!track) {
        this.scheduleIdleLeave();
        return null;
      }
      this.starting = true;
      try {
        const resource = await this.adapter.createResource(track);
        resource.volume?.setVolume?.(this.volume / 100);
        this.resource = resource;
        await this.startAndWait(resource);
        this.starting = false;
        // failures resets only when a track finishes cleanly (idle handler), so
        // streams that start and then keep dying still halt the queue.
        this.lastError = null;
        this.emit('trackStart', track, { viaRequest: Boolean(this.inRequest) });
        return track;
      } catch (err) {
        if (this.player && this.player.state?.status !== 'idle') this.player.stop(true);
        this.starting = false;
        this.resource = null;
        this.lastError = null;
        this.failures++;
        this.startErrors.push({ track, error: err });
        this.logger?.warn('could not start track; skipping', { guildId: this.guildId, provider: track.provider, code: err.code ?? null, err: err.message });
        this.emit('trackError', track, err);
      }
    }
  }

  /** Play a resource and resolve only when audio is actually flowing. */
  startAndWait(resource) {
    const p = this.ensurePlayer();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        clearTimeout(timer);
        p.off('stateChange', onState);
        p.off('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onState = (_o, n) => {
        if (n.status === 'playing') done();
        else if (n.status === 'idle') done(this.lastError ?? new Error('The stream ended before any audio played.'));
      };
      const onError = (e) => done(e);
      // Not unref'd: a pending start must always settle (the timer is cleared in done()).
      const timer = setTimeout(() => done(new Error(`No audio arrived within ${Math.round(this.startTimeoutMs / 1000)} s.`)), this.startTimeoutMs);
      p.on('stateChange', onState);
      p.on('error', onError);
      p.play(resource);
      if (p.state?.status === 'playing') done();
    });
  }

  skip() {
    if (!this.player || this.status === 'idle') return false;
    // Skipping must not re-queue the current track in "track" loop mode.
    if (this.loop === 'track') this.stopping = true;
    return this.player.stop(true) !== false;
  }

  pause() {
    return Boolean(this.player?.pause(true));
  }

  resume() {
    return Boolean(this.player?.unpause());
  }

  setVolume(percent) {
    if (!Number.isFinite(percent) || percent < 0 || percent > MAX_VOLUME) throw new Error(`Volume must be between 0 and ${MAX_VOLUME}.`);
    this.volume = Math.round(percent);
    this.resource?.volume?.setVolume?.(this.volume / 100);
    this.persist();
    return this.volume;
  }

  setLoop(mode) {
    if (!LOOP_MODES.includes(mode)) throw new Error(`Loop mode must be one of: ${LOOP_MODES.join(', ')}.`);
    this.loop = mode;
    this.persist();
    return mode;
  }

  shuffle() {
    return this.lock.run(async () => {
      const n = this.queue.shuffle();
      this.persist();
      return n;
    });
  }

  /** Stop playback and clear the queue; stay connected until the idle timeout. */
  stop() {
    return this.lock.run(async () => {
      this.stopping = true;
      this.queue.clear();
      this.persist();
      this.player?.stop(true);
      this.scheduleIdleLeave();
    });
  }

  /** Stop, clear and disconnect from voice now. */
  leave() {
    return this.lock.run(async () => {
      const wasConnected = Boolean(this.connection);
      this.stopping = true;
      this.queue.clear();
      this.player?.stop(true);
      this.teardown({ keepQueue: false, force: true });
      return wasConnected;
    });
  }

  /** Remove all upcoming tracks; the current one keeps playing. */
  clearQueue() {
    return this.lock.run(async () => {
      const n = this.queue.length;
      this.queue.tracks = [];
      this.persist();
      return n;
    });
  }

  removeAt(position) {
    return this.lock.run(async () => {
      const t = this.queue.remove(position);
      this.persist();
      return t;
    });
  }

  moveTrack(from, to) {
    return this.lock.run(async () => {
      const t = this.queue.move(from, to);
      this.persist();
      return t;
    });
  }

  scheduleIdleLeave() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle' && !this.queue.length) this.teardown({ keepQueue: false });
    }, this.idleLeaveMs);
    this.idleTimer.unref?.();
  }

  teardown({ keepQueue, force = false }) {
    clearTimeout(this.idleTimer);
    if (!keepQueue) this.queue.clear();
    else if (this.queue.current && !this.queue.current.live) this.queue.tracks.unshift(this.queue.current);
    this.queue.current = null;
    this.resource = null;
    if (this.connection) {
      try {
        this.adapter.disconnect(this.connection, { force });
      } catch {
        /* already gone */
      }
    }
    this.connection = null;
    this.voiceChannelId = null;
    this.persist();
    this.emit('teardown');
  }
}

export class MusicManager {
  constructor({ db, logger, idleLeaveMs, adapterFor, maxQueue = 100, defaultVolume = 70 }) {
    Object.assign(this, { db, logger, idleLeaveMs, adapterFor, maxQueue, defaultVolume });
    this.guilds = new Map();
    this.created = [];
  }

  /** Exactly one GuildMusic per guild (prevents duplicate players). */
  get(guild) {
    let gm = this.guilds.get(guild.id);
    if (!gm) {
      gm = new GuildMusic({ guildId: guild.id, db: this.db, adapter: this.adapterFor(guild), logger: this.logger, idleLeaveMs: this.idleLeaveMs, maxQueue: this.maxQueue, defaultVolume: this.defaultVolume });
      this.guilds.set(guild.id, gm);
      for (const fn of this.created) fn(gm);
    }
    return gm;
  }

  /** Register a callback for every new GuildMusic (e.g. to wire notifications once). */
  onCreate(fn) {
    this.created.push(fn);
  }

  peek(guildId) {
    return this.guilds.get(guildId) ?? null;
  }

  shutdown() {
    for (const gm of this.guilds.values()) {
      gm.persist();
      gm.teardown({ keepQueue: true });
    }
  }
}
