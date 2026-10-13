import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { MusicQueue } from '../features/music/queue.js';
import { GuildMusic, MusicManager } from '../features/music/manager.js';
import { searchTracks, validateDirectUrl, searchLocal } from '../features/music/providers.js';
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
    async connect() {
      a.connects++;
      const c = new EventEmitter();
      c.state = { status: 'ready' };
      a.conns.push(c);
      return c;
    },
    createPlayer() {
      const p = new FakePlayer();
      a.players.push(p);
      return p;
    },
    async createResource(track) {
      if (failResource.has(track.title)) throw new Error(`cannot open ${track.title}`);
      return { track };
    },
    waitReconnect: async () => reconnect,
    subscribe() {},
    disconnect() {
      a.disconnected++;
    },
  };
  return a;
}

const t = (title) => ({ source: 'local', title, input: `${title}.mp3` });
const tick = () => new Promise((r) => setTimeout(r, 10));

test('queue operations: add, remove, move, bounds', () => {
  const q = new MusicQueue();
  ['a', 'b', 'c'].forEach((x) => q.add(t(x)));
  assert.equal(q.move(3, 1).title, 'c');
  assert.deepEqual(q.tracks.map((x) => x.title), ['c', 'a', 'b']);
  assert.equal(q.remove(2).title, 'a');
  assert.throws(() => q.remove(9), /between 1 and 2/);
  assert.equal(q.next().title, 'c');
});

test('playback advances, skips failed tracks, and halts after repeated failures', async () => {
  const db = memDb();
  const adapter = fakeAdapter({ failResource: new Set(['bad1']) });
  const gm = new GuildMusic({ guildId: 'g', db, adapter, logger: memoryLogger() });
  const errors = [];
  gm.on('trackError', (tr) => errors.push(tr.title));
  await gm.enqueue(t('one'), { voiceChannelId: 'vc' });
  await gm.enqueue(t('bad1'), { voiceChannelId: 'vc' });
  await gm.enqueue(t('two'), { voiceChannelId: 'vc' });
  const p = adapter.players[0];
  assert.deepEqual(p.played, ['one']);
  p.set('idle'); // track finished
  await tick();
  assert.deepEqual(p.played, ['one', 'two'], 'bad1 skipped');
  assert.deepEqual(errors, ['bad1']);
  // Runtime stream errors: three in a row halt playback.
  const gm2 = new GuildMusic({ guildId: 'g2', db, adapter: fakeAdapter(), logger: memoryLogger() });
  let halted = false;
  gm2.on('halted', () => (halted = true));
  for (const x of ['x1', 'x2', 'x3', 'x4']) await gm2.enqueue(t(x), { voiceChannelId: 'vc' });
  for (let i = 0; i < 3; i++) {
    gm2.player.fail(new Error('stream died'));
    await tick();
  }
  assert.equal(halted, true);
  assert.equal(gm2.queue.length, 0);
});

test('no queue races: concurrent requests start exactly one track and keep order', async () => {
  const adapter = fakeAdapter();
  const gm = new GuildMusic({ guildId: 'g', db: memDb(), adapter, logger: memoryLogger() });
  const res = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((x) => gm.enqueue(t(x), { voiceChannelId: 'vc' })));
  assert.equal(adapter.players.length, 1, 'single player');
  assert.equal(adapter.connects, 1, 'single connection');
  assert.deepEqual(adapter.players[0].played, ['a']);
  assert.deepEqual(res.map((r) => r.position), [0, 1, 2, 3, 4]);
});

test('one manager instance per guild (no duplicate players)', () => {
  const m = new MusicManager({ db: memDb(), logger: memoryLogger(), adapterFor: () => fakeAdapter() });
  assert.equal(m.get({ id: 'g' }), m.get({ id: 'g' }));
  assert.notEqual(m.get({ id: 'g' }), m.get({ id: 'h' }));
});

test('voice disconnect without recovery cleans up and persists the queue (incl. interrupted track)', async () => {
  const db = memDb();
  const adapter = fakeAdapter({ reconnect: false });
  const gm = new GuildMusic({ guildId: 'g', db, adapter, logger: memoryLogger() });
  await gm.enqueue(t('song1'), { voiceChannelId: 'vc', textChannelId: 'tc' });
  await gm.enqueue(t('song2'), { voiceChannelId: 'vc' });
  let disc = false;
  gm.on('disconnected', () => (disc = true));
  adapter.conns[0].emit('stateChange', { status: 'ready' }, { status: 'disconnected' });
  await tick();
  assert.equal(disc, true);
  assert.equal(gm.connection, null);
  assert.equal(adapter.disconnected, 1);
  const restored = new GuildMusic({ guildId: 'g', db, adapter: fakeAdapter(), logger: memoryLogger() });
  assert.deepEqual(restored.queue.tracks.map((x) => x.title), ['song1', 'song2']);
});

test('stop clears everything; pause/resume/skip report state honestly', async () => {
  const adapter = fakeAdapter();
  const gm = new GuildMusic({ guildId: 'g', db: memDb(), adapter, logger: memoryLogger() });
  assert.equal(gm.skip(), false);
  await gm.enqueue(t('a'), { voiceChannelId: 'vc' });
  assert.equal(gm.pause(), true);
  assert.equal(gm.pause(), false);
  assert.equal(gm.resume(), true);
  await gm.stop();
  assert.equal(gm.queue.length, 0);
  assert.equal(gm.connection, null);
});

test('lawful sources only: YouTube/Spotify/private URLs refused; local library search by title and artist', async () => {
  assert.equal(validateDirectUrl('https://www.youtube.com/watch?v=x').ok, false);
  assert.equal(validateDirectUrl('https://youtu.be/x').ok, false);
  assert.equal(validateDirectUrl('https://open.spotify.com/track/x').ok, false);
  assert.equal(validateDirectUrl('http://example.com/a.mp3').ok, false);
  assert.equal(validateDirectUrl('https://192.168.1.5/a.mp3').ok, false);
  assert.equal(validateDirectUrl('https://localhost/a.mp3').ok, false);
  assert.equal(validateDirectUrl('https://cdn.example.org/a.mp3').ok, true);
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, 'pop'));
  fs.writeFileSync(path.join(dir, 'pop', 'The Weeknd - Blinding Lights.mp3'), '');
  fs.writeFileSync(path.join(dir, 'Daft Punk - One More Time.flac'), '');
  fs.writeFileSync(path.join(dir, 'notes.txt'), '');
  const r = await searchLocal('blinding lights', { dir });
  assert.equal(r[0].title, 'Blinding Lights');
  assert.equal(r[0].artist, 'The Weeknd');
  const byArtist = await searchLocal('daft punk one more time', { dir });
  assert.equal(byArtist[0].title, 'One More Time');
  // Combined search with sources stubbed (no network): archive returns only licensed items.
  const config = testConfig({ music: { localDir: dir, enableArchive: true, enableRadio: false } });
  const fetchImpl = async () => ({ ok: true, json: async () => ({ response: { docs: [
    { identifier: 'pd1', title: 'Blinding Lights (cover)', creator: 'Someone', licenseurl: 'https://creativecommons.org/licenses/by/4.0/' },
    { identifier: 'nolicense', title: 'Blinding Lights', creator: 'Uploader' },
  ] } }) });
  const s = await searchTracks('Blinding Lights', { config, fetchImpl });
  assert.equal(s.results[0].source, 'local', 'owner library preferred');
  assert.ok(!s.results.some((x) => x.identifier === 'nolicense'), 'unlicensed archive items are excluded');
});
