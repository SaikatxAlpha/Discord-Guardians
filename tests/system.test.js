import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { ACTIONS } from '../core/actions/registry.js';
import { knightHandlers } from '../features/moderation/handlers.js';
import { aegisHandlers } from '../apps/aegis/handlers.js';
import { systemHandlers } from '../apps/shared/systemHandlers.js';
import { commandPayloads } from '../apps/register-commands.js';
import { getConfig, validateConfig, clientIdFromToken, ROOT } from '../config/env.js';
import { openDatabase } from '../database/db.js';
import { redact } from '../core/logger.js';
import { tempDir } from './helpers.js';

const FAKE_TOKEN = `MTIzNDU2Nzg5MDEyMzQ1Njc4.GAbcde.${'x'.repeat(30)}`;

test('every structured action has an implementation in the bot that owns it', () => {
  const sys = Object.keys(systemHandlers({}));
  const knight = new Set([...Object.keys(knightHandlers), ...sys]);
  const aegis = new Set([...Object.keys(aegisHandlers()), ...sys]);
  for (const [name, def] of Object.entries(ACTIONS)) {
    if (def.bot === 'knight' || def.bot === 'any') assert.ok(knight.has(name), `KNIGHT lacks ${name}`);
    if (def.bot === 'aegis' || def.bot === 'any') assert.ok(aegis.has(name), `AEGIS lacks ${name}`);
  }
});

test('slash command definitions are valid, unique and within Discord limits', () => {
  const p = commandPayloads();
  for (const bot of ['knight', 'aegis']) {
    const names = p[bot].map((c) => c.name);
    assert.equal(new Set(names).size, names.length, `${bot} duplicate names`);
    assert.ok(names.length <= 100);
    for (const c of p[bot]) assert.ok(JSON.stringify(c).length < 8000, `/${c.name} too large`);
  }
  const both = p.knight.map((c) => c.name).filter((n) => p.aegis.some((a) => a.name === n));
  assert.deepEqual(both, [], 'KNIGHT and AEGIS commands do not collide');
  for (const required of ['play', 'queue', 'skip', 'pause', 'resume', 'stop', 'nowplaying', 'balance', 'daily', 'rank', 'leaderboard', 'quests', 'shop', 'inventory']) {
    assert.ok(p.aegis.some((c) => c.name === required), `/${required} missing`);
  }
});

test('configuration validation never echoes secrets', () => {
  const cfg = getConfig({ OWNER_ID: 'abc', KNIGHT_TOKEN: 'not-a-token', AEGIS_TOKEN: 'not-a-token', AI_PROVIDER: 'groq' });
  const { errors } = validateConfig(cfg, { bots: ['knight', 'aegis'] });
  assert.ok(errors.length >= 4);
  assert.ok(errors.every((e) => !e.includes('not-a-token')));
  assert.equal(clientIdFromToken(FAKE_TOKEN), '123456789012345678');
  assert.ok(validateConfig(getConfig({ OWNER_ID: '123456789012345678', KNIGHT_TOKEN: FAKE_TOKEN }), { bots: ['knight'] }).errors.length === 0);
  assert.equal(redact(`token ${FAKE_TOKEN} and gsk_${'a'.repeat(30)}`), 'token [REDACTED] and [REDACTED]');
});

test('.gitignore excludes secrets and runtime data', () => {
  const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  for (const p of ['.env', 'data/', 'node_modules/']) assert.ok(gi.split(/\r?\n/).includes(p), `${p} not ignored`);
});

test('a guardian process shuts down cleanly: leases released, heartbeat stopped, no token in logs', async () => {
  const dir = tempDir();
  const env = { ...process.env, OWNER_ID: '123456789012345678', KNIGHT_TOKEN: FAKE_TOKEN, DB_PATH: path.join(dir, 'x.db'), LOG_DIR: path.join(dir, 'logs'), AI_PROVIDER: 'none', STT_PROVIDER: 'none' };
  const child = fork(path.join(ROOT, 'tests', 'fixtures', 'shutdown-child.js'), [], { env, execArgv: ['--disable-warning=ExperimentalWarning'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  await new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('exit', (c) => reject(new Error(`child exited early ${c}`)));
    setTimeout(() => reject(new Error('child did not become ready')), 20000);
  });
  const code = await new Promise((resolve) => {
    child.once('exit', resolve);
    child.send({ type: 'shutdown' });
  });
  assert.equal(code, 0);
  const db = openDatabase(env.DB_PATH);
  assert.equal(db.get(`SELECT status FROM heartbeats WHERE bot = 'knight'`).status, 'stopped');
  assert.equal(db.get(`SELECT status FROM tasks WHERE id = 'held'`).status, 'pending', 'lease released for another worker');
  db.close();
  const log = fs.readFileSync(path.join(dir, 'logs', 'knight.log'), 'utf8');
  assert.ok(log.includes('shutdown complete'));
  assert.ok(!log.includes(FAKE_TOKEN), 'token never written to logs');
  assert.ok(log.includes('[REDACTED]'));
});
