// Music playback manager. One GuildMusic per guild (no duplicate players);
// playback transitions run under a mutex (no queue races); failures skip to
// the next track; disconnects are recovered or cleaned up; state persists.
import { EventEmitter } from 'node:events';
import { MusicQueue, Mutex } from './queue.js';

const MAX_CONSECUTIVE_FAILURES = 3;

export class GuildMusic extends EventEmitter {
  /**
   * @param {object} o
   * @param {{connect:(channelId:string)=>Promise<any>, createPlayer:()=>any, createResource:(track:object)=>Promise<any>, waitReconnect:(conn:any)=>Promise<boolean>, subscribe:(conn:any, player:any)=>void, disconnect:(conn:any)=>void}} o.adapter
   */
  constructor({ guildId, db, adapter, logger, idleLeaveMs = 300000 }) {
    super();
    Object.assign(this, { guildId, db, adapter, logger, idleLeaveMs });
    this.queue = new MusicQueue();
    this.lock = new Mutex();
    this.player = null;
    this.connection = null;
    this.voiceChannelId = null;
    this.textChannelId = null;
    this.failures = 0;
    this.lastError = null;
    this.idleTimer = null;
    this.restore();
  }

  get status() {
    return this.player?.state?.status ?? 'idle';
  }

  restore() {
    const row = this.db.get('SELECT * FROM music_state WHERE guild_id = ?', this.guildId);
    if (!row) return;
    try {
      const tracks = JSON.parse(row.queue);
      const np = row.now_playing ? JSON.parse(row.now_playing) : null;
      // An interrupted track goes back to the front of the queue.
      this.queue = new MusicQueue(np && !np.live ? [np, ...tracks] : tracks);
      this.textChannelId = row.text_channel_id;
    } catch {
      /* corrupt state is ignored */
    }
  }

  persist() {
    this.db.run(
      `INSERT INTO music_state (guild_id, voice_channel_id, text_channel_id, queue, now_playing, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET voice_channel_id = excluded.voice_channel_id, text_channel_id = excluded.text_channel_id,
         queue = excluded.queue, now_playing = excluded.now_playing, updated_at = excluded.updated_at`,
      this.guildId,
      this.voiceChannelId,
      this.textChannelId,
      JSON.stringify(this.queue.tracks),
      this.queue.current ? JSON.stringify(this.queue.current) : null,
      Date.now(),
    );
  }

  ensurePlayer() {
    if (this.player) return this.player;
    const p = this.adapter.createPlayer();
    p.on('stateChange', (oldS, newS) => {
      if (newS.status === 'idle' && oldS.status !== 'idle') {
        if (this.lastError) this.failures++;
        else this.failures = 0;
        this.lastError = null;
        this.lock.run(() => this.playNext()).catch((err) => this.logger?.error('music advance failed', { err }));
      }
    });
    p.on('error', (err) => {
      this.lastError = err;
      this.logger?.warn('playback error', { guildId: this.guildId, err: err.message, track: this.queue.current?.title });
      this.emit('trackError', this.queue.current, err);
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
        if (!recovered) {
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

  /** Add a track; starts playback if nothing is playing. */
  enqueue(track, { voiceChannelId, textChannelId }) {
    return this.lock.run(async () => {
      clearTimeout(this.idleTimer);
      await this.ensureConnection(voiceChannelId);
      this.textChannelId = textChannelId ?? this.textChannelId;
      const position = this.queue.add(track);
      let started = null;
      if (!this.queue.current || this.status === 'idle') started = await this.playNext();
      this.persist();
      return { position: started ? 0 : position, started };
    });
  }

  /** Must be called while holding the lock. */
  async playNext() {
    clearTimeout(this.idleTimer);
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
      try {
        const resource = await this.adapter.createResource(track);
        this.ensurePlayer().play(resource);
        this.emit('trackStart', track);
        return track;
      } catch (err) {
        this.failures++;
        this.logger?.warn('could not start track; skipping', { track: track.title, err: err.message });
        this.emit('trackError', track, err);
      }
    }
  }

  skip() {
    if (!this.player || this.status === 'idle') return false;
    return this.player.stop(true) !== false;
  }

  pause() {
    return Boolean(this.player?.pause(true));
  }

  resume() {
    return Boolean(this.player?.unpause());
  }

  stop() {
    return this.lock.run(async () => {
      this.queue.clear();
      this.persist();
      this.player?.stop(true);
      this.teardown({ keepQueue: false });
    });
  }

  scheduleIdleLeave() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.status === 'idle' && !this.queue.length) this.teardown({ keepQueue: false });
    }, this.idleLeaveMs);
    this.idleTimer.unref?.();
  }

  teardown({ keepQueue }) {
    clearTimeout(this.idleTimer);
    if (!keepQueue) this.queue.clear();
    else if (this.queue.current && !this.queue.current.live) this.queue.tracks.unshift(this.queue.current);
    this.queue.current = null;
    if (this.connection) {
      try {
        this.adapter.disconnect(this.connection);
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
  constructor({ db, logger, idleLeaveMs, adapterFor }) {
    Object.assign(this, { db, logger, idleLeaveMs, adapterFor });
    this.guilds = new Map();
  }

  /** Exactly one GuildMusic per guild (prevents duplicate players). */
  get(guild) {
    let gm = this.guilds.get(guild.id);
    if (!gm) {
      gm = new GuildMusic({ guildId: guild.id, db: this.db, adapter: this.adapterFor(guild), logger: this.logger, idleLeaveMs: this.idleLeaveMs });
      this.guilds.set(guild.id, gm);
    }
    return gm;
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
