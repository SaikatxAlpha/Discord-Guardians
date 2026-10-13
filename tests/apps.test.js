// Construct the real KNIGHT and AEGIS applications (no Discord login) to
// verify their wiring: handlers, commands, buttons and job handlers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ACTIONS } from '../core/actions/registry.js';
import { ROOT } from '../config/env.js';
import { tempDir } from './helpers.js';

const FAKE = (id) => `${Buffer.from(id).toString('base64')}.GAbcde.${'y'.repeat(30)}`;

async function withEnv(fn) {
  const dir = tempDir();
  const saved = { ...process.env };
  Object.assign(process.env, {
    OWNER_ID: '123456789012345678',
    KNIGHT_TOKEN: FAKE('223456789012345678'),
    AEGIS_TOKEN: FAKE('323456789012345678'),
    DB_PATH: path.join(dir, 'apps.db'),
    LOG_DIR: path.join(dir, 'logs'),
    AI_PROVIDER: 'none',
    STT_PROVIDER: 'none',
  });
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

function dispose(app) {
  for (const t of app.timers) clearInterval(t);
  app.client.destroy();
  app.db.close();
}

test('KNIGHT and AEGIS construct with independent identities and full wiring', async () => {
  await withEnv(async () => {
    const { createKnight } = await import('../apps/knight/index.js');
    const { createAegis } = await import('../apps/aegis/index.js');
    const knight = createKnight();
    const aegis = createAegis();
    try {
      assert.equal(knight.config.knight.clientId, '223456789012345678');
      assert.equal(aegis.config.aegis.clientId, '323456789012345678');
      assert.notEqual(knight.workerId, aegis.workerId);
      assert.equal(knight.theme.name, 'KNIGHT');
      assert.equal(aegis.theme.name, 'AEGIS');
      for (const [name, def] of Object.entries(ACTIONS)) {
        const owner = def.bot === 'any' ? [knight, aegis] : def.bot === 'knight' ? [knight] : [aegis];
        for (const app of owner) assert.ok(app.handlers.has(name), `${app.name} missing ${name}`);
      }
      assert.ok(knight.commands.has('ban') && !knight.commands.has('play'));
      assert.ok(aegis.commands.has('play') && aegis.commands.has('alpha') && !aegis.commands.has('ban'));
      for (const b of ['alpha:approve', 'alpha:reject']) assert.ok(knight.buttons.has(b) && aegis.buttons.has(b));
      assert.ok(aegis.buttons.has('event:join') && aegis.buttons.has('music:pick'));
      for (const j of ['message.send', 'reminder', 'research.daily', 'report.activity', 'event.reminder', 'event.finalize', 'system.backup']) {
        assert.ok(aegis.jobHandlers[j], `AEGIS job ${j}`);
      }
      assert.equal(aegis.stt.name, 'none', 'no STT key → voice transcription honestly disabled');
    } finally {
      dispose(knight);
      dispose(aegis);
    }
  });
});

test('launcher refuses to start with missing configuration (clear message, non-zero exit)', async () => {
  const run = promisify(execFile);
  const env = { ...process.env, SOUL_SOCIETY_NO_DOTENV: '1', OWNER_ID: '', KNIGHT_TOKEN: '', AEGIS_TOKEN: '', DB_PATH: path.join(tempDir(), 'x.db') };
  await assert.rejects(
    run(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(ROOT, 'apps', 'launcher.js')], { env, cwd: tempDir() }),
    (err) => err.code === 1 && /KNIGHT_TOKEN is not set/.test(err.stderr) && /AEGIS_TOKEN is not set/.test(err.stderr) && /OWNER_ID \(bot operator\) is not set/.test(err.stderr),
  );
});

test('a new server initialises its own settings and gets each setup guide once (no hard-coded IDs)', async () => {
  const { buildMockGuild } = await import('./mocks/discord.js');
  const { getGuildSettings } = await import('../core/settings.js');
  await withEnv(async () => {
    const { createKnight } = await import('../apps/knight/index.js');
    const { createAegis } = await import('../apps/aegis/index.js');
    const knight = createKnight();
    const aegis = createAegis();
    try {
      const a = buildMockGuild();
      const b = buildMockGuild();
      for (const app of [knight, aegis]) {
        await app.initGuild(a.guild);
        await app.initGuild(a.guild); // restart / duplicate event
        await app.initGuild(b.guild);
      }
      const posted = (env) => [...env.guild.channels.cache.values()].flatMap((c) => c.messages ?? []);
      assert.equal(posted(a).length, 2, 'one KNIGHT guide + one AEGIS guide');
      assert.equal(posted(b).length, 2);
      const titles = posted(a).map((m) => m.embeds[0].data.title).sort();
      assert.deepEqual(titles, ['🛡️ AEGIS has arrived', '⚔️ KNIGHT has arrived'].sort());
      const sa = getGuildSettings(knight.db, a.guild.id);
      assert.equal(sa.moderation.simulate, true, 'safe default: simulation mode');
      assert.ok(sa.meta.knightIntroAt && sa.meta.aegisIntroAt);
      assert.equal(knight.db.get('SELECT COUNT(*) AS n FROM guild_settings').n, 2, 'one row per server, keyed by guild id');
      // A server configured before this feature existed is not spammed with guides.
      const legacy = buildMockGuild();
      knight.db.run(`INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, '{"channels":{}}', ?)`, legacy.guild.id, Date.now());
      await knight.initGuild(legacy.guild);
      await aegis.initGuild(legacy.guild);
      assert.equal(posted(legacy).length, 0);
      assert.ok(getGuildSettings(knight.db, legacy.guild.id).meta.aegisIntroAt);
    } finally {
      dispose(knight);
      dispose(aegis);
    }
  });
});

test('production source contains no hard-coded Discord IDs', async () => {
  const fs = await import('node:fs');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  for (const d of ['apps', 'core', 'features', 'ai', 'config', 'database']) walk(path.join(ROOT, d));
  const offenders = files.filter((f) => /\b\d{17,20}\b/.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
