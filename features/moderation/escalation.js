// Points-based escalation. Each violation adds points; the action is the
// step whose threshold this violation crossed (default: warn).

export function activePoints(db, guildId, userId, decayHours, now = Date.now()) {
  const row = db.get(
    `SELECT COALESCE(SUM(points), 0) AS p FROM mod_cases WHERE guild_id = ? AND user_id = ? AND created_at > ? AND result != 'refused'`,
    guildId,
    userId,
    now - decayHours * 3600000,
  );
  return row.p;
}

/**
 * @returns {{action:'warn'|'timeout'|'kick'|'ban', durationMs?:number, before:number, after:number}}
 */
export function decideEscalation({ before, add, escalation }) {
  const after = before + add;
  const steps = [...escalation.steps].sort((a, b) => a.points - b.points);
  let chosen = null;
  for (const s of steps) if (before < s.points && after >= s.points) chosen = s;
  const action = chosen ?? { action: 'warn' };
  return { action: action.action, durationMs: action.durationMs, before, after };
}

/** Cap an automatic action (used for voice moderation: never kick/ban from a transcript). */
export function capAction(decision, maxAction) {
  const order = ['warn', 'timeout', 'kick', 'ban'];
  if (order.indexOf(decision.action) <= order.indexOf(maxAction)) return decision;
  return { ...decision, action: maxAction, durationMs: maxAction === 'timeout' ? decision.durationMs ?? 10 * 60000 : undefined };
}
