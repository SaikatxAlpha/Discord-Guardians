// Append-only audit trail for every privileged decision and action.

const MAX_FIELD = 4000;
const clip = (v) => {
  if (v == null) return null;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > MAX_FIELD ? `${s.slice(0, MAX_FIELD)}…` : s;
};

export function audit(db, { guildId = null, actorId = null, bot, action, target = null, params = null, outcome, detail = null }) {
  const res = db.run(
    `INSERT INTO audit_log (ts, guild_id, actor_id, bot, action, target, params, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(),
    guildId,
    actorId,
    bot,
    action,
    clip(target),
    clip(params),
    outcome,
    clip(detail),
  );
  return Number(res.lastInsertRowid);
}

export function recentAudit(db, guildId, limit = 20) {
  return db.all('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY id DESC LIMIT ?', guildId, limit);
}
