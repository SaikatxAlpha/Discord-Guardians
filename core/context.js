// Short-lived conversational references ("that channel", "that member").
const TTL_MS = 30 * 60 * 1000;

export function setRef(db, guildId, userId, key, value) {
  if (!guildId || !userId || value == null) return;
  db.run(
    `INSERT INTO alpha_context (guild_id, user_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    guildId,
    userId,
    key,
    String(value),
    Date.now(),
  );
}

export function getRef(db, guildId, userId, key) {
  const row = db.get('SELECT value, updated_at FROM alpha_context WHERE guild_id = ? AND user_id = ? AND key = ?', guildId, userId, key);
  if (!row || Date.now() - row.updated_at > TTL_MS) return null;
  return row.value;
}
