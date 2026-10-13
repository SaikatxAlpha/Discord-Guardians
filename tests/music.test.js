import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MusicQueue } from '../features/music/queue.js';
import { GuildMusic, MusicManager } from '../features/music/manager.js';
import { searchTracks, validateDirectUrl, searchLocal, resolveLink, parsePlaylistFile, matchScore, cleanVideoTitle, MusicError, describeTrack } from '../features/music/providers.js';
import { memoryLogger } from '../core/logger.js';
import { memDb, tempDir, testConfig } from './helpers.js';

/** MOCK voice layer: a player that emits the same state transitions as @discordjs/voice. */
class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.state = { status: 'idle' };
    this.played = [];
  }
  set(status) {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
  }
  play(res) {
    this.played.push(res.track.title);
    this.set('playing');
  }
  stop() {
    if (this.state.status === 'idle') return false;
    this.set('idle');
    return true;
  }
  pause() {
    if (this.state.status !== 'playing') return false;
    this.set('paused');
    return true;
  }
  unpause() {
    if (this.state.status !== 'paused') return false;
    this.set('playing');
    return true;
  }
  fail(err) {
    this.emit('error', err);
    this.set('idle');
  }
}

function fakeAdapter({ failResource = new Set(), reconnect = true } = {}) {
  const a = {
    connects: 0,
    players: [],
    conns: [],
    disconnected: 0,
    volumes: [],
    async connect(channelId) {
      a.connects++;
      const c = new EventEmitter();
      c.state = { status: 'ready' };
      c.channelId = channelId;
      a.conns.push(c);
      return c;
    },
    createPlayer() {
      const p = new FakePlayer();
      a.players.push(p);
      return p;
    },
    async createResource(track) {
      if (failResource.has(track.title)) throw new MusicError('unavailable', `cannot open ${track.title}`);
      return { track, volume: { setVolume: (v) => a.volumes.push(v) } };
    },
    waitReconnect: async () => reconnect,
    subscribe() {},
    disconnect() {
      a.disconnected++;
    },
  };
  return a;
}

const t = (title, extra = {}) => ({ provider: 'audius', title, input: `https://example.org/${title}.mp3`, ...extra });
const tick = () => new Promise((r) => setTimeout(r, 10));
const gmFor = (o = {}) => new GuildMusic({ guildId: o.guildId ?? 'g', db: o.db ?? memDb(), adapter: o.adapter ?? fakeAdapter(), logger: memoryLogger(), ...o });

// ------------------------------------------------------------------ queue & playback

test('queue operations: add, addMany, remove, move, shuffle, bounds', () => {
  const q = new MusicQueue([], { max: 5 });
  ['a', 'b', 'c'].forEach((x) => q.add(t(x)));
  assert.equal(q.move(3, 1).title, 'c');
  assert.deepEqual(q.tracks.map((x) => x.title), ['c', 'a', 'b']);
  assert.equal(q.remove(2).title, 'a');
  assert.throws(() => q.remove(9), /between 1 and 2/);
  assert.equal(q.addMany([t('d'), t('e'), t('f'), t('g')]), 3, 'capped at max');
  let i = 0;
  const seq = [0.1, 0.9, 0.5, 0.3];
  q.shuffle(() => seq[i++ % seq.length]);
  assert.equal(q.tracks.length, 5);
  assert.deepEqual([...q.tracks].map((x) => x.title).sort(), ['b', 'c', 'd', 'e', 'f']);
});

test('playback advances, skips failed tracks, and halts after repeated failures', async () => {
  const adapter = fakeAdapter({ failResource: new Set(['bad1']) });
  const gm = gmFor({ adapter });
  const errors = [];
  gm.on('trackError', (tr) => errors.push(tr.title));
  await gm.enqueue(t('one'), { voiceChannelId: 'vc' });
  await gm.enqueue(t('bad1'), { voiceChannelId: 'vc' });
  await gm.enqueue(t('two'), { voiceChannelId: 'vc' });
  const p = adapter.players[0];
  assert.deepEqual(p.played, ['one']);
  p.set('idle');
  await tick();
  assert.deepEqual(p.played, ['one', 'two'], 'bad1 skipped');
  assert.deepEqual(errors, ['bad1']);
  const gm2 = gmFor({ guildId: 'g2' });
  let halted = false;
  gm2.on('halted', () => (halted = true));
  for (const x of ['x1', 'x2', 'x3', 'x4']) await gm2.enqueue(t(x), { voiceChannelId: 'vc' });
  for (let k = 0; k < 3; k++) {
    gm2.player.fail(new Error('stream died'));
    await tick();
  }
  assert.equal(halted, true);
  assert.equal(gm2.queue.length, 0);
});

test('no queue races: concurrent requests start exactly one track and keep order', async () => {
  const adapter = fakeAdapter();
  const gm = gmFor({ adapter });
  const res = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => gm.enqueue(t(x), { voiceChannelId: 'vc' })));
  assert.equal(adapter.players.length, 1, 'single player');
  assert.equal(adapter.connects, 1, 'single connection');
  assert.deepEqual(adapter.players[0].played, ['a']);
  assert.deepEqual(res.map((r) => r.position), [0, 1, 2, 3, 4]);
});

test('two servers have fully isolated queues, players, volume and loop state', async () => {
  const db = memDb();
  const adapters = {};
  const m = new MusicManager({ db, logger: memoryLogger(), adapterFor: (g) => (adapters[g.id] = fakeAdapter()) });
  const A = m.get({ id: 'A' });
  const B = m.get({ id: 'B' });
  assert.equal(m.get({ id: 'A' }), A, 'one manager per server');
  await A.enqueue(t('a1'), { voiceChannelId: 'vcA' });
  await A.enqueue(t('a2'), { voiceChannelId: 'vcA' });
  await B.enqueue(t('b1'), { voiceChannelId: 'vcB' });
  A.setVolume(30);
  B.setLoop('queue');
  await A.stop();
  assert.equal(A.queue.length, 0);
  assert.equal(B.queue.current.title, 'b1', 'stopping A does not affect B');
  assert.equal(B.volume, 70);
  assert.equal(A.loop, 'off');
  assert.notEqual(adapters.A.players[0], adapters.B.players[0]);
  assert.equal(adapters.B.conns[0].channelId, 'vcB');
  const rowA = JSON.parse(db.get(`SELECT settings FROM music_state WHERE guild_id = 'A'`).settings);
  const rowB = JSON.parse(db.get(`SELECT settings FROM music_state WHERE guild_id = 'B'`).settings);
  assert.deepEqual([rowA.volume, rowB.loop], [30, 'queue']);
});

test('volume applies to the live stream and persists; loop modes; skip is not undone by loop', async () => {
  const db = memDb();
  const adapter = fakeAdapter();
  const gm = gmFor({ db, adapter });
  await gm.enqueue(t('song'), { voiceChannelId: 'vc' });
  assert.equal(gm.setVolume(45), 45);
  assert.deepEqual(adapter.volumes, [0.7, 0.45]);
  assert.throws(() => gm.setVolume(500), /between 0 and 150/);
  gm.setLoop('track');
  adapter.players[0].set('idle'); // natural end → replays
  await tick();
  assert.deepEqual(adapter.players[0].played, ['song', 'song']);
  gm.skip(); // explicit skip must move on even in track-loop mode
  await tick();
  assert.equal(gm.queue.current, null);
  assert.throws(() => gm.setLoop('forever'), /Loop mode/);
  const again = gmFor({ db, adapter: fakeAdapter() });
  assert.deepEqual([again.volume, again.loop], [45, 'track'], 'settings restored after restart');
});

test('playlists enqueue in bulk up to the queue limit', async () => {
  const gm = gmFor({ maxQueue: 3 });
  const r = await gm.enqueueMany([t('p1'), t('p2'), t('p3'), t('p4'), t('p5')], { voiceChannelId: 'vc' });
  assert.equal(r.added, 3);
  assert.equal(r.skipped, 2);
  assert.equal(r.started.title, 'p1');
});

test('voice disconnect without recovery cleans up and persists the queue (incl. interrupted track)', async () => {
  const db = memDb();
  const adapter = fakeAdapter({ reconnect: false });
  const gm = gmFor({ db, adapter });
  await gm.enqueue(t('song1'), { voiceChannelId: 'vc', textChannelId: 'tc' });
  await gm.enqueue(t('song2'), { voiceChannelId: 'vc' });
  let disc = false;
  gm.on('disconnected', () => (disc = true));
  adapter.conns[0].emit('stateChange', { status: 'ready' }, { status: 'disconnected' });
  await tick();
  assert.equal(disc, true);
  assert.equal(gm.connection, null);
  assert.equal(adapter.disconnected, 1);
  const restored = gmFor({ db });
  assert.deepEqual(restored.queue.tracks.map((x) => x.title), ['song1', 'song2']);
});

test('stop clears everything; pause/resume/skip report state honestly', async () => {
  const gm = gmFor();
  assert.equal(gm.skip(), false);
  await gm.enqueue(t('a'), { voiceChannelId: 'vc' });
  assert.equal(gm.pause(), true);
  assert.equal(gm.pause(), false);
  assert.equal(gm.resume(), true);
  await gm.stop();
  assert.equal(gm.queue.length, 0);
  assert.equal(gm.connection, null);
});

// ------------------------------------------------------------------ providers (MOCK HTTP)

const cfg = (music = {}) => testConfig({ music: { ...testConfig().music, providers: ['audius', 'jamendo', 'archive', 'radio', 'local'], jamendoClientId: '', localDir: path.join(tempDir(), 'none'), ...music } });

function audiusTrackJson(id, title, artist, extra = {}) {
  return { id, title, user: { name: artist }, duration: 200, permalink: `/${artist}/${id}`, play_count: 100, is_streamable: true, access: { stream: true }, is_delete: false, ...extra };
}

/** Routes MOCK HTTP responses by URL. */
function router(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push(url);
    for (const [re, body, status = 200] of routes) {
      if (re.test(url)) {
        const value = typeof body === 'function' ? body(url) : body;
        return { ok: status < 400, status, headers: { get: (h) => (h.toLowerCase() === 'content-type' ? value?.contentType ?? 'application/json' : null) }, json: async () => value, text: async () => (typeof value === 'string' ? value : JSON.stringify(value)), method: init.method };
      }
    }
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
  };
  return { fetchImpl, calls };
}

test('online search: Audius results are licensed, gated tracks skipped, best match ranked first', async () => {
  const { fetchImpl } = router([
    [/api\.audius\.co\/v1\/tracks\/search/, { data: [
      audiusTrackJson('a1', 'Lofi Rain', 'Chill Guy'),
      audiusTrackJson('a2', 'Midnight Drive', 'Neon', { is_stream_gated: true, stream_conditions: { usdc_purchase: {} } }),
      audiusTrackJson('a3', 'Midnight Drive', 'Synth Owl'),
    ] }],
    [/archive\.org\/advancedsearch/, { response: { docs: [] } }],
  ]);
  const r = await searchTracks('midnight drive', { config: cfg(), fetchImpl });
  assert.equal(r.results[0].id, 'a3', 'gated a2 never offered');
  assert.ok(!r.results.some((x) => x.id === 'a2'));
  assert.equal(r.results[0].license, 'Audius Open Music License');
  assert.match(r.results[0].input, /api\.audius\.co\/v1\/tracks\/a3\/stream\?app_name=/);
  assert.equal(r.results[0].page, 'https://audius.co/Synth Owl/a3');
  assert.deepEqual(r.failed, []);
});

test('provider outages and rate limits are reported, not hidden', async () => {
  const { fetchImpl } = router([
    [/api\.audius\.co/, {}, 503],
    [/archive\.org/, {}, 429],
  ]);
  const r = await searchTracks('anything', { config: cfg(), fetchImpl });
  assert.equal(r.results.length, 0);
  assert.deepEqual(r.failed.map((f) => [f.provider, f.code]).sort(), [['Audius', 'outage'], ['Internet Archive', 'rate_limited']]);
});

test('Audius links resolve to a track or a whole playlist', async () => {
  const { fetchImpl } = router([
    [/\/resolve\?url=.*track-x/, { data: audiusTrackJson('t1', 'Track X', 'Artist') }],
    [/\/resolve\?url=.*playlist/, { data: { id: 'pl1', playlist_name: 'Night Mix', track_count: 2 } }],
    [/\/playlists\/pl1\/tracks/, { data: [audiusTrackJson('p1', 'One', 'A'), audiusTrackJson('p2', 'Two', 'B', { is_stream_gated: true })] }],
  ]);
  const one = await resolveLink('https://audius.co/Artist/track-x', { config: cfg(), fetchImpl });
  assert.equal(one.tracks[0].title, 'Track X');
  const pl = await resolveLink('https://audius.co/A/playlist/night-mix', { config: cfg(), fetchImpl });
  assert.equal(pl.playlist, 'Night Mix');
  assert.deepEqual(pl.tracks.map((x) => x.id), ['p1'], 'gated playlist entries skipped');
});

test('YouTube/Spotify links are metadata only: their audio is never used', async () => {
  const { fetchImpl, calls } = router([
    [/youtube\.com\/oembed/, { title: 'Synth Owl - Midnight Drive (Official Video)' }],
    [/api\.audius\.co\/v1\/tracks\/search/, { data: [audiusTrackJson('a3', 'Midnight Drive', 'Synth Owl')] }],
    [/archive\.org/, { response: { docs: [] } }],
    [/open\.spotify\.com\/oembed/, { title: 'Unknown Mainstream Hit' }],
  ]);
  const yt = await resolveLink('https://www.youtube.com/watch?v=abc123', { config: cfg(), fetchImpl });
  assert.equal(yt.tracks[0].provider, 'audius');
  assert.match(yt.note, /cannot be streamed into Discord/);
  assert.ok(!calls.some((u) => /googlevideo|youtube\.com\/watch/.test(u)), 'no YouTube media requests');
  await assert.rejects(() => resolveLink('https://open.spotify.com/track/xyz', { config: cfg(), fetchImpl: router([[/open\.spotify\.com\/oembed/, { title: 'Unknown Mainstream Hit' }], [/audius/, { data: [] }], [/archive/, { response: { docs: [] } }]]).fetchImpl }), (e) => e.code === 'not_found' && /licensed source/.test(e.message));
  await assert.rejects(() => resolveLink('https://open.spotify.com/playlist/xyz', { config: cfg(), fetchImpl }), (e) => e.code === 'unsupported');
  assert.equal(cleanVideoTitle('Artist - Song (Official Music Video) [HD]'), 'Artist - Song');
});

test('direct links: admins only, https only, no private hosts (incl. DNS), playlists parsed', async () => {
  const publicLookup = async () => [{ address: '93.184.216.34' }];
  const privateLookup = async () => [{ address: '10.0.0.5' }];
  await assert.rejects(() => resolveLink('https://cdn.example.org/a.mp3', { config: cfg(), fetchImpl: router([]).fetchImpl, lookup: publicLookup }), (e) => e.code === 'restricted');
  const ok = await resolveLink('https://cdn.example.org/a.mp3', { config: cfg(), fetchImpl: router([]).fetchImpl, lookup: publicLookup, allowDirect: true });
  assert.equal(ok.tracks[0].provider, 'url');
  await assert.rejects(() => resolveLink('https://evil.example.org/a.mp3', { config: cfg(), fetchImpl: router([]).fetchImpl, lookup: privateLookup, allowDirect: true }), /private network/);
  const m3u = '#EXTM3U\n#EXTINF:1,One\nhttps://cdn.example.org/1.mp3\nrelative/2.ogg\nhttp://insecure.example.org/3.mp3\nhttps://localhost/4.mp3\n';
  const pl = await resolveLink('https://cdn.example.org/list.m3u', { config: cfg(), fetchImpl: router([[/list\.m3u/, m3u]]).fetchImpl, lookup: publicLookup, allowDirect: true });
  assert.deepEqual(pl.tracks.map((x) => x.input), ['https://cdn.example.org/1.mp3', 'https://cdn.example.org/relative/2.ogg']);
  assert.deepEqual(parsePlaylistFile('[playlist]\nFile1=https://a.example/1.mp3\nTitle1=x\n', 'https://a.example/'), ['https://a.example/1.mp3']);
  for (const bad of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://open.spotify.com/track/x', 'http://example.com/a.mp3', 'https://192.168.1.5/a.mp3', 'https://localhost/a.mp3', 'https://user:pw@example.com/a.mp3', 'https://[::1]/a.mp3']) {
    assert.equal(validateDirectUrl(bad).ok, false, bad);
  }
  await assert.rejects(() => resolveLink('not a link', { config: cfg() }), (e) => e.code === 'invalid_link');
});

test('Jamendo is optional (free client id) and the local folder is never required', async () => {
  const noJam = cfg();
  const { fetchImpl, calls } = router([[/audius/, { data: [] }], [/archive/, { response: { docs: [] } }]]);
  await searchTracks('anything', { config: noJam, fetchImpl });
  assert.ok(!calls.some((u) => /jamendo/.test(u)), 'Jamendo not called without a client id');
  const withJam = cfg({ jamendoClientId: 'abc' });
  const r2 = router([[/jamendo\.com\/v3\.0\/tracks/, { headers: { status: 'success' }, results: [{ id: 7, name: 'Open Sky', artist_name: 'CC Band', duration: 180, audio: 'https://prod.storage.jamendo.com/?trackid=7', shareurl: 'https://jamendo.com/track/7', license_ccurl: 'http://creativecommons.org/licenses/by/3.0/' }] }], [/audius/, { data: [] }], [/archive/, { response: { docs: [] } }]]);
  const r = await searchTracks('open sky', { config: withJam, fetchImpl: r2.fetchImpl });
  assert.equal(r.results[0].provider, 'jamendo');
  assert.match(r.results[0].license, /Creative Commons/);
  // Optional local library still works as a fallback when present.
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'The Weeknd - Blinding Lights.mp3'), '');
  assert.equal((await searchLocal('blinding lights', { dir }))[0].artist, 'The Weeknd');
});

test('ranking helpers', () => {
  assert.equal(matchScore('midnight drive', { title: 'Midnight Drive', artist: 'X' }), 100);
  assert.ok(matchScore('midnight drive', { title: 'Morning Walk', artist: 'X' }) < 20);
  assert.equal(describeTrack({ provider: 'audius', title: 'T', artist: 'A' }), 'T — A · Audius');
});
