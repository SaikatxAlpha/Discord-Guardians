// Container / host health check. Exit 0 when every expected guardian has a
// fresh "online" heartbeat in the shared database, 1 otherwise.
// Used by the Docker HEALTHCHECK and by the launcher's optional HTTP /health.
// Usage: node scripts/healthcheck.js [knight] [aegis]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { getConfig } from '../config/env.js';

export function checkHealth({ dbPath, bots = ['knight', 'aegis'], maxAgeMs = 90000, now = Date.now() }) {
  if (!fs.existsSync(dbPath)) return { ok: false, reason: 'database not created yet', bots: [] };
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare('SELECT bot, status, last_seen FROM heartbeats').all();
    const report = bots.map((bot) => {
      const r = rows.find((x) => x.bot === bot);
      const age = r ? now - r.last_seen : null;
      return { bot, status: r?.status ?? 'missing', ageSeconds: age == null ? null : Math.round(age / 1000), healthy: Boolean(r && r.status === 'online' && age < maxAgeMs) };
    });
    const unhealthy = report.filter((b) => !b.healthy);
    return { ok: unhealthy.length === 0, reason: unhealthy.map((b) => `${b.bot}: ${b.status}${b.ageSeconds != null ? ` (${b.ageSeconds}s ago)` : ''}`).join(', ') || 'all guardians online', bots: report };
  } catch (err) {
    return { ok: false, reason: `database unreadable: ${err.code ?? err.message}`, bots: [] };
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bots = process.argv.slice(2).filter((b) => ['knight', 'aegis'].includes(b));
  const r = checkHealth({ dbPath: getConfig().dbPath, bots: bots.length ? bots : undefined });
  console.log(JSON.stringify(r));
  process.exit(r.ok ? 0 : 1);
}
