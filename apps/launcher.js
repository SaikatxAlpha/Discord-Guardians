// Starts KNIGHT and AEGIS as two independent processes, restarts a crashed
// guardian with backoff, and shuts both down cleanly on Ctrl+C.
// Usage: npm start            (both)
//        npm start -- knight  (one)
import { fork } from 'node:child_process';
import path from 'node:path';
import { ROOT, loadEnv, getConfig, validateConfig } from '../config/env.js';

loadEnv();
const only = process.argv.slice(2).filter((a) => ['knight', 'aegis'].includes(a));
const bots = only.length ? only : ['knight', 'aegis'];
const { errors, warnings } = validateConfig(getConfig(), { bots });
for (const w of warnings) console.warn(`[launcher] warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[launcher] config error: ${e}`);
  console.error('[launcher] Fix .env (see .env.example) and run "npm run check:config".');
  process.exit(1);
}

const children = new Map();
let stopping = false;

function launch(bot, attempt = 0) {
  const child = fork(path.join(ROOT, 'apps', bot, 'index.js'), [], {
    cwd: ROOT,
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdio: 'inherit',
  });
  const started = Date.now();
  children.set(bot, child);
  console.log(`[launcher] ${bot.toUpperCase()} started (pid ${child.pid})`);
  child.on('exit', (code, signal) => {
    children.delete(bot);
    if (stopping) return;
    const healthyRun = Date.now() - started > 60000;
    const next = healthyRun ? 0 : attempt + 1;
    if (next > 5) {
      console.error(`[launcher] ${bot.toUpperCase()} keeps crashing (exit ${code ?? signal}); not restarting. Check data/logs/${bot}.log`);
      return;
    }
    const delay = Math.min(60000, 2000 * 2 ** next);
    console.error(`[launcher] ${bot.toUpperCase()} exited (${code ?? signal}); restarting in ${delay / 1000}s`);
    setTimeout(() => launch(bot, next), delay);
  });
}

function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[launcher] stopping guardians…');
  for (const child of children.values()) child.connected && child.send({ type: 'shutdown' });
  const deadline = setTimeout(() => {
    for (const child of children.values()) child.kill();
    process.exit(0);
  }, 12000);
  const check = setInterval(() => {
    if (children.size === 0) {
      clearInterval(check);
      clearTimeout(deadline);
      console.log('[launcher] all guardians stopped');
      process.exit(0);
    }
  }, 200);
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, shutdown);
for (const bot of bots) launch(bot);
