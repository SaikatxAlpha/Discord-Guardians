// Health checks and heartbeats shared by both processes.
import fs from 'node:fs';
import path from 'node:path';

export function heartbeat(db, bot, { status = 'online', info = {}, startedAt } = {}) {
  db.run(
    `INSERT INTO heartbeats (bot, pid, started_at, last_seen, status, info) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(bot) DO UPDATE SET pid = excluded.pid, started_at = COALESCE(excluded.started_at, heartbeats.started_at),
       last_seen = excluded.last_seen, status = excluded.status, info = excluded.info`,
    bot,
    process.pid,
    startedAt ?? null,
    Date.now(),
    status,
    JSON.stringify(info),
  );
}

export function healthReport(db, { ai, stt, now = Date.now() } = {}) {
  const bots = db.all('SELECT * FROM heartbeats').map((h) => ({
    bot: h.bot,
    status: h.status === 'stopped' ? 'stopped' : now - h.last_seen < 60000 ? h.status : 'unresponsive',
    lastSeenSecondsAgo: Math.round((now - h.last_seen) / 1000),
    pid: h.pid,
    info: JSON.parse(h.info || '{}'),
  }));
  const q = (sql, ...p) => db.get(sql, ...p);
  return {
    ok: bots.every((b) => b.status !== 'unresponsive'),
    bots,
    database: { ok: q('SELECT 1 AS ok').ok === 1, schema: q('SELECT MAX(version) AS v FROM schema_migrations').v },
    queue: {
      pending: q(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'pending'`).n,
      claimed: q(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'claimed'`).n,
      failed24h: q(`SELECT COUNT(*) AS n FROM tasks WHERE status = 'failed' AND updated_at > ?`, now - 86400000).n,
    },
    approvalsPending: q(`SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending' AND expires_at > ?`, now).n,
    jobs: {
      active: q(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'active'`).n,
      overdue: q(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'active' AND next_run_at < ?`, now - 120000).n,
      failing: q(`SELECT COUNT(*) AS n FROM jobs WHERE status = 'active' AND failures > 0`).n,
    },
    ai: ai?.status?.() ?? { provider: 'none' },
    stt: stt?.status?.() ?? { provider: 'none' },
    memoryMb: Math.round(process.memoryUsage().rss / 1048576),
  };
}

export function runBackup(db, dir, keep = 7, now = new Date()) {
  const stamp = now.toISOString().replace(/[:T]/g, '-').slice(0, 16);
  const file = path.join(dir, `soul-society-${stamp}.db`);
  db.backupTo(file);
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^soul-society-.*\.db$/.test(f))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return file;
}
