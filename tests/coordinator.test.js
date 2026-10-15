import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMockGuild } from './mocks/discord.js';
import { testConfig, memDb, fileDb, coordinatorFor, rid } from './helpers.js';
import { claimTask, completeTask } from '../core/taskQueue.js';
import { knightHandlers } from '../features/moderation/handlers.js';
import { getGuildSettings } from '../core/settings.js';
import { sanitizePlan } from '../ai/index.js';

function setup(extra = {}) {
  const env = buildMockGuild();
  const config = testConfig({ ownerId: env.guild.ownerId, ...extra });
  const db = memDb();
  const coord = coordinatorFor({ db, config, guild: env.guild });
  const req = (o = {}) => ({ requestId: rid(), guildId: env.guild.id, channelId: env.channels.alpha.id, userId: env.guild.ownerId, source: 'text', ...o });
  return { ...env, config, db, coord, req };
}

test('owner authentication: non-owner natural-language requests are rejected and audited', async () => {
  const { coord, req, members, db, guild } = setup();
  const res = await coord.handleText(req({ userId: members.boss.id, text: 'ALPHA, create a gaming channel' }));
  assert.equal(res.status, 'rejected');
  assert.equal(guild.channels.cache.find((c) => c.name === 'gaming'), undefined, 'no channel was created');
  const row = db.get(`SELECT * FROM audit_log WHERE action = 'alpha.denied'`);
  assert.equal(row.actor_id, members.boss.id);
});

test('owner text command executes a real (mock) Discord operation and verifies it', async () => {
  const { coord, req, guild } = setup();
  const res = await coord.handleText(req({ text: 'ALPHA, create a gaming channel' }));
  assert.equal(res.status, 'executed', JSON.stringify(res));
  assert.equal(res.results[0].verified, true);
  assert.ok(guild.channels.cache.find((c) => c.name === 'gaming'));
});

test('compound command: "that channel" resolves to the channel created by the previous step', async () => {
  const { coord, req, guild, roles } = setup();
  const res = await coord.handleText(req({ text: 'ALPHA, create a gaming channel and give the Gaming role access to it' }));
  assert.equal(res.status, 'executed', JSON.stringify(res));
  const ch = guild.channels.cache.find((c) => c.name === 'gaming');
  const ow = ch.permissionOverwrites.cache.get(roles.gaming.id);
  assert.ok(ow.allow.has('ViewChannel') && ow.allow.has('SendMessages'));
  // A later instruction can refer to "that channel" again.
  const res2 = await coord.handleText(req({ text: 'ALPHA, give the Research role read-only access to that channel' }));
  assert.equal(res2.status, 'executed', JSON.stringify(res2));
  assert.ok(ch.permissionOverwrites.cache.get(roles.research.id).deny.has('SendMessages'));
});

test('a later step can use the name of an entity an earlier step creates', async () => {
  const { coord, req, guild, members } = setup();
  const res = await coord.handleText(req({ text: 'ALPHA, create an Analysts role and give John the Analysts role' }));
  assert.equal(res.status, 'executed', JSON.stringify(res));
  const role = guild.roles.cache.find((r) => r.name === 'Analysts');
  assert.ok(members.john.roles.cache.has(role.id));
});

test('slash commands enforce per-action authority', async () => {
  const { coord, req, members, guild } = setup();
  const r = await coord.handleSteps(req({ userId: members.john.id, member: members.john, source: 'slash' }), [{ action: 'channel.create', params: { name: 'nope' } }]);
  assert.equal(r.status, 'rejected');
  assert.equal(guild.channels.cache.find((c) => c.name === 'nope'), undefined);
  const ok = await coord.handleSteps(req({ userId: members.boss.id, member: members.boss, source: 'slash' }), [{ action: 'channel.create', params: { name: 'yes' } }]);
  assert.equal(ok.status, 'executed');
});

test('sensitive operations require confirmation; wrong user, expiry and duplicates are rejected', async () => {
  const { coord, req, guild, channels, members, db } = setup();
  const res = await coord.handleText(req({ text: 'ALPHA, delete the staff channel' }));
  assert.equal(res.status, 'awaiting_approval');
  assert.match(res.summary, /DELETE channel #staff/);
  assert.ok(guild.channels.cache.has(channels.staff.id), 'not deleted before approval');

  const wrong = await coord.decide({ approvalId: res.approval.id, userId: members.boss.id, approve: true });
  assert.equal(wrong.reason, 'unauthorized');
  assert.ok(guild.channels.cache.has(channels.staff.id));

  const done = await coord.decide({ approvalId: res.approval.id, userId: guild.ownerId, approve: true });
  assert.equal(done.status, 'executed', JSON.stringify(done));
  assert.ok(!guild.channels.cache.has(channels.staff.id));

  const dup = await coord.decide({ approvalId: res.approval.id, userId: guild.ownerId, approve: true });
  assert.equal(dup.reason, 'already_decided');

  // Expired approvals cannot be used.
  const res2 = await coord.handleText(req({ text: 'ALPHA, delete the general channel' }));
  db.run('UPDATE approvals SET expires_at = ? WHERE id = ?', Date.now() - 1, res2.approval.id);
  const exp = await coord.decide({ approvalId: res2.approval.id, userId: guild.ownerId, approve: true });
  assert.equal(exp.reason, 'expired');
  assert.ok(guild.channels.cache.has(channels.general.id));
  assert.equal(db.get('SELECT status FROM approvals WHERE id = ?', res2.approval.id).status, 'expired');
});

test('approval is aborted if the target changed after it was requested', async () => {
  const { coord, req, guild } = setup();
  const res = await coord.handleText(req({ text: 'ALPHA, delete the staff channel' }));
  // Original channel removed and a new one with the same name created.
  const old = guild.channels.cache.find((c) => c.name === 'staff');
  guild.channels.cache.delete(old.id);
  guild.addChannel({ name: 'staff' });
  const r = await coord.decide({ approvalId: res.approval.id, userId: guild.ownerId, approve: true });
  assert.equal(r.status, 'error');
  assert.match(r.message, /targets changed/);
  assert.ok(guild.channels.cache.find((c) => c.name === 'staff'), 'new channel untouched');
});

test('opening a channel to @everyone is classified critical and needs confirmation', async () => {
  const { coord, req } = setup();
  const res = await coord.handleText(req({ text: 'ALPHA, give everyone access to staff' }));
  assert.equal(res.status, 'awaiting_approval');
  assert.equal(res.risk, 'critical');
  assert.ok(res.warnings.some((w) => /public/.test(w)));
});

test('voice-requested ban is critical; medium voice actions need confirmation by default', async () => {
  const { coord, req, members, db, guild } = setup();
  const ban = await coord.handleText(req({ source: 'voice', text: 'ALPHA, ban Bob for raiding' }));
  assert.equal(ban.status, 'awaiting_approval');
  assert.equal(ban.risk, 'critical');
  const to = await coord.handleText(req({ source: 'voice', text: 'ALPHA, timeout Bob for five minutes' }));
  assert.equal(to.status, 'awaiting_approval');
  assert.equal(getGuildSettings(db, guild.id).alpha.confirmMediumFromVoice, true);
  assert.ok(members.bob.communicationDisabledUntilTimestamp == null);
});

test('cross-bot routing: AEGIS enqueues a moderation step that KNIGHT executes via the shared queue', async () => {
  const env = buildMockGuild();
  const config = testConfig({ ownerId: env.guild.ownerId });
  const { db, file } = fileDb();
  const aegis = coordinatorFor({ db, config, guild: env.guild, bot: 'aegis', crossBotTimeoutMs: 5000 });
  // KNIGHT runs in "another process": separate DB connection to the same file.
  const knightDb = (await import('../database/db.js')).openDatabase(file);
  const getGuildSettingsK = (await import('../core/settings.js')).getGuildSettings;
  const worker = setInterval(async () => {
    const task = claimTask(knightDb, 'knight', 'knight:test');
    if (!task) return;
    const result = await knightHandlers[task.action]({ db: knightDb, config, logger: console, bot: 'knight', guild: env.guild, settings: getGuildSettingsK(knightDb, env.guild.id), request: task.context }, task.params);
    completeTask(knightDb, task.id, 'knight:test', result);
  }, 50);
  try {
    const res = await aegis.handleText({ requestId: rid(), guildId: env.guild.id, channelId: env.channels.alpha.id, userId: env.guild.ownerId, source: 'text', text: 'ALPHA, timeout Bob for five minutes' });
    assert.equal(res.status, 'executed', JSON.stringify(res));
    assert.ok(env.members.bob.communicationDisabledUntilTimestamp > Date.now() + 4 * 60000);
    const task = db.get('SELECT * FROM tasks');
    assert.equal(task.target_bot, 'knight');
    assert.equal(task.status, 'done');
    const kase = db.get('SELECT * FROM mod_cases');
    assert.equal(kase.action, 'timeout');
    assert.equal(kase.result, 'success');
    // "that member" now refers to Bob.
    const res2 = await aegis.handleText({ requestId: rid(), guildId: env.guild.id, channelId: env.channels.alpha.id, userId: env.guild.ownerId, source: 'text', text: 'ALPHA, warn that member for spamming' });
    assert.equal(res2.status, 'executed', JSON.stringify(res2));
    assert.equal(env.members.bob.dms.length, 1);
  } finally {
    clearInterval(worker);
    knightDb.close();
    db.close();
  }
});

test('the same request delivered twice executes once', async () => {
  const { coord, req, guild } = setup();
  const r = req({ text: 'ALPHA, create a dupe channel' });
  const a = await coord.handleText(r);
  const b = await coord.handleText(r);
  assert.equal(a.status, 'executed');
  assert.equal(b.status, 'duplicate');
  assert.equal(guild.channels.cache.filter((c) => c.name === 'dupe').size, 1);
});

test('ambiguous references are not guessed', async () => {
  const { coord, req, guild } = setup();
  guild.addChannel({ name: 'gaming-1' });
  guild.addChannel({ name: 'gaming-2' });
  const r = await coord.handleText(req({ text: 'ALPHA, delete the gaming channel' }));
  assert.equal(r.status, 'clarify');
  assert.match(r.message, /several channels/);
});

test('works without hosted AI; AI output is validated and cannot introduce unknown actions', async () => {
  const { coord, req } = setup();
  const r = await coord.handleText(req({ text: 'ALPHA, do a barrel roll' }));
  assert.equal(r.status, 'clarify');
  assert.equal(sanitizePlan({ steps: [{ action: 'shell.exec', params: { cmd: 'rm -rf /' } }] }), null);
  assert.equal(sanitizePlan({ steps: [{ action: 'channel.create', params: { name: 'x', permissions: 'Administrator' } }] }).steps[0].params.permissions, undefined);
  assert.equal(sanitizePlan({ steps: [{ action: 'mod.timeout', params: { member: 'x', durationMs: 'forever' } }] }), null);
});

test('AI fallback is used only when deterministic parsing fails, and still goes through validation and approval', async () => {
  const env = buildMockGuild();
  const config = testConfig({ ownerId: env.guild.ownerId });
  const db = memDb();
  const fakeAI = { available: () => true, planCommand: async () => ({ steps: [{ action: 'channel.delete', params: { channel: 'staff' } }] }) };
  const coord = coordinatorFor({ db, config, guild: env.guild, ai: fakeAI });
  const r = await coord.handleText({ requestId: rid(), guildId: env.guild.id, userId: env.guild.ownerId, source: 'text', text: 'ALPHA, get rid of the staff room' });
  assert.equal(r.status, 'awaiting_approval', 'AI cannot bypass confirmation');
  assert.ok(env.guild.channels.cache.find((c) => c.name === 'staff'));
});

test('/play executes in one step — no confirmation or clarification, even from an uncertain voice transcript', async () => {
  const env = buildMockGuild();
  const config = testConfig({ ownerId: env.guild.ownerId });
  const calls = [];
  const handlers = new Map([['music.play', async (_ctx, p) => (calls.push(p.query), { ok: true, message: `▶️ Now playing ${p.query}` })]]);
  const coord = coordinatorFor({ db: memDb(), config, guild: env.guild, handlers });
  const base = { guildId: env.guild.id, channelId: env.channels.general.id, userId: env.members.john.id };
  const slash = await coord.handleSteps({ ...base, requestId: rid(), source: 'slash' }, [{ action: 'music.play', params: { query: 'Slow Motion From Bharat' } }]);
  const voice = await coord.handleSteps({ ...base, requestId: rid(), userId: env.guild.ownerId, source: 'voice', forceConfirm: true }, [{ action: 'music.play', params: { query: 'Slow Motion From Bharat' } }]);
  assert.deepEqual([slash.status, voice.status], ['executed', 'executed']);
  assert.deepEqual(calls, ['Slow Motion From Bharat', 'Slow Motion From Bharat'], 'the exact query reaches the handler');
});
