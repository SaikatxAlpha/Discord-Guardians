import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProfanity, normaliseText, buildMatcher } from '../features/moderation/filter.js';
import { SpamTracker, RaidDetector } from '../features/moderation/spam.js';
import { decideEscalation, capAction } from '../features/moderation/escalation.js';
import { enforce } from '../features/moderation/enforce.js';
import { AutoModerator } from '../features/moderation/automod.js';
import { checkModeration } from '../core/discord/safety.js';
import { getGuildSettings, setGuildSetting } from '../core/settings.js';
import { DEFAULT_GUILD_SETTINGS } from '../config/defaults.js';
import { memoryLogger } from '../core/logger.js';
import { buildMockGuild } from './mocks/discord.js';
import { testConfig, memDb } from './helpers.js';

const m = buildMatcher({});

test('profanity detection handles obfuscation', () => {
  for (const t of ['f*ck you'.replace('*', 'u'), 'FUUUUCK', 'f.u.c.k', 's h i t', '5h1t', 'ѕhit', 'b!tch', 'what the fuck', 'what the fuck!', 'shit?!', '$hit']) {
    assert.equal(checkProfanity(t, m).matched, true, t);
  }
  assert.equal(normaliseText('Ｆｕｃｋ'), 'fuck');
});

test('no false positives on innocent words (Scunthorpe problem)', () => {
  for (const t of ['I live in Scunthorpe', 'classic cocktail', 'the assassin hid', 'Minecraft mc server', 'grab a shiitake', 'pakistan cricket', 'cockpit view', 'he is a bassist', 'I passed the class']) {
    assert.equal(checkProfanity(t, m).matched, false, t);
  }
});

test('quotes and code are flagged for review, not punished', () => {
  const r = checkProfanity('He said "you are a bitch" to me, please help', m);
  assert.equal(r.matched, true);
  assert.equal(r.contextual, true);
  assert.equal(checkProfanity('> shit happens\nok', m).contextual, true);
  assert.equal(checkProfanity('`fuck`', m).contextual, true);
  assert.equal(checkProfanity('"quote" but you are a bitch', m).contextual, false);
});

test('severity and per-guild word lists', () => {
  assert.equal(checkProfanity('you f4ggot', m).severity, 'severe');
  const custom = buildMatcher({ extraWords: ['noob'], allowWords: ['shit'] });
  assert.equal(checkProfanity('noob', custom).matched, true);
  assert.equal(checkProfanity('shit', custom).matched, false);
});

test('spam detection: flood, duplicates, mentions, invites', () => {
  const cfg = { ...DEFAULT_GUILD_SETTINGS.moderation.spam, blockInvites: true };
  const s = new SpamTracker();
  let r;
  const t0 = 1_000_000;
  for (let i = 0; i < 6; i++) r = s.check({ guildId: 'g', userId: 'u', content: `msg ${i}`, now: t0 + i * 500 }, cfg);
  assert.equal(r.rule, 'flood');
  const s2 = new SpamTracker();
  for (let i = 0; i < 3; i++) r = s2.check({ guildId: 'g', userId: 'u', content: 'BUY NOW', now: t0 + i * 3000 }, cfg);
  assert.equal(r.rule, 'duplicate');
  assert.equal(new SpamTracker().check({ guildId: 'g', userId: 'u', content: 'hi', mentionCount: 6 }, cfg).rule, 'mention_spam');
  assert.equal(new SpamTracker().check({ guildId: 'g', userId: 'u', content: 'join discord.gg/abc' }, cfg).rule, 'invite_link');
  assert.equal(new SpamTracker().check({ guildId: 'g', userId: 'u', content: 'hello there' }, cfg).spam, false);
});

test('raid detection triggers once and flags new accounts', () => {
  const cfg = DEFAULT_GUILD_SETTINGS.moderation.raid;
  const d = new RaidDetector();
  const t0 = 5_000_000;
  let r;
  let started = 0;
  for (let i = 0; i < 10; i++) {
    r = d.onJoin({ guildId: 'g', accountCreatedAt: t0 - 3600000, now: t0 + i * 1000 }, cfg);
    if (r.started) started++;
  }
  assert.equal(r.raid, true);
  assert.equal(started, 1);
  assert.equal(r.newAccount, true);
});

test('escalation thresholds and voice cap', () => {
  const esc = DEFAULT_GUILD_SETTINGS.moderation.escalation;
  assert.equal(decideEscalation({ before: 0, add: 1, escalation: esc }).action, 'warn');
  assert.equal(decideEscalation({ before: 1, add: 1, escalation: esc }).action, 'warn');
  const t = decideEscalation({ before: 2, add: 1, escalation: esc });
  assert.deepEqual([t.action, t.durationMs], ['timeout', 600000]);
  assert.equal(decideEscalation({ before: 6, add: 3, escalation: esc }).action, 'kick');
  assert.equal(capAction({ action: 'kick' }, 'warn').action, 'warn');
  assert.equal(capAction({ action: 'ban' }, 'timeout').action, 'timeout');
});

test('safety checks: self, owner, bots, protected roles and hierarchy', () => {
  const { guild, members, roles } = buildMockGuild();
  const config = testConfig({ ownerId: guild.ownerId });
  const mod = { protectedRoleIds: [roles.research.id] };
  const me = guild.members.me;
  const chk = (o) => checkModeration({ action: 'timeout', guild, botMember: me, config, moderation: mod, ...o });
  assert.equal(chk({ target: members.mod, actor: members.mod }).ok, false); // self
  assert.equal(chk({ target: guild.owner, actor: members.boss }).ok, false); // owner
  assert.equal(chk({ target: me, actor: members.boss }).ok, false); // the bot
  assert.equal(chk({ target: members.otherBot, actor: null, automatic: true }).ok, false); // bot loops
  members.john.roles.cache.set(roles.research.id, roles.research);
  assert.match(chk({ target: members.john, actor: members.boss }).reason, /protected/);
  assert.match(chk({ target: members.boss, actor: guild.owner }).reason, /above mine/); // Admins role (60) above bot (50)
  assert.match(chk({ target: members.mod, actor: members.mod.id === 'x' ? null : members.bob }).reason, /above yours/); // Bob (no roles) vs Kai (Moderators)
  assert.equal(chk({ target: members.bob, actor: members.mod }).ok, true);
});

test('automod in SIMULATION mode records the case but takes no action', async () => {
  const { guild, members, channels } = buildMockGuild();
  const config = testConfig({ ownerId: guild.ownerId });
  const db = memDb();
  setGuildSetting(db, guild.id, 'channels.modLog', channels.staff.id);
  const auto = new AutoModerator({ db, config, logger: memoryLogger() });
  let deleted = false;
  const msg = (content, i) => ({ id: `m${i}`, guild, author: members.bob.user, member: members.bob, channelId: channels.general.id, channel: channels.general, content, mentions: { users: { size: 0 } }, delete: async () => (deleted = true) });
  const r1 = await auto.onMessage(msg('you are a bitch', 1));
  assert.equal(r1.result.simulated, true);
  assert.equal(members.bob.communicationDisabledUntilTimestamp, null);
  assert.equal(members.bob.dms.length, 0);
  assert.equal(deleted, false);
  const kase = db.get('SELECT * FROM mod_cases');
  assert.deepEqual([kase.simulated, kase.result, kase.rule], [1, 'simulated', 'profanity_mild']);
  assert.match(channels.staff.messages[0].embeds[0].data.title, /SIMULATION/);
  auto.stop();
});

test('automod enforcing: escalates to a verified timeout; exempt moderators untouched', async () => {
  const { guild, members, channels } = buildMockGuild();
  const config = testConfig({ ownerId: guild.ownerId });
  const db = memDb();
  setGuildSetting(db, guild.id, 'moderation.simulate', false);
  const auto = new AutoModerator({ db, config, logger: memoryLogger() });
  const msg = (who, content, i) => ({ id: `m${i}`, guild, author: who.user, member: who, channelId: channels.general.id, channel: channels.general, content, mentions: { users: { size: 0 } }, delete: async () => {} });
  const results = [];
  for (let i = 0; i < 3; i++) results.push(await auto.onMessage(msg(members.bob, `shit number ${i} lol`, i)));
  assert.deepEqual(results.map((r) => r.action), ['warn', 'warn', 'timeout']);
  assert.equal(results[2].result.verified, true);
  assert.ok(members.bob.communicationDisabledUntilTimestamp > Date.now());
  assert.equal(await auto.onMessage(msg(members.mod, 'shit', 9)), null, 'moderators are exempt');
  assert.equal(await auto.onMessage({ ...msg(members.otherBot, 'shit', 10), author: members.otherBot.user }), null, 'bots ignored');
  auto.stop();
});

test('enforce refuses (and records) actions blocked by hierarchy; Discord API errors are captured', async () => {
  const { guild, members } = buildMockGuild();
  const config = testConfig({ ownerId: guild.ownerId });
  const db = memDb();
  const settings = getGuildSettings(db, guild.id);
  const r = await enforce({ db, config, settings, logger: memoryLogger(), guild, action: 'ban', target: members.boss, actor: guild.owner, reason: 'test' });
  assert.equal(r.ok, false);
  assert.equal(db.get('SELECT result FROM mod_cases WHERE id = ?', r.caseId).result, 'refused');
  guild.failNext('member.kick');
  const r2 = await enforce({ db, config, settings, logger: memoryLogger(), guild, action: 'kick', target: members.bob, actor: guild.owner, reason: 'test' });
  assert.equal(r2.ok, false);
  assert.ok(guild.members.cache.has(members.bob.id));
  const r3 = await enforce({ db, config, settings, logger: memoryLogger(), guild, action: 'ban', target: members.bob, actor: guild.owner, reason: 'raid' });
  assert.equal(r3.ok, true);
  assert.equal(r3.verified, true);
  assert.ok(guild.bans.cache.has(members.bob.id));
});
