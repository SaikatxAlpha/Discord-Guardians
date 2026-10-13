// Production readiness check. Never prints secret values.
// Usage: npm run check:production              (offline checks)
//        npm run check:production -- --live    (also calls Discord, Groq and Audius)
// Run it on the host/container that will run the bots, with the production
// environment loaded (e.g. `docker compose run --rm guardians npm run check:production -- --live`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadEnv, getConfig, validateConfig, ROOT } from '../config/env.js';
import { openDatabase } from '../database/db.js';
import { MIGRATIONS } from '../database/migrations.js';
import { ffmpegPath } from '../features/welcome/renderer.js';

loadEnv();
const cfg = getConfig();
const live = process.argv.includes('--live');
const results = [];
const add = (level, name, detail) => results.push({ level, name, detail });

// ---- configuration
const { errors, warnings } = validateConfig(cfg, { bots: ['knight', 'aegis'] });
for (const e of errors) add('FAIL', 'config', e);
for (const w of warnings) add('WARN', 'config', w);
if (!cfg.production) add('WARN', 'APP_ENV', 'APP_ENV is not "production" (development defaults are active).');
else add('PASS', 'APP_ENV', 'production');
add(cfg.commandScope === 'global' ? 'PASS' : 'WARN', 'COMMAND_SCOPE', cfg.commandScope === 'global' ? 'global — commands work in every server' : `guild — commands only appear in DEV_GUILD_ID`);
if (cfg.operatorGlobalAccess) add('WARN', 'OPERATOR_GLOBAL_ACCESS', 'enabled: the operator can use ALPHA in every server the bots are in.');

// ---- runtime
const [major, minor] = process.versions.node.split('.').map(Number);
add(major > 22 || (major === 22 && minor >= 13) ? 'PASS' : 'FAIL', 'Node.js', `v${process.versions.node} (need ≥ 22.13 for built-in SQLite)`);
const ff = ffmpegPath();
add(ff ? 'PASS' : 'FAIL', 'ffmpeg', ff ? 'found' : 'missing — music and MP4 cards will not work');
for (const f of ['Cinzel-Black.ttf', 'Rajdhani-Bold.ttf', 'NotoSansEgyptianHieroglyphs-Regular.ttf', 'NotoSansMath-Regular.ttf']) {
  if (!fs.existsSync(path.join(ROOT, 'assets', 'fonts', f))) add('WARN', 'fonts', `${f} missing`);
}
add('PASS', 'memory', `${Math.round(os.totalmem() / 1048576)} MB total, ${Math.round(os.freemem() / 1048576)} MB free (both bots need ≈ 300–600 MB)`);

// ---- storage
try {
  fs.mkdirSync(cfg.dataDir, { recursive: true });
  const probe = path.join(cfg.dataDir, `.write-test-${process.pid}`);
  fs.writeFileSync(probe, 'ok');
  fs.rmSync(probe);
  add('PASS', 'DATA_DIR', `${cfg.dataDir} is writable`);
} catch (err) {
  add('FAIL', 'DATA_DIR', `${cfg.dataDir} is not writable (${err.code})`);
}
try {
  const db = openDatabase(cfg.dbPath);
  const v = db.get('SELECT MAX(version) AS v FROM schema_migrations').v;
  db.close();
  add(v === MIGRATIONS.at(-1).version ? 'PASS' : 'FAIL', 'database', `schema v${v} at ${cfg.dbPath}`);
} catch (err) {
  add('FAIL', 'database', `cannot open ${cfg.dbPath}: ${err.message}`);
}
try {
  const df = fs.statfsSync(cfg.dataDir);
  const freeMb = Math.round((df.bavail * df.bsize) / 1048576);
  add(freeMb > 500 ? 'PASS' : 'WARN', 'disk', `${freeMb} MB free for data`);
} catch {
  /* statfs unsupported */
}

// ---- secrets hygiene
if (fs.existsSync(path.join(ROOT, '.git'))) {
  try {
    const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n');
    const leaked = tracked.filter((f) => /(^|\/)\.env(\.production)?$/.test(f) || /^data\//.test(f));
    add(leaked.length ? 'FAIL' : 'PASS', 'git', leaked.length ? `secrets/runtime files tracked by Git: ${leaked.join(', ')}` : '.env and data/ are not tracked');
  } catch {
    add('WARN', 'git', 'could not run git');
  }
}

// ---- live checks
if (live) {
  const t = (ms) => AbortSignal.timeout(ms);
  for (const bot of ['knight', 'aegis']) {
    if (!cfg[bot].token) continue;
    try {
      const r = await fetch('https://discord.com/api/v10/applications/@me', { headers: { Authorization: `Bot ${cfg[bot].token}` }, signal: t(10000) });
      if (!r.ok) throw new Error(r.status === 401 ? 'token rejected' : `HTTP ${r.status}`);
      const app = await r.json();
      const g = await fetch('https://discord.com/api/v10/users/@me/guilds', { headers: { Authorization: `Bot ${cfg[bot].token}` }, signal: t(10000) });
      const guildCount = g.ok ? (await g.json()).length : '?';
      const has = (a, b) => (app.flags & a) !== 0 || (app.flags & b) !== 0;
      const intents = has(1 << 14, 1 << 15) && has(1 << 18, 1 << 19);
      add(intents ? 'PASS' : 'FAIL', `Discord ${bot.toUpperCase()}`, intents ? `token valid (${app.name}); Members + Message Content intents enabled; in ${guildCount} server(s)` : 'token valid but Server Members / Message Content intent is disabled');
    } catch (err) {
      add('FAIL', `Discord ${bot.toUpperCase()}`, err.message);
    }
  }
  if (cfg.stt.apiKey) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${cfg.stt.apiKey}` }, signal: t(10000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const ids = (await r.json()).data.map((m) => m.id);
      add(ids.includes(cfg.stt.model) ? 'PASS' : 'FAIL', 'Groq', ids.includes(cfg.stt.model) ? `key valid; ${cfg.stt.model} available` : `key valid but ${cfg.stt.model} not listed`);
    } catch (err) {
      add('FAIL', 'Groq', err.message);
    }
  }
  try {
    const r = await fetch(`https://api.audius.co/v1/tracks/trending?limit=1&app_name=${encodeURIComponent(cfg.music.audiusAppName)}`, { signal: t(10000) });
    add(r.ok ? 'PASS' : 'WARN', 'Audius', r.ok ? 'reachable' : `HTTP ${r.status}`);
  } catch (err) {
    add('WARN', 'Audius', `unreachable (${err.name})`);
  }
}

const icon = { PASS: '✔', WARN: '!', FAIL: '✖' };
for (const r of results) console.log(`${icon[r.level]} ${r.level.padEnd(4)} ${r.name.padEnd(22)} ${r.detail}`);
const fails = results.filter((r) => r.level === 'FAIL').length;
console.log(fails ? `\n${fails} blocking problem(s). Not ready for production.` : `\nReady${live ? '' : ' (run with --live to verify tokens and providers)'}.`);
process.exit(fails ? 1 : 0);
