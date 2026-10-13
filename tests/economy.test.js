import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLedger, rewardMessage, rewardVoiceMinute, claimDaily, claimWeekly, transferAura, purchaseItem, refundPurchase, listShop, getProfile,
  auditBalances, isVoiceEligible, listQuests, levelForXp, leaderboard, endSeason, EconomyError, addShopItem,
} from '../features/progression/economy.js';
import { finalizeEvent, insertEvent, joinEvent } from '../features/events/events.js';
import { getGuildSettings, setGuildSetting } from '../core/settings.js';
import { openDatabase } from '../database/db.js';
import { memDb, fileDb } from './helpers.js';

const TZ = 'Asia/Kolkata';
const G = 'guild1';
const T0 = Date.parse('2026-10-13T06:00:00Z');

test('ledger is append-only and every change has a reason', () => {
  const db = memDb();
  applyLedger(db, { guildId: G, userId: 'u', amount: 50, kind: 'test', reason: 'seed' });
  assert.throws(() => db.run('UPDATE ledger SET amount = 999999'), /append-only/);
  assert.throws(() => db.run('DELETE FROM ledger'), /append-only/);
  assert.throws(() => applyLedger(db, { guildId: G, userId: 'u', amount: 5, kind: 'x', reason: '' }), /reason/);
  assert.throws(() => applyLedger(db, { guildId: G, userId: 'u', amount: -500, kind: 'x', reason: 'overspend' }), EconomyError);
  assert.equal(getProfile(db, G, 'u').aura, 50);
});

test('idempotent rewards: the same key never pays twice', () => {
  const db = memDb();
  const a = applyLedger(db, { guildId: G, userId: 'u', amount: 10, kind: 'k', reason: 'r', idempotencyKey: 'once' });
  const b = applyLedger(db, { guildId: G, userId: 'u', amount: 10, kind: 'k', reason: 'r', idempotencyKey: 'once' });
  assert.equal(a.applied, true);
  assert.equal(b.applied, false);
  assert.equal(getProfile(db, G, 'u').aura, 10);
});

test('anti-farming: cooldown, duplicates, short messages, diminishing returns and daily cap', () => {
  const db = memDb();
  const settings = getGuildSettings(db, G);
  const rw = (i, content, dt) => rewardMessage(db, { guildId: G, userId: 'u', messageId: `m${i}`, content, settings, now: T0 + dt, tz: TZ, rng: () => 0 });
  assert.equal(rw(1, 'hello there friends', 0).rewarded, true);
  assert.equal(rw(2, 'another message here', 10_000).reason, 'cooldown');
  assert.equal(rw(3, 'ok', 120_000).reason, 'too_short');
  assert.equal(rw(4, 'Hello there, friends!', 120_000).reason, 'duplicate');
  assert.equal(rw(1, 'replayed event same id', 300_000).reason, 'duplicate_event', 'same Discord message id cannot pay twice');
  // Diminishing returns within one hour window.
  const db2 = memDb();
  const s2 = { ...settings, progression: { ...settings.progression, messageCooldownMs: 0, hourlyFullRewards: 3 } };
  const factors = [];
  for (let i = 0; i < 8; i++) {
    const r = rewardMessage(db2, { guildId: G, userId: 'u', messageId: `x${i}`, content: `unique message number ${i}`, settings: s2, now: T0 + i * 1000, tz: TZ, rng: () => 0 });
    factors.push(r.rewarded ? r.factor : r.reason);
  }
  assert.deepEqual(factors, [1, 1, 1, 0.5, 0.5, 0.5, 'hourly_cap', 'hourly_cap']);
  // Daily aura cap.
  const db3 = memDb();
  const s3 = { ...settings, progression: { ...settings.progression, messageCooldownMs: 0, hourlyFullRewards: 1000, dailyMessageAuraCap: 6, messageAura: 2 } };
  for (let i = 0; i < 10; i++) rewardMessage(db3, { guildId: G, userId: 'u', messageId: `y${i}`, content: `distinct text ${i}`, settings: s3, now: T0 + i * 1000, tz: TZ });
  assert.equal(getProfile(db3, G, 'u').aura, 6);
  assert.deepEqual(auditBalances(db3, G), []);
});

test('daily streaks, weekly rewards and quests', () => {
  const db = memDb();
  const settings = getGuildSettings(db, G);
  const d1 = claimDaily(db, { guildId: G, userId: 'u', settings, now: T0, tz: TZ });
  assert.deepEqual([d1.claimed, d1.streak, d1.amount], [true, 1, 100]);
  assert.equal(claimDaily(db, { guildId: G, userId: 'u', settings, now: T0 + 3600000, tz: TZ }).claimed, false);
  const d2 = claimDaily(db, { guildId: G, userId: 'u', settings, now: T0 + 86400000, tz: TZ });
  assert.deepEqual([d2.streak, d2.amount], [2, 110]);
  const d4 = claimDaily(db, { guildId: G, userId: 'u', settings, now: T0 + 3 * 86400000, tz: TZ });
  assert.equal(d4.streak, 1, 'missed day resets the streak');
  assert.equal(claimWeekly(db, { guildId: G, userId: 'u', settings, now: T0, tz: TZ }).claimed, true);
  assert.equal(claimWeekly(db, { guildId: G, userId: 'u', settings, now: T0 + 3600000, tz: TZ }).claimed, false);
  const q = listQuests(db, { guildId: G, userId: 'u', now: T0 + 3 * 86400000, tz: TZ }).find((x) => x.id === 'd_daily');
  assert.equal(q.completed, true);
  assert.deepEqual(auditBalances(db, G), []);
});

test('voice rewards: idle farming is filtered and minutes are idempotent', () => {
  const human = (o) => ({ channelId: 'vc', member: { user: { bot: false } }, selfDeaf: false, serverDeaf: false, selfMute: false, serverMute: false, ...o });
  const a = human({ id: 'a' });
  const b = human({ id: 'b' });
  assert.equal(isVoiceEligible(a, [a, b], 'afk'), true);
  assert.equal(isVoiceEligible(a, [a], 'afk'), false, 'alone in channel');
  assert.equal(isVoiceEligible(human({ selfMute: true }), [a, b], 'afk'), false, 'muted idler');
  assert.equal(isVoiceEligible(human({ selfDeaf: true }), [a, b], 'afk'), false);
  assert.equal(isVoiceEligible(human({ channelId: 'afk' }), [a, b], 'afk'), false);
  assert.equal(isVoiceEligible(a, [a, human({ selfDeaf: true })], 'afk'), false, 'other person deafened');
  const db = memDb();
  const settings = getGuildSettings(db, G);
  assert.equal(rewardVoiceMinute(db, { guildId: G, userId: 'u', minuteBucket: 1, settings, now: T0, tz: TZ }).rewarded, true);
  assert.equal(rewardVoiceMinute(db, { guildId: G, userId: 'u', minuteBucket: 1, settings, now: T0, tz: TZ }).rewarded, false);
  const s2 = { ...settings, progression: { ...settings.progression, dailyVoiceMinuteCap: 2 } };
  rewardVoiceMinute(db, { guildId: G, userId: 'u', minuteBucket: 2, settings: s2, now: T0, tz: TZ });
  assert.equal(rewardVoiceMinute(db, { guildId: G, userId: 'u', minuteBucket: 3, settings: s2, now: T0, tz: TZ }).reason, 'daily_cap');
});

test('transfers: caps, self-pay, bots and new members are blocked; replay is idempotent', () => {
  const db = memDb();
  const settings = getGuildSettings(db, G);
  applyLedger(db, { guildId: G, userId: 'a', amount: 5000, kind: 'seed', reason: 'seed' });
  const base = { guildId: G, fromId: 'a', toId: 'b', settings, fromJoinedAt: T0 - 30 * 86400000, now: T0, tz: TZ };
  assert.throws(() => transferAura(db, { ...base, toId: 'a', amount: 10, transferId: 't0' }), /yourself/);
  assert.throws(() => transferAura(db, { ...base, toIsBot: true, amount: 10, transferId: 't1' }), /bots/);
  assert.throws(() => transferAura(db, { ...base, fromJoinedAt: T0 - 3600000, amount: 10, transferId: 't2' }), /member for/);
  transferAura(db, { ...base, amount: 600, transferId: 't3' });
  assert.equal(transferAura(db, { ...base, amount: 600, transferId: 't3' }).duplicate, true);
  assert.throws(() => transferAura(db, { ...base, amount: 600, transferId: 't4' }), /Daily transfer limit/);
  assert.equal(getProfile(db, G, 'b').aura, 600);
  assert.equal(getProfile(db, G, 'b').season_aura, 0, 'received transfers do not count toward season ranking');
  assert.deepEqual(auditBalances(db, G), []);
});

test('shop purchases, insufficient funds, ownership, stock and refunds', () => {
  const db = memDb();
  listShop(db, G);
  applyLedger(db, { guildId: G, userId: 'u', amount: 400, kind: 'seed', reason: 'seed' });
  assert.throws(() => purchaseItem(db, { guildId: G, userId: 'u', itemId: 'title_reaper', purchaseId: 'p1' }), /Insufficient/);
  const r = purchaseItem(db, { guildId: G, userId: 'u', itemId: 'title_wanderer', purchaseId: 'p2' });
  assert.equal(r.balance, 100);
  assert.equal(getProfile(db, G, 'u').title, 'Void Wanderer');
  assert.throws(() => purchaseItem(db, { guildId: G, userId: 'u', itemId: 'title_wanderer', purchaseId: 'p3' }), /already own/);
  addShopItem(db, G, { id: 'vip', name: 'VIP', price: 50, kind: 'role', roleId: '1', stock: 1 });
  const v = purchaseItem(db, { guildId: G, userId: 'u', itemId: 'vip', purchaseId: 'p4' });
  assert.throws(() => purchaseItem(db, { guildId: G, userId: 'z', itemId: 'vip', purchaseId: 'p5' }), /sold out|Insufficient/);
  assert.equal(refundPurchase(db, { guildId: G, userId: 'u', purchaseRowId: v.purchaseRowId, reason: 'role delivery failed' }), true);
  assert.equal(refundPurchase(db, { guildId: G, userId: 'u', purchaseRowId: v.purchaseRowId, reason: 'again' }), false);
  assert.equal(getProfile(db, G, 'u').aura, 100);
  assert.deepEqual(auditBalances(db, G), []);
});

test('event rewards are paid exactly once and count toward quests', () => {
  const db = memDb();
  const ev = insertEvent(db, { guildId: G, name: 'Valorant night', startsAt: T0, endsAt: T0 + 3600000, reward: 150, createdBy: 'o' });
  joinEvent(db, ev.id, 'a');
  assert.equal(joinEvent(db, ev.id, 'a').already, true);
  joinEvent(db, ev.id, 'b');
  const r1 = finalizeEvent(db, ev.id, { tz: TZ, now: T0 + 3600000 });
  const r2 = finalizeEvent(db, ev.id, { tz: TZ, now: T0 + 3600000 });
  assert.equal(r1.rewarded, 2);
  assert.equal(r2.rewarded, 0);
  assert.equal(getProfile(db, G, 'a').aura, 150 + 200, 'event reward + weekly event quest');
  assert.equal(joinEvent(db, ev.id, 'c').ok, false);
});

test('aura, XP and progress survive a restart (file database reopened)', () => {
  const { db, file } = fileDb();
  const settings = getGuildSettings(db, G);
  rewardMessage(db, { guildId: G, userId: 'u', messageId: 'r1', content: 'persistent message one', settings, now: T0, tz: TZ });
  claimDaily(db, { guildId: G, userId: 'u', settings, now: T0, tz: TZ });
  setGuildSetting(db, G, 'progression.season', 3);
  const before = getProfile(db, G, 'u');
  db.close();
  const db2 = openDatabase(file);
  const after = getProfile(db2, G, 'u');
  assert.deepEqual([after.aura, after.xp, after.streak, after.last_daily], [before.aura, before.xp, before.streak, before.last_daily]);
  assert.equal(getGuildSettings(db2, G).progression.season, 3);
  assert.equal(claimDaily(db2, { guildId: G, userId: 'u', settings, now: T0 + 1000, tz: TZ }).claimed, false, 'no double daily after restart');
  db2.close();
});

test('levels, leaderboards and season archive', () => {
  assert.deepEqual(levelForXp(0), { level: 0, into: 0, needed: 100 });
  assert.equal(levelForXp(100).level, 1);
  assert.equal(levelForXp(255).level, 2);
  const db = memDb();
  applyLedger(db, { guildId: G, userId: 'a', amount: 300, kind: 'k', reason: 'r' });
  applyLedger(db, { guildId: G, userId: 'b', amount: 100, kind: 'k', reason: 'r' });
  assert.deepEqual(leaderboard(db, G, 'aura').map((r) => r.user_id), ['a', 'b']);
  const top = endSeason(db, G, 1);
  assert.equal(top[0].user_id, 'a');
  assert.equal(leaderboard(db, G, 'season').length, 0);
  assert.equal(getProfile(db, G, 'a').aura, 300, 'balances are unaffected by season reset');
  // Unknown sort keys fall back to a whitelisted column; input never reaches SQL text.
  assert.deepEqual(leaderboard(db, G, 'aura; DROP TABLE members').map((r) => r.user_id), ['a', 'b']);
  assert.ok(db.get('SELECT COUNT(*) AS n FROM members').n >= 2);
});
