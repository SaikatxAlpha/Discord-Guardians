// Runs KNIGHT and AEGIS inside ONE Node.js process — for small hosts
// (e.g. 256 MB free tiers) where the launcher's separate processes would use
// too much memory. Trade-off: if one guardian crashes the process, both
// restart together (the host's restart policy takes care of that).
// Usage: npm run start:single
import { loadEnv, getConfig, validateConfig } from '../config/env.js';

loadEnv();
const config = getConfig();
const { errors, warnings } = validateConfig(config, { bots: ['knight', 'aegis'] });
for (const w of warnings) console.warn(`[single] warning: ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`[single] config error: ${e}`);
  console.error('[single] Fix .env (see .env.example) and run "npm run check:config".');
  process.exit(1);
}

const { createKnight } = await import('./knight/index.js');
const { createAegis } = await import('./aegis/index.js');
const apps = [createKnight(), createAegis()];

let stopping = false;
async function shutdown(code) {
  if (stopping) return;
  stopping = true;
  console.log('[single] stopping guardians…');
  setTimeout(() => process.exit(code || 1), 12000).unref();
  await Promise.allSettled(apps.map((a) => a.shutdown(code)));
  process.exit(code);
}

process.on('unhandledRejection', (err) => {
  for (const a of apps) a.logger.error('unhandled rejection', { err });
});
process.on('uncaughtException', (err) => {
  for (const a of apps) a.logger.error('uncaught exception — exiting for restart', { err });
  shutdown(1);
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => shutdown(0));

const started = await Promise.allSettled(apps.map((a) => a.start({ manageProcess: false })));
started.forEach((r, i) => r.status === 'rejected' && console.error(`[single] ${apps[i].name.toUpperCase()} failed to start: ${r.reason?.message}`));
if (started.every((r) => r.status === 'rejected')) process.exit(1);

// Optional HTTP health endpoint for hosts that probe a port (HEALTH_PORT).
if (config.healthPort) {
  const { createServer } = await import('node:http');
  const { checkHealth } = await import('../scripts/healthcheck.js');
  createServer((req, res) => {
    if (req.url !== '/health' && req.url !== '/') {
      res.writeHead(404).end();
      return;
    }
    const r = checkHealth({ dbPath: config.dbPath, bots: ['knight', 'aegis'] });
    res.writeHead(r.ok ? 200 : 503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: r.ok, bots: r.bots.map((b) => ({ bot: b.bot, status: b.status, healthy: b.healthy })) }));
  }).listen(config.healthPort, () => console.log(`[single] health endpoint on :${config.healthPort}/health`));
}
