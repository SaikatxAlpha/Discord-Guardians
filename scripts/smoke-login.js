// Login smoke test: builds KNIGHT and AEGIS with the current code, connects
// each to Discord, waits for READY, reports, and disconnects.
// It detaches every event handler first and uses a throw-away database copy,
// so it never acts in any server and is safe to run while the real bots are
// online elsewhere.
// Usage: npm run smoke:login
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Events } from 'discord.js';
import { generateDependencyReport } from '@discordjs/voice';
import { loadEnv } from '../config/env.js';

loadEnv();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-smoke-'));
process.env.DB_PATH = path.join(tmp, 'smoke.db');
process.env.LOG_DIR = path.join(tmp, 'logs');
process.env.LOG_LEVEL = 'warn';

const { createKnight } = await import('../apps/knight/index.js');
const { createAegis } = await import('../apps/aegis/index.js');

let failed = false;
for (const [name, create] of [['KNIGHT', createKnight], ['AEGIS', createAegis]]) {
  const started = Date.now();
  let app;
  try {
    app = create();
    const wiring = `${app.handlers.size} actions, ${app.commands.size} commands, STT ${app.stt.name}, AI ${app.ai.name}`;
    app.client.removeAllListeners(); // no handlers: this session cannot react to anything
    const ready = new Promise((resolve, reject) => {
      app.client.once(Events.ClientReady, resolve);
      app.client.once(Events.Error, reject);
      setTimeout(() => reject(new Error('timed out waiting for READY')), 30000);
    });
    await app.client.login(app.config[app.name].token);
    const c = await ready;
    console.log(`PASS ${name}: logged in as ${c.user.tag} in ${Date.now() - started} ms · ${c.guilds.cache.size} server(s) · ws ping ${c.ws.ping} ms · ${wiring}`);
  } catch (err) {
    failed = true;
    console.log(`FAIL ${name}: ${err.code ?? ''} ${err.message}`);
  } finally {
    for (const t of app?.timers ?? []) clearInterval(t);
    await app?.client.destroy().catch(() => null);
    app?.db.close();
  }
}
const report = generateDependencyReport();
console.log(`Voice dependencies: opus ${/opusscript: \d/.test(report) ? 'ok' : 'missing'} · DAVE ${/@snazzah\/davey: \d/.test(report) ? 'ok' : 'missing'} · ffmpeg ${/FFmpeg\n- version: \S+/.test(report) ? 'ok' : 'missing'}`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
