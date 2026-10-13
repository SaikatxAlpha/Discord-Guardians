// SQLite-backed task queue: the local IPC channel between the KNIGHT and
// AEGIS processes. Claiming is atomic under the database write lock, every
// task carries an idempotency key, and a crashed worker's lease expires.
import crypto from 'node:crypto';

const parse = (row) =>
  row && {
    ...row,
    params: JSON.parse(row.params),
    context: JSON.parse(row.context),
    result: row.result ? JSON.parse(row.result) : null,
  };

export function enqueueTask(db, { targetBot, action, params, context = {}, guildId = null, requestedBy = null, source = null, idempotencyKey = null, maxAttempts = 1, notBefore = 0 }) {
  const now = Date.now();
  return db.transaction(() => {
    if (idempotencyKey) {
      const existing = db.get('SELECT * FROM tasks WHERE idempotency_key = ?', idempotencyKey);
      if (existing) return { ...parse(existing), duplicate: true };
    }
    const id = crypto.randomUUID();
    db.run(
      `INSERT INTO tasks (id, idempotency_key, guild_id, target_bot, action, params, context, requested_by, source,
         status, attempts, max_attempts, not_before, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
      id,
      idempotencyKey,
      guildId,
      targetBot,
      action,
      JSON.stringify(params),
      JSON.stringify(context),
      requestedBy,
      source,
      maxAttempts,
      notBefore,
      now,
      now,
    );
    return { ...parse(db.get('SELECT * FROM tasks WHERE id = ?', id)), duplicate: false };
  });
}

/** Atomically claim the oldest runnable task for `bot`. */
export function claimTask(db, bot, workerId, { leaseMs = 60000, now = Date.now() } = {}) {
  return db.transaction(() => {
    const row = db.get(
      `SELECT id FROM tasks WHERE target_bot = ? AND status = 'pending' AND not_before <= ?
       ORDER BY created_at LIMIT 1`,
      bot,
      now,
    );
    if (!row) return null;
    const res = db.run(
      `UPDATE tasks SET status = 'claimed', lease_owner = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
      workerId,
      now + leaseMs,
      now,
      row.id,
    );
    if (res.changes !== 1) return null;
    return parse(db.get('SELECT * FROM tasks WHERE id = ?', row.id));
  });
}

export function completeTask(db, id, workerId, result) {
  const res = db.run(
    `UPDATE tasks SET status = 'done', result = ?, lease_owner = NULL, lease_until = NULL, updated_at = ?
     WHERE id = ? AND status = 'claimed' AND lease_owner = ?`,
    JSON.stringify(result ?? null),
    Date.now(),
    id,
    workerId,
  );
  return res.changes === 1;
}

export function failTask(db, id, workerId, error, { retryDelayMs = 5000 } = {}) {
  const now = Date.now();
  return db.transaction(() => {
    const t = db.get('SELECT attempts, max_attempts FROM tasks WHERE id = ? AND lease_owner = ?', id, workerId);
    if (!t) return false;
    const retry = t.attempts < t.max_attempts;
    db.run(
      `UPDATE tasks SET status = ?, error = ?, lease_owner = NULL, lease_until = NULL, not_before = ?, updated_at = ? WHERE id = ?`,
      retry ? 'pending' : 'failed',
      String(error).slice(0, 2000),
      retry ? now + retryDelayMs : 0,
      now,
      id,
    );
    return true;
  });
}

/**
 * Recover tasks whose worker died mid-execution. Retryable tasks go back to
 * pending; non-retryable ones are failed rather than risk running twice.
 */
export function reapExpiredTasks(db, now = Date.now()) {
  return db.transaction(() => {
    const expired = db.all(`SELECT id, attempts, max_attempts FROM tasks WHERE status = 'claimed' AND lease_until < ?`, now);
    for (const t of expired) {
      const retry = t.attempts < t.max_attempts;
      db.run(
        `UPDATE tasks SET status = ?, error = COALESCE(error, 'worker lease expired'), lease_owner = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
        retry ? 'pending' : 'failed',
        now,
        t.id,
      );
    }
    return expired.length;
  });
}

export function getTask(db, id) {
  return parse(db.get('SELECT * FROM tasks WHERE id = ?', id));
}

/** Poll until a task finishes or the timeout passes. */
export async function waitForTask(db, id, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = getTask(db, id);
    if (t && (t.status === 'done' || t.status === 'failed')) return t;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return getTask(db, id);
}

/** Release this worker's leases on shutdown so the work is not stuck. */
export function releaseWorkerLeases(db, workerId) {
  db.run(`UPDATE tasks SET status = 'pending', lease_owner = NULL, lease_until = NULL WHERE status = 'claimed' AND lease_owner = ? AND attempts < max_attempts`, workerId);
}

/** Request-level de-duplication (e.g. the same message delivered twice). */
export function claimRequest(db, requestId, bot) {
  if (!requestId) return true;
  const res = db.run(`INSERT OR IGNORE INTO processed_requests (id, bot, created_at) VALUES (?, ?, ?)`, requestId, bot, Date.now());
  return res.changes === 1;
}
