import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChannelType } from 'discord.js';
import { serverHandlers } from '../features/server/handlers.js';
import { getGuildSettings } from '../core/settings.js';
import { memoryLogger } from '../core/logger.js';
import { buildMockGuild } from './mocks/discord.js';
import { testConfig, memDb, coordinatorFor, rid } from './helpers.js';

function ctxFor(env, userId) {
  const db = memDb();
  const config = testConfig({ ownerId: env.guild.ownerId });
  return { db, config, logger: memoryLogger(), bot: 'aegis', guild: env.guild, settings: getGuildSettings(db, env.guild.id), request: { userId, requestId: rid(), source: 'slash' } };
}

test('private channel keeps the bot and requester inside and hides it from @everyone', async () => {
  const env = buildMockGuild();
  const ctx = ctxFor(env, env.guild.ownerId);
  const r = await serverHandlers['channel.create'](ctx, { name: 'staff-room', type: 'text', template: 'private' });
  assert.equal(r.verified, true);
  const ch = env.guild.channels.cache.get(r.refs.channel);
  assert.equal(ch.permissionsFor(env.members.john).has('ViewChannel'), false);
  assert.equal(ch.permissionsFor(env.guild.members.me).has('ViewChannel'), true);
  assert.equal(ch.permissionsFor(env.guild.owner).has('ViewChannel'), true);
});

test('read-only channels deny SendMessages to @everyone; announcement type falls back without Community', async () => {
  const env = buildMockGuild();
  const ctx = ctxFor(env, env.guild.ownerId);
  const r = await serverHandlers['channel.create'](ctx, { name: 'announcements', type: 'announcement', template: 'readonly' });
  assert.equal(r.ok, true);
  assert.match(r.message, /Community server/);
  const ch = env.guild.channels.cache.get(r.refs.channel);
  assert.equal(ch.type, ChannelType.GuildText);
  assert.equal(ch.permissionsFor(env.members.john).has('SendMessages'), false);
  assert.equal(ch.permissionsFor(env.members.john).has('ViewChannel'), true);
});

test('hiding a channel from @everyone never locks the bot out', async () => {
  const env = buildMockGuild({ botPermissions: ['ManageChannels', 'ManageRoles', 'ViewChannel', 'SendMessages'] });
  const ctx = ctxFor(env, env.guild.ownerId);
  const r = await serverHandlers['channel.permit'](ctx, { channelId: env.channels.staff.id, targetId: env.guild.id, targetKind: 'role', targetLabel: '@everyone', template: 'deny' });
  assert.equal(r.verified, true);
  assert.equal(env.channels.staff.permissionsFor(env.guild.members.me).has('ViewChannel'), true);
  assert.equal(env.channels.staff.permissionsFor(env.members.john).has('ViewChannel'), false);
});

test('privilege escalation: non-owners cannot grant permissions they lack', async () => {
  const env = buildMockGuild();
  const ctx = ctxFor(env, env.members.mod.id); // Moderators: no ManageChannels
  const r = await serverHandlers['channel.permit'](ctx, { channelId: env.channels.general.id, targetId: env.roles.gaming.id, targetKind: 'role', targetLabel: '@Gaming', template: 'manage' });
  assert.equal(r.ok, false);
  assert.match(r.message, /do not have/);
  const r2 = await serverHandlers['role.create'](ctx, { name: 'Mods2', template: 'moderator', hoist: false, mentionable: false });
  assert.equal(r2.ok, false);
});

test('role assignment checks hierarchy, refuses managed roles, and verifies final state', async () => {
  const env = buildMockGuild();
  const ctx = ctxFor(env, env.guild.ownerId);
  const ok = await serverHandlers['role.assign'](ctx, { roleId: env.roles.gaming.id, memberId: env.members.john.id });
  assert.equal(ok.verified, true);
  assert.ok(env.members.john.roles.cache.has(env.roles.gaming.id));
  const high = await serverHandlers['role.assign'](ctx, { roleId: env.roles.admins.id, memberId: env.members.john.id });
  assert.equal(high.ok, false);
  assert.match(high.message, /above my highest role/);
  const managed = env.guild.addRole({ name: 'Booster', position: 3, managed: true });
  assert.equal((await serverHandlers['role.assign'](ctx, { roleId: managed.id, memberId: env.members.john.id })).ok, false);
  const removed = await serverHandlers['role.remove'](ctx, { roleId: env.roles.gaming.id, memberId: env.members.john.id });
  assert.equal(removed.verified, true);
});

test('role.create never yields Administrator and is verified', async () => {
  const env = buildMockGuild();
  const ctx = ctxFor(env, env.guild.ownerId);
  const r = await serverHandlers['role.create'](ctx, { name: 'Research Team', template: 'basic', hoist: true, mentionable: false });
  assert.equal(r.verified, true);
  const role = env.guild.roles.cache.get(r.refs.role);
  assert.equal(role.permissions.has('Administrator'), false);
  assert.equal(role.permissions.has('SendMessages'), true);
});

test('Discord API failures and missing resources are reported, not thrown away', async () => {
  const env = buildMockGuild();
  const coord = coordinatorFor({ db: memDb(), config: testConfig({ ownerId: env.guild.ownerId }), guild: env.guild });
  env.guild.failNext('channels.create');
  const r = await coord.handleSteps({ requestId: rid(), guildId: env.guild.id, userId: env.guild.ownerId, source: 'slash' }, [{ action: 'channel.create', params: { name: 'boom' } }]);
  assert.equal(r.status, 'failed');
  assert.match(r.results[0].message, /missing permissions/i);
  const r2 = await serverHandlers['channel.rename'](ctxFor(env, env.guild.ownerId), { channelId: '999999999999999999', name: 'x' });
  assert.equal(r2.ok, false);
});

test('bulk role assignment needs approval, then applies only to the source role and skips bots', async () => {
  const env = buildMockGuild();
  const members = env.guild.addRole({ name: 'Members', position: 2 });
  env.members.john.roles.cache.set(members.id, members);
  env.members.bob.roles.cache.set(members.id, members);
  env.members.otherBot.roles.cache.set(members.id, members);
  const db = memDb();
  const coord = coordinatorFor({ db, config: testConfig({ ownerId: env.guild.ownerId }), guild: env.guild });
  const res = await coord.handleText({ requestId: rid(), guildId: env.guild.id, userId: env.guild.ownerId, source: 'text', text: 'ALPHA, give the Gaming role to everyone with the Members role' });
  assert.equal(res.status, 'awaiting_approval');
  const done = await coord.decide({ approvalId: res.approval.id, userId: env.guild.ownerId, approve: true });
  assert.equal(done.status, 'executed', JSON.stringify(done));
  assert.ok(env.members.john.roles.cache.has(env.roles.gaming.id));
  assert.ok(env.members.bob.roles.cache.has(env.roles.gaming.id));
  assert.ok(!env.members.otherBot.roles.cache.has(env.roles.gaming.id));
  assert.ok(!env.members.mod.roles.cache.has(env.roles.gaming.id));
});

test('announcements never ping unless explicitly requested and permitted', async () => {
  const env = buildMockGuild();
  const ctx = ctxFor(env, env.guild.ownerId);
  await serverHandlers['announce.send'](ctx, { channelId: env.channels.general.id, message: 'hello @everyone', pingEveryone: false });
  assert.deepEqual(env.channels.general.messages[0].allowedMentions, { parse: [] });
});
