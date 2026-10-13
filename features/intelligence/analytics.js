// Server activity analytics built from data the bots legitimately receive
// (message events, voice states, member joins/leaves). Message content is
// not stored here: only counts.
import { dayKey } from '../../core/time.js';
import { periodStart } from '../moderation/handlers.js';

export function recordMessageActivity(db, { guildId, channelId, userId, now = Date.now(), tz }) {
  const day = dayKey(now, tz);
  db.run(
    `INSERT INTO activity (guild_id, day, user_id, messages) VALUES (?, ?, ?, 1)
     ON CONFLICT(guild_id, day, user_id) DO UPDATE SET messages = messages + 1`,
    guildId, day, userId,
  );
  db.run(
    `INSERT INTO channel_activity (guild_id, day, channel_id, messages) VALUES (?, ?, ?, 1)
     ON CONFLICT(guild_id, day, channel_id) DO UPDATE SET messages = messages + 1`,
    guildId, day, channelId,
  );
}

export function activityStats(db, guildId, period, tz, now = Date.now()) {
  const since = periodStart(period, tz, now);
  const days = [];
  for (let t = since; t <= now; t += 86400000) days.push(dayKey(t, tz));
  const first = days[0];
  const last = dayKey(now, tz);
  const totals = db.get(
    `SELECT COALESCE(SUM(messages),0) AS messages, COALESCE(SUM(voice_minutes),0) AS voice, COUNT(DISTINCT CASE WHEN messages > 0 OR voice_minutes > 0 THEN user_id END) AS active
     FROM activity WHERE guild_id = ? AND day BETWEEN ? AND ?`,
    guildId, first, last,
  );
  const topUsers = db.all(
    `SELECT user_id, SUM(messages) AS messages, SUM(voice_minutes) AS voice FROM activity WHERE guild_id = ? AND day BETWEEN ? AND ?
     GROUP BY user_id ORDER BY messages + voice DESC LIMIT 5`,
    guildId, first, last,
  );
  const topChannels = db.all(
    `SELECT channel_id, SUM(messages) AS messages FROM channel_activity WHERE guild_id = ? AND day BETWEEN ? AND ? GROUP BY channel_id ORDER BY messages DESC LIMIT 5`,
    guildId, first, last,
  );
  const members = db.get(
    `SELECT SUM(type = 'join') AS joins, SUM(type = 'leave') AS leaves FROM member_events WHERE guild_id = ? AND ts >= ?`,
    guildId, since,
  );
  const mod = db.get(`SELECT COUNT(*) AS n, SUM(simulated) AS sim FROM mod_cases WHERE guild_id = ? AND created_at >= ? AND result != 'refused'`, guildId, since);
  const economy = db.get(
    `SELECT COALESCE(SUM(CASE WHEN amount > 0 AND kind NOT IN ('transfer_in','refund') THEN amount END),0) AS earned,
            COALESCE(SUM(CASE WHEN kind = 'purchase' THEN -amount END),0) AS spent
     FROM ledger WHERE guild_id = ? AND currency = 'aura' AND created_at >= ?`,
    guildId, since,
  );
  return { period, since, totals, topUsers, topChannels, joins: members.joins ?? 0, leaves: members.leaves ?? 0, modActions: mod.n, simulatedModActions: mod.sim ?? 0, economy };
}

export function activityEmbed(stats, color = 0x22d3ee) {
  const s = stats;
  return {
    title: `🛡️ Server activity — ${s.period === 'today' ? 'today' : 'last 7 days'}`,
    color,
    fields: [
      { name: 'Messages', value: String(s.totals.messages), inline: true },
      { name: 'Active members', value: String(s.totals.active), inline: true },
      { name: 'Voice minutes', value: String(s.totals.voice), inline: true },
      { name: 'Joins / leaves', value: `${s.joins} / ${s.leaves}`, inline: true },
      { name: 'Moderation actions', value: `${s.modActions}${s.simulatedModActions ? ` (${s.simulatedModActions} simulated)` : ''}`, inline: true },
      { name: 'Aura earned / spent', value: `${s.economy.earned} / ${s.economy.spent}`, inline: true },
      { name: 'Most active members', value: s.topUsers.map((u, i) => `${i + 1}. <@${u.user_id}> — ${u.messages} msgs, ${u.voice} voice min`).join('\n') || '—' },
      { name: 'Busiest channels', value: s.topChannels.map((c, i) => `${i + 1}. <#${c.channel_id}> — ${c.messages}`).join('\n') || '—' },
    ],
    footer: { text: 'AEGIS • counts only; message content is not stored' },
    timestamp: new Date().toISOString(),
  };
}
