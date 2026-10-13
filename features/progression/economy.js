// Aura (non-monetary server currency) and XP. Every balance change goes
// through applyLedger(), which appends to the immutable ledger inside the
// same transaction as the cached balance update. Idempotency keys make
// rewards safe against duplicate events, retries and restarts.
import crypto from 'node:crypto';
import { QUESTS, DEFAULT_SHOP } from '../../config/defaults.js';
import { dayKey, weekKey, previousDayKey } from '../../core/time.js';
import { normaliseText } from '../moderation/filter.js';

export class EconomyError extends Error {}

/** XP needed to go from level l to l+1. */
export const xpToNext = (l) => 5 * l * l + 50 * l + 100;

export function levelForXp(xp) {
  let level = 0;
  let remaining = xp;
  while (remaining >= xpToNext(level)) {
    remaining -= xpToNext(level);
    level++;
  }
  return { level, into: remaining, needed: xpToNext(level) };
}

export function ensureMember(db, guildId, userId) {
  db.run('INSERT OR IGNORE INTO members (guild_id, user_id) VALUES (?, ?)', guildId, userId);
  return db.get('SELECT * FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
}

/**
 * @returns {{applied:boolean, duplicate?:boolean, balance:number, entryId?:number, levelBefore?:number, levelAfter?:number}}
 */
export function applyLedger(db, { guildId, userId, currency = 'aura', amount, kind, reason, idempotencyKey = null, actorId = null, season = 1, now = Date.now(), allowNegative = false }) {
  if (!Number.isInteger(amount)) throw new EconomyError('amount must be an integer');
  if (!reason) throw new EconomyError('every ledger entry needs a reason');
  return db.transaction(() => {
    if (idempotencyKey && db.get('SELECT 1 FROM ledger WHERE idempotency_key = ?', idempotencyKey)) {
      const m = ensureMember(db, guildId, userId);
      return { applied: false, duplicate: true, balance: currency === 'aura' ? m.aura : m.xp };
    }
    const m = ensureMember(db, guildId, userId);
    const current = currency === 'aura' ? m.aura : m.xp;
    const next = current + amount;
    if (next < 0 && !allowNegative) throw new EconomyError(`Insufficient ${currency}: balance ${current}, needs ${-amount}`);
    const res = db.run(
      `INSERT INTO ledger (guild_id, user_id, currency, amount, balance_after, kind, reason, idempotency_key, actor_id, season, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guildId, userId, currency, amount, next, kind, String(reason).slice(0, 300), idempotencyKey, actorId, season, now,
    );
    let levelBefore;
    let levelAfter;
    if (currency === 'aura') {
      const seasonDelta = amount > 0 && kind !== 'transfer_in' && kind !== 'refund' ? amount : 0;
      db.run('UPDATE members SET aura = ?, season_aura = season_aura + ? WHERE guild_id = ? AND user_id = ?', next, seasonDelta, guildId, userId);
    } else {
      levelBefore = m.level;
      levelAfter = levelForXp(next).level;
      db.run('UPDATE members SET xp = ?, level = ? WHERE guild_id = ? AND user_id = ?', next, levelAfter, guildId, userId);
    }
    return { applied: true, balance: next, entryId: Number(res.lastInsertRowid), levelBefore, levelAfter };
  });
}

export function getProfile(db, guildId, userId) {
  const m = ensureMember(db, guildId, userId);
  const rank = db.get('SELECT COUNT(*) + 1 AS r FROM members WHERE guild_id = ? AND xp > ?', guildId, m.xp).r;
  return { ...m, rank, ...levelForXp(m.xp) };
}

/** Recompute balances from the ledger; returns mismatches (should be empty). */
export function auditBalances(db, guildId) {
  return db.all(
    `SELECT m.user_id, m.aura, COALESCE((SELECT SUM(amount) FROM ledger l WHERE l.guild_id = m.guild_id AND l.user_id = m.user_id AND currency = 'aura'), 0) AS ledger_aura,
            m.xp, COALESCE((SELECT SUM(amount) FROM ledger l WHERE l.guild_id = m.guild_id AND l.user_id = m.user_id AND currency = 'xp'), 0) AS ledger_xp
     FROM members m WHERE m.guild_id = ?`,
    guildId,
  ).filter((r) => r.aura !== r.ledger_aura || r.xp !== r.ledger_xp);
}

function bumpCounter(db, guildId, userId, day, metric, by) {
  db.run(
    `INSERT INTO daily_counters (guild_id, user_id, day, metric, value) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, day, metric) DO UPDATE SET value = value + excluded.value`,
    guildId, userId, day, metric, by,
  );
}

function counter(db, guildId, userId, day, metric) {
  return db.get('SELECT value FROM daily_counters WHERE guild_id = ? AND user_id = ? AND day = ? AND metric = ?', guildId, userId, day, metric)?.value ?? 0;
}

// ---------------------------------------------------------------- quests

export function questPeriods(now, tz) {
  return { daily: dayKey(now, tz), weekly: weekKey(now, tz) };
}

/** Advance quests tracking `metric`; grants rewards exactly once per period. */
export function progressQuests(db, { guildId, userId, metric, amount = 1, now = Date.now(), tz, season = 1 }) {
  const periods = questPeriods(now, tz);
  const completed = [];
  for (const [scope, list] of Object.entries(QUESTS)) {
    for (const q of list.filter((x) => x.metric === metric)) {
      const period = periods[scope];
      db.run(
        `INSERT INTO quest_progress (guild_id, user_id, quest_id, period, progress) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id, quest_id, period) DO UPDATE SET progress = MIN(progress + excluded.progress, ?)`,
        guildId, userId, q.id, period, Math.min(amount, q.goal), q.goal,
      );
      const row = db.get('SELECT * FROM quest_progress WHERE guild_id = ? AND user_id = ? AND quest_id = ? AND period = ?', guildId, userId, q.id, period);
      if (row.progress >= q.goal && !row.completed_at) {
        db.run('UPDATE quest_progress SET completed_at = ? WHERE guild_id = ? AND user_id = ? AND quest_id = ? AND period = ? AND completed_at IS NULL', now, guildId, userId, q.id, period);
        const key = `quest:${guildId}:${userId}:${q.id}:${period}`;
        applyLedger(db, { guildId, userId, currency: 'aura', amount: q.aura, kind: 'quest', reason: `Quest complete: ${q.name}`, idempotencyKey: `${key}:aura`, season, now });
        applyLedger(db, { guildId, userId, currency: 'xp', amount: q.xp, kind: 'quest', reason: `Quest complete: ${q.name}`, idempotencyKey: `${key}:xp`, season, now });
        completed.push(q);
      }
    }
  }
  return completed;
}

export function listQuests(db, { guildId, userId, now = Date.now(), tz }) {
  const periods = questPeriods(now, tz);
  return Object.entries(QUESTS).flatMap(([scope, list]) =>
    list.map((q) => {
      const row = db.get('SELECT progress, completed_at FROM quest_progress WHERE guild_id = ? AND user_id = ? AND quest_id = ? AND period = ?', guildId, userId, q.id, periods[scope]);
      return { ...q, scope, progress: row?.progress ?? 0, completed: Boolean(row?.completed_at) };
    }),
  );
}

// ---------------------------------------------------------------- activity rewards

/**
 * Message reward with anti-farming: cooldown, duplicate detection, minimum
 * length, diminishing returns per hour and a daily aura cap.
 */
export function rewardMessage(db, { guildId, userId, messageId, content, settings, now = Date.now(), tz, rng = Math.random }) {
  const prog = settings.progression;
  if (!prog.enabled) return { rewarded: false, reason: 'disabled' };
  const text = String(content ?? '').trim();
  if (text.length < prog.minMessageLength || text.split(/\s+/).length < 2) return { rewarded: false, reason: 'too_short' };
  return db.transaction(() => {
    const m = ensureMember(db, guildId, userId);
    if (now - m.last_reward_at < prog.messageCooldownMs) return { rewarded: false, reason: 'cooldown' };
    const hash = crypto.createHash('sha1').update(normaliseText(text).replace(/[^a-z0-9]+/g, '')).digest('hex').slice(0, 16);
    const recent = JSON.parse(m.recent_hashes);
    if (recent.includes(hash)) return { rewarded: false, reason: 'duplicate' };

    let windowStart = m.hour_window_start;
    let windowCount = m.hour_window_count;
    if (now - windowStart >= 3600000) {
      windowStart = now;
      windowCount = 0;
    }
    const factor = windowCount < prog.hourlyFullRewards ? 1 : windowCount < prog.hourlyFullRewards * 2 ? 0.5 : 0;
    if (factor === 0) return { rewarded: false, reason: 'hourly_cap' };

    const day = dayKey(now, tz);
    const [lo, hi] = prog.messageXp;
    const xp = Math.max(1, Math.round((lo + Math.floor(rng() * (hi - lo + 1))) * factor));
    const auraLeft = Math.max(0, prog.dailyMessageAuraCap - counter(db, guildId, userId, day, 'msg_aura'));
    const aura = Math.min(auraLeft, Math.round(prog.messageAura * factor));

    const xpRes = applyLedger(db, { guildId, userId, currency: 'xp', amount: xp, kind: 'message', reason: 'Chat activity', idempotencyKey: `msg:${messageId}:xp`, season: prog.season, now });
    if (!xpRes.applied) return { rewarded: false, reason: 'duplicate_event' };
    if (aura > 0) {
      applyLedger(db, { guildId, userId, currency: 'aura', amount: aura, kind: 'message', reason: 'Chat activity', idempotencyKey: `msg:${messageId}:aura`, season: prog.season, now });
      bumpCounter(db, guildId, userId, day, 'msg_aura', aura);
    }
    recent.push(hash);
    db.run(
      'UPDATE members SET last_reward_at = ?, hour_window_start = ?, hour_window_count = ?, recent_hashes = ? WHERE guild_id = ? AND user_id = ?',
      now, windowStart, windowCount + 1, JSON.stringify(recent.slice(-5)), guildId, userId,
    );
    const quests = progressQuests(db, { guildId, userId, metric: 'messages', now, tz, season: prog.season });
    return { rewarded: true, xp, aura, factor, levelUp: xpRes.levelAfter > xpRes.levelBefore ? xpRes.levelAfter : null, quests };
  });
}

/**
 * Is a voice state eligible for voice rewards? Prevents idle farming:
 * muted/deafened users, AFK channel, bots and solo channels earn nothing.
 */
export function isVoiceEligible(state, channelHumans, afkChannelId) {
  if (!state?.channelId || state.member?.user?.bot) return false;
  if (state.channelId === afkChannelId) return false;
  if (state.selfDeaf || state.serverDeaf || state.selfMute || state.serverMute) return false;
  const active = channelHumans.filter((s) => !s.selfDeaf && !s.serverDeaf);
  return active.length >= 2;
}

/** One minute of eligible voice time; minuteBucket makes it idempotent. */
export function rewardVoiceMinute(db, { guildId, userId, minuteBucket, settings, now = Date.now(), tz }) {
  const prog = settings.progression;
  if (!prog.enabled) return { rewarded: false, reason: 'disabled' };
  return db.transaction(() => {
    const day = dayKey(now, tz);
    if (counter(db, guildId, userId, day, 'voice_min') >= prog.dailyVoiceMinuteCap) return { rewarded: false, reason: 'daily_cap' };
    const key = `voice:${guildId}:${userId}:${minuteBucket}`;
    const xpRes = applyLedger(db, { guildId, userId, currency: 'xp', amount: prog.voiceXpPerMinute, kind: 'voice', reason: 'Voice activity', idempotencyKey: `${key}:xp`, season: prog.season, now });
    if (!xpRes.applied) return { rewarded: false, reason: 'duplicate_event' };
    applyLedger(db, { guildId, userId, currency: 'aura', amount: prog.voiceAuraPerMinute, kind: 'voice', reason: 'Voice activity', idempotencyKey: `${key}:aura`, season: prog.season, now });
    bumpCounter(db, guildId, userId, day, 'voice_min', 1);
    db.run(
      `INSERT INTO activity (guild_id, day, user_id, voice_minutes) VALUES (?, ?, ?, 1)
       ON CONFLICT(guild_id, day, user_id) DO UPDATE SET voice_minutes = voice_minutes + 1`,
      guildId, day, userId,
    );
    const quests = progressQuests(db, { guildId, userId, metric: 'voice_minutes', now, tz, season: prog.season });
    return { rewarded: true, levelUp: xpRes.levelAfter > xpRes.levelBefore ? xpRes.levelAfter : null, quests };
  });
}

// ---------------------------------------------------------------- daily / weekly

export function claimDaily(db, { guildId, userId, settings, now = Date.now(), tz }) {
  const prog = settings.progression;
  const day = dayKey(now, tz);
  return db.transaction(() => {
    const m = ensureMember(db, guildId, userId);
    if (m.last_daily === day) return { claimed: false, reason: 'already_claimed', streak: m.streak };
    const streak = m.last_daily === previousDayKey(now, tz) ? m.streak + 1 : 1;
    const bonus = Math.min(prog.streakBonus * (streak - 1), prog.streakBonusCap);
    const amount = prog.dailyReward + bonus;
    const r = applyLedger(db, { guildId, userId, amount, kind: 'daily', reason: `Daily reward (streak ${streak})`, idempotencyKey: `daily:${guildId}:${userId}:${day}`, season: prog.season, now });
    if (!r.applied) return { claimed: false, reason: 'already_claimed', streak: m.streak };
    db.run('UPDATE members SET last_daily = ?, streak = ? WHERE guild_id = ? AND user_id = ?', day, streak, guildId, userId);
    const quests = progressQuests(db, { guildId, userId, metric: 'daily_claims', now, tz, season: prog.season });
    return { claimed: true, amount, bonus, streak, balance: r.balance, quests };
  });
}

export function claimWeekly(db, { guildId, userId, settings, now = Date.now(), tz }) {
  const prog = settings.progression;
  const week = weekKey(now, tz);
  return db.transaction(() => {
    const m = ensureMember(db, guildId, userId);
    if (m.last_weekly === week) return { claimed: false, reason: 'already_claimed' };
    const r = applyLedger(db, { guildId, userId, amount: prog.weeklyReward, kind: 'weekly', reason: 'Weekly reward', idempotencyKey: `weekly:${guildId}:${userId}:${week}`, season: prog.season, now });
    if (!r.applied) return { claimed: false, reason: 'already_claimed' };
    db.run('UPDATE members SET last_weekly = ? WHERE guild_id = ? AND user_id = ?', week, guildId, userId);
    return { claimed: true, amount: prog.weeklyReward, balance: r.balance };
  });
}

// ---------------------------------------------------------------- transfers

export function transferAura(db, { guildId, fromId, toId, amount, transferId, settings, fromJoinedAt, toIsBot = false, now = Date.now(), tz }) {
  const t = settings.progression.transfer;
  if (!t.enabled) throw new EconomyError('Transfers are disabled in this server.');
  if (!Number.isInteger(amount) || amount <= 0) throw new EconomyError('Amount must be a positive whole number.');
  if (fromId === toId) throw new EconomyError('You cannot pay yourself.');
  if (toIsBot) throw new EconomyError('You cannot pay bots.');
  if (fromJoinedAt && now - fromJoinedAt < t.minMemberDays * 86400000) throw new EconomyError(`You must be a member for ${t.minMemberDays} days before sending aura.`);
  const day = dayKey(now, tz);
  return db.transaction(() => {
    if (db.get('SELECT 1 FROM ledger WHERE idempotency_key = ?', `pay:${transferId}:out`)) return { duplicate: true };
    const sent = counter(db, guildId, fromId, day, 'transfer_out');
    if (sent + amount > t.dailyCap) throw new EconomyError(`Daily transfer limit is ${t.dailyCap} aura (${t.dailyCap - sent} left today).`);
    const out = applyLedger(db, { guildId, userId: fromId, amount: -amount, kind: 'transfer_out', reason: `Paid to ${toId}`, idempotencyKey: `pay:${transferId}:out`, actorId: fromId, now });
    if (!out.applied) return { duplicate: true };
    applyLedger(db, { guildId, userId: toId, amount, kind: 'transfer_in', reason: `Received from ${fromId}`, idempotencyKey: `pay:${transferId}:in`, actorId: fromId, now });
    bumpCounter(db, guildId, fromId, day, 'transfer_out', amount);
    return { duplicate: false, balance: out.balance };
  });
}

// ---------------------------------------------------------------- shop

export function seedShop(db, guildId) {
  for (const it of DEFAULT_SHOP) {
    db.run(
      `INSERT OR IGNORE INTO shop_items (guild_id, id, name, description, price, kind, role_id, title, stock, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      guildId, it.id, it.name, it.description, it.price, it.kind, it.roleId ?? null, it.title ?? null, it.stock ?? null,
    );
  }
}

export function listShop(db, guildId) {
  seedShop(db, guildId);
  return db.all('SELECT * FROM shop_items WHERE guild_id = ? AND enabled = 1 ORDER BY price', guildId);
}

export function addShopItem(db, guildId, item) {
  db.run(
    `INSERT INTO shop_items (guild_id, id, name, description, price, kind, role_id, title, stock, enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(guild_id, id) DO UPDATE SET name = excluded.name, description = excluded.description, price = excluded.price, kind = excluded.kind,
       role_id = excluded.role_id, title = excluded.title, stock = excluded.stock, enabled = 1`,
    guildId, item.id, item.name, item.description ?? '', item.price, item.kind, item.roleId ?? null, item.title ?? null, item.stock ?? null,
  );
}

/** Debit, record purchase and inventory atomically. Role delivery happens after (with refund on failure). */
export function purchaseItem(db, { guildId, userId, itemId, purchaseId, now = Date.now() }) {
  return db.transaction(() => {
    const item = db.get('SELECT * FROM shop_items WHERE guild_id = ? AND id = ? AND enabled = 1', guildId, itemId);
    if (!item) throw new EconomyError('That item does not exist.');
    if (item.stock != null && item.stock <= 0) throw new EconomyError('That item is sold out.');
    const owned = db.get('SELECT quantity FROM inventory WHERE guild_id = ? AND user_id = ? AND item_id = ?', guildId, userId, itemId);
    if (owned && item.kind !== 'consumable') throw new EconomyError('You already own that item.');
    const r = applyLedger(db, { guildId, userId, amount: -item.price, kind: 'purchase', reason: `Bought ${item.name}`, idempotencyKey: `buy:${purchaseId}`, actorId: userId, now });
    if (!r.applied) return { duplicate: true, item };
    const p = db.run(`INSERT INTO purchases (guild_id, user_id, item_id, price, ledger_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'completed', ?)`, guildId, userId, itemId, item.price, r.entryId, now);
    db.run(
      `INSERT INTO inventory (guild_id, user_id, item_id, quantity, acquired_at) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(guild_id, user_id, item_id) DO UPDATE SET quantity = quantity + 1`,
      guildId, userId, itemId, now,
    );
    if (item.stock != null) db.run('UPDATE shop_items SET stock = stock - 1 WHERE guild_id = ? AND id = ?', guildId, itemId);
    if (item.kind === 'title') db.run('UPDATE members SET title = ? WHERE guild_id = ? AND user_id = ?', item.title, guildId, userId);
    return { duplicate: false, item, balance: r.balance, purchaseRowId: Number(p.lastInsertRowid) };
  });
}

export function refundPurchase(db, { guildId, userId, purchaseRowId, reason }) {
  return db.transaction(() => {
    const p = db.get(`SELECT * FROM purchases WHERE id = ? AND status = 'completed'`, purchaseRowId);
    if (!p) return false;
    applyLedger(db, { guildId, userId, amount: p.price, kind: 'refund', reason: `Refund: ${reason}`, idempotencyKey: `refund:${purchaseRowId}` });
    db.run(`UPDATE purchases SET status = 'refunded' WHERE id = ?`, purchaseRowId);
    db.run('UPDATE inventory SET quantity = quantity - 1 WHERE guild_id = ? AND user_id = ? AND item_id = ?', guildId, userId, p.item_id);
    db.run('DELETE FROM inventory WHERE guild_id = ? AND user_id = ? AND item_id = ? AND quantity <= 0', guildId, userId, p.item_id);
    return true;
  });
}

export function inventoryOf(db, guildId, userId) {
  return {
    items: db.all(
      `SELECT i.item_id, i.quantity, i.acquired_at, s.name, s.kind FROM inventory i LEFT JOIN shop_items s ON s.guild_id = i.guild_id AND s.id = i.item_id
       WHERE i.guild_id = ? AND i.user_id = ? ORDER BY i.acquired_at`,
      guildId, userId,
    ),
    purchases: db.all('SELECT * FROM purchases WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT 10', guildId, userId),
  };
}

// ---------------------------------------------------------------- leaderboards & seasons

export function leaderboard(db, guildId, by = 'aura', limit = 10) {
  const col = { aura: 'aura', xp: 'xp', season: 'season_aura' }[by] ?? 'aura';
  // Column name is chosen from a fixed whitelist above, never from input.
  return db.all(`SELECT user_id, aura, xp, level, season_aura, title FROM members WHERE guild_id = ? AND ${col} > 0 ORDER BY ${col} DESC LIMIT ?`, guildId, limit);
}

/** Archive season standings and start a new season. Ledger history is untouched. */
export function endSeason(db, guildId, season) {
  return db.transaction(() => {
    const rows = db.all('SELECT user_id, season_aura FROM members WHERE guild_id = ? AND season_aura > 0 ORDER BY season_aura DESC', guildId);
    rows.forEach((r, i) => db.run('INSERT OR REPLACE INTO season_results (guild_id, season, user_id, rank, aura) VALUES (?, ?, ?, ?, ?)', guildId, season, r.user_id, i + 1, r.season_aura));
    db.run('UPDATE members SET season_aura = 0 WHERE guild_id = ?', guildId);
    return rows.slice(0, 10);
  });
}
