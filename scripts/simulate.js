// OFFLINE SIMULATION — runs the real ALPHA pipeline end to end against a
// MOCK Discord guild and SCRIPTED (mock) voice transcripts. Nothing here
// talks to Discord or a speech service; it demonstrates the logic only.
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { openDatabase } from '../database/db.js';
import { getConfig } from '../config/env.js';
import { AlphaCoordinator } from '../core/coordinator.js';
import { claimTask, completeTask } from '../core/taskQueue.js';
import { getGuildSettings, setGuildSetting } from '../core/settings.js';
import { memoryLogger } from '../core/logger.js';
import { knightHandlers } from '../features/moderation/handlers.js';
import { serverHandlers } from '../features/server/handlers.js';
import { systemHandlers } from '../apps/shared/systemHandlers.js';
import { VoicePipeline } from '../features/voice/pipeline.js';
import { MockSTT } from '../features/voice/stt.js';
import { pcmToWav } from '../features/voice/audio.js';
import { AutoModerator } from '../features/moderation/automod.js';
import { buildMockGuild } from '../tests/mocks/discord.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-sim-'));
const file = path.join(dir, 'sim.db');
const env = buildMockGuild();
const { guild } = env;
const config = { ...getConfig({ TIMEZONE: 'Asia/Kolkata', AI_PROVIDER: 'none', STT_PROVIDER: 'mock' }), ownerId: guild.ownerId };
const aegisDb = openDatabase(file);
const knightDb = openDatabase(file); // separate connection = separate "process"
setGuildSetting(aegisDb, guild.id, 'channels.modLog', env.channels.staff.id);

const mk = (db, bot, handlers) =>
  new AlphaCoordinator({ db, config, bot, logger: memoryLogger(), handlers: new Map(Object.entries({ ...systemHandlers({}), ...handlers })), getGuild: async () => guild, crossBotTimeoutMs: 5000 });
const aegis = mk(aegisDb, 'aegis', serverHandlers);
const knight = mk(knightDb, 'knight', knightHandlers);

// KNIGHT's task worker (would run in the KNIGHT process).
const worker = setInterval(async () => {
  const t = claimTask(knightDb, 'knight', 'knight-sim');
  if (!t) return;
  const res = await knightHandlers[t.action]({ db: knightDb, config, logger: memoryLogger(), bot: 'knight', guild, settings: getGuildSettings(knightDb, guild.id), request: t.context }, t.params);
  completeTask(knightDb, t.id, 'knight-sim', res);
}, 50);

const line = (s = '') => console.log(s);
const show = (label, res) => {
  line(`\n▶ ${label}`);
  if (res.status === 'awaiting_approval') line(`  ⏸  CONFIRMATION REQUIRED (${res.risk}) — ${res.summary.replace(/\n/g, ' | ')}${res.warnings.length ? `\n     warnings: ${res.warnings.join(' ')}` : ''}`);
  else if (res.results) for (const r of res.results) line(`  ${r.ok === true ? '✅' : r.ok === false ? '❌' : '⏳'} [${r.action}] ${r.message ?? ''}`);
  else line(`  ↪ ${res.status}: ${res.message}`);
};
const req = (text, o = {}) => ({ requestId: `sim:${Math.random()}`, guildId: guild.id, channelId: env.channels.alpha.id, userId: guild.ownerId, source: 'text', text, ...o });

line('════════════════════════════════════════════════════════════════');
line(' SOUL SOCIETY — OFFLINE SIMULATION (MOCK guild, MOCK transcripts)');
line(' Not a live Discord test. Demonstrates the ALPHA pipeline logic.');
line('════════════════════════════════════════════════════════════════');

show('Owner types: ALPHA, create a gaming channel and give the Gaming role access to it', await aegis.handleText(req('ALPHA, create a gaming channel and give the Gaming role access to it')));
show('Owner types: ALPHA, create a read-only announcement channel', await aegis.handleText(req('ALPHA, create a read-only announcement channel')));
show('Owner types: ALPHA, create a Research role (one already exists)', await aegis.handleText(req('ALPHA, create a Research role')));
show('Owner types: ALPHA, create an Analysts role and give John the Analysts role', await aegis.handleText(req('ALPHA, create an Analysts role and give John the Analysts role')));
show('Non-owner (Boss, an admin) types: ALPHA, delete the general channel', await aegis.handleText(req('ALPHA, delete the general channel', { userId: env.members.boss.id })));

// Voice path with scripted transcripts.
const stt = new MockSTT([
  'what should we play tonight', // no wake word → ignored
  'Alpha, timeout Bob for five minutes',
  'Alpha, ban that member',
]);
const voice = new VoicePipeline({ stt, config, handleCommand: (r) => aegis.handleText(r) });
const wav = pcmToWav(Buffer.alloc(32000));
const speak = async (userId, label) => {
  const r = await voice.handleUtterance({ guildId: guild.id, channelId: env.channels.alpha.id, userId, wav, durationMs: 1500, rms: 0.1 });
  if (r.result) show(`🎙 [MOCK STT] ${label} → "${r.command}"`, r.result);
  else line(`\n▶ 🎙 [MOCK STT] ${label} → ignored (${r.reason})`);
  return r;
};
await speak(env.members.john.id, 'John (not owner) speaks');
await speak(guild.ownerId, 'Owner chats without wake word');
const to = await speak(guild.ownerId, 'Owner says "Alpha, timeout Bob for five minutes"');
if (to.result?.status === 'awaiting_approval') {
  show('Owner taps Approve', await aegis.decide({ approvalId: to.result.approval.id, userId: guild.ownerId, approve: true }));
}
const ban = await speak(guild.ownerId, 'Owner says "Alpha, ban that member"');
if (ban.result?.status === 'awaiting_approval') {
  show('Someone else taps Approve', await aegis.decide({ approvalId: ban.result.approval.id, userId: env.members.boss.id, approve: true }));
  show('Owner taps Cancel', await aegis.decide({ approvalId: ban.result.approval.id, userId: guild.ownerId, approve: false }));
}

// Automod in default simulation mode.
const auto = new AutoModerator({ db: knightDb, config, logger: memoryLogger() });
const m = await auto.onMessage({ id: 'x1', guild, author: env.members.john.user, member: env.members.john, channelId: env.channels.general.id, channel: env.channels.general, content: 'this is sh1t', mentions: { users: { size: 0 } }, delete: async () => {} });
line(`\n▶ KNIGHT automod sees "this is sh1t" from John → ${m.rule} → ${m.result.message}`);
auto.stop();

show('Owner: ALPHA, moderation report for today', await knight.handleText(req('ALPHA, moderation report for today')));

line('\n──────────────── Final MOCK guild state ────────────────');
line(`Channels: ${[...guild.channels.cache.values()].map((c) => `#${c.name}`).join(' ')}`);
line(`Roles: ${[...guild.roles.cache.values()].map((r) => (r.name.startsWith('@') ? r.name : `@${r.name}`)).join(' ')}`);
line(`Bob timed out until: ${env.members.bob.communicationDisabledUntilTimestamp ? new Date(env.members.bob.communicationDisabledUntilTimestamp).toISOString() : 'not timed out'}`);
line(`Bob banned: ${guild.bans.cache.has(env.members.bob.id)}`);
line(`Audit entries: ${aegisDb.get('SELECT COUNT(*) AS n FROM audit_log').n} · Cross-bot tasks: ${aegisDb.get('SELECT COUNT(*) AS n FROM tasks').n} · Mod cases: ${aegisDb.get('SELECT COUNT(*) AS n FROM mod_cases').n}`);
clearInterval(worker);
aegisDb.close();
knightDb.close();
fs.rmSync(dir, { recursive: true, force: true });
