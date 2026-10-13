// Confirmation workflow for sensitive operations. An approval is bound to
// the requesting user's ID, expires, and can be decided exactly once (the
// state transition is a single conditional UPDATE).
import crypto from 'node:crypto';

export function createApproval(db, { guildId, ownerId, bot, plan, context = {}, summary, risk, ttlMs, now = Date.now() }) {
  const id = crypto.randomBytes(8).toString('hex');
  db.run(
    `INSERT INTO approvals (id, guild_id, owner_id, bot, plan, context, summary, risk, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
    id,
    guildId,
    ownerId,
    bot,
    JSON.stringify(plan),
    JSON.stringify(context),
    summary,
    risk,
    now,
    now + ttlMs,
  );
  return getApproval(db, id);
}

export function getApproval(db, id) {
  const row = db.get('SELECT * FROM approvals WHERE id = ?', id);
  if (!row) return null;
  return { ...row, plan: JSON.parse(row.plan), context: JSON.parse(row.context) };
}

/**
 * Decide an approval. Rejects unknown, unauthorised, expired and already
 * decided (duplicate/stale) approvals.
 * @returns {{ok:boolean, reason?:string, approval?:object}}
 */
export function decideApproval(db, { id, userId, approve, now = Date.now() }) {
  return db.transaction(() => {
    const row = getApproval(db, id);
    if (!row) return { ok: false, reason: 'not_found' };
    if (row.owner_id !== userId) return { ok: false, reason: 'unauthorized', approval: row };
    if (row.status !== 'pending') return { ok: false, reason: 'already_decided', approval: row };
    if (row.expires_at <= now) {
      db.run(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE id = ? AND status = 'pending'`, now, id);
      return { ok: false, reason: 'expired', approval: { ...row, status: 'expired' } };
    }
    const res = db.run(
      `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?
       WHERE id = ? AND status = 'pending' AND owner_id = ? AND expires_at > ?`,
      approve ? 'approved' : 'rejected',
      now,
      userId,
      id,
      userId,
      now,
    );
    if (res.changes !== 1) return { ok: false, reason: 'already_decided', approval: row };
    return { ok: true, approval: getApproval(db, id) };
  });
}

export function setApprovalMessage(db, id, channelId, messageId) {
  db.run('UPDATE approvals SET channel_id = ?, message_id = ? WHERE id = ?', channelId, messageId, id);
}

export function finishApproval(db, id, outcome) {
  db.run(`UPDATE approvals SET status = 'executed', outcome = ? WHERE id = ? AND status = 'approved'`, outcome, id);
}

/** Mark overdue approvals expired and return them so their messages can be updated. */
export function expireApprovals(db, now = Date.now()) {
  return db.transaction(() => {
    const rows = db.all(`SELECT id, channel_id, message_id, bot, summary FROM approvals WHERE status = 'pending' AND expires_at <= ?`, now);
    if (rows.length) db.run(`UPDATE approvals SET status = 'expired', decided_at = ? WHERE status = 'pending' AND expires_at <= ?`, now, now);
    return rows;
  });
}
