// The complete catalogue of structured actions ALPHA may perform. Execution
// is only possible through these definitions: there is no generic "run code",
// shell, filesystem or SQL action, and an AI-proposed plan is validated here
// exactly like a typed command.
import { AUTH } from '../auth.js';

export const RISK = Object.freeze({ LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 });
export const RISK_NAMES = { 1: 'low', 2: 'medium', 3: 'high', 4: 'critical' };

const ref = (required = true) => ({ type: 'ref', required });
const MAX_TIMEOUT = 28 * 24 * 3600 * 1000;

/** Permission templates for channel overwrites. */
export const PERMISSION_TEMPLATES = {
  access: { allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak'], deny: [] },
  view: { allow: ['ViewChannel', 'ReadMessageHistory'], deny: [] },
  readonly: { allow: ['ViewChannel', 'ReadMessageHistory'], deny: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads'] },
  deny: { allow: [], deny: ['ViewChannel', 'Connect'] },
  mute: { allow: [], deny: ['SendMessages', 'Speak', 'AddReactions'] },
  manage: { allow: ['ViewChannel', 'ManageMessages', 'ManageChannels', 'MuteMembers', 'MoveMembers'], deny: [] },
};

/** Role permission presets. Administrator is never offered. */
export const ROLE_TEMPLATES = {
  none: [],
  basic: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'Connect', 'Speak', 'AddReactions', 'UseApplicationCommands'],
  moderator: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageMessages', 'ModerateMembers', 'MuteMembers', 'MoveMembers'],
};

/** Permissions that indicate a role is privileged; granting such roles is risky. */
export const DANGEROUS_PERMISSIONS = [
  'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'BanMembers', 'KickMembers',
  'ManageWebhooks', 'MentionEveryone', 'ModerateMembers', 'ManageMessages',
];

export const ACTIONS = {
  // ---------------- KNIGHT: protection and enforcement ----------------
  'mod.warn': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: false,
    params: { member: ref(), reason: { type: 'string', maxLength: 400, default: 'No reason given' } },
    risk: () => RISK.LOW,
    describe: (p) => `Warn ${p.memberLabel ?? p.member}: ${p.reason}`,
  },
  'mod.timeout': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: false,
    params: {
      member: ref(),
      durationMs: { type: 'integer', min: 5000, max: MAX_TIMEOUT, default: 10 * 60 * 1000 },
      reason: { type: 'string', maxLength: 400, default: 'No reason given' },
    },
    risk: (p) => (p.durationMs > 24 * 3600 * 1000 ? RISK.HIGH : RISK.MEDIUM),
    describe: (p) => `Timeout ${p.memberLabel ?? p.member} for ${Math.round(p.durationMs / 60000)} min: ${p.reason}`,
  },
  'mod.untimeout': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: true,
    params: { member: ref(), reason: { type: 'string', maxLength: 400, default: 'Timeout lifted' } },
    risk: () => RISK.LOW,
    describe: (p) => `Remove timeout from ${p.memberLabel ?? p.member}`,
  },
  'mod.kick': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: false,
    params: { member: ref(), reason: { type: 'string', maxLength: 400, default: 'No reason given' } },
    risk: () => RISK.HIGH,
    describe: (p) => `KICK ${p.memberLabel ?? p.member}: ${p.reason}`,
  },
  'mod.ban': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: false,
    params: {
      member: ref(),
      reason: { type: 'string', maxLength: 400, default: 'No reason given' },
      deleteMessageSeconds: { type: 'integer', min: 0, max: 604800, default: 0 },
    },
    // A ban requested by voice is always critical: it must be confirmed.
    risk: (_p, req) => (req.source === 'voice' ? RISK.CRITICAL : RISK.HIGH),
    describe: (p) => `BAN ${p.memberLabel ?? p.member}: ${p.reason}`,
  },
  'mod.unban': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: true,
    params: { userId: { type: 'snowflake', required: true }, reason: { type: 'string', maxLength: 400, default: 'Unbanned' } },
    risk: () => RISK.MEDIUM,
    describe: (p) => `Unban user ${p.userId}`,
  },
  'security.lockdown': {
    bot: 'knight', minAuth: AUTH.ADMIN, retryable: true,
    params: { channel: ref(), enable: { type: 'boolean', default: true } },
    risk: () => RISK.HIGH,
    describe: (p) => `${p.enable ? 'Lock' : 'Unlock'} channel ${p.channelLabel ?? p.channel} for @everyone`,
  },
  'report.moderation': {
    bot: 'knight', minAuth: AUTH.MODERATOR, retryable: true,
    params: { period: { type: 'enum', values: ['today', 'week', 'month'], default: 'week' }, channel: ref(false) },
    risk: () => RISK.LOW,
    describe: (p) => `Moderation report (${p.period})`,
  },

  // ---------------- AEGIS: intelligence, administration, automation ----------------
  'channel.create': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: {
      name: { type: 'string', required: true, maxLength: 90, minLength: 1 },
      type: { type: 'enum', values: ['text', 'voice', 'announcement', 'category', 'forum'], default: 'text' },
      template: { type: 'enum', values: ['public', 'readonly', 'private'], default: 'public' },
      category: ref(false),
      topic: { type: 'string', maxLength: 1024 },
    },
    risk: (p) => (p.template === 'private' ? RISK.MEDIUM : RISK.LOW),
    describe: (p) => `Create ${p.template} ${p.type} channel "${p.name}"${p.category ? ` in ${p.category}` : ''}`,
  },
  'channel.rename': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: true,
    params: { channel: ref(), name: { type: 'string', required: true, maxLength: 90, minLength: 1 } },
    risk: () => RISK.LOW,
    describe: (p) => `Rename channel ${p.channelLabel ?? p.channel} to "${p.name}"`,
  },
  'channel.delete': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: { channel: ref() },
    risk: () => RISK.CRITICAL,
    describe: (p) => `DELETE channel ${p.channelLabel ?? p.channel} (irreversible)`,
  },
  'channel.permit': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: true,
    params: {
      channel: ref(),
      target: ref(),
      template: { type: 'enum', values: Object.keys(PERMISSION_TEMPLATES), default: 'access' },
    },
    // Refined after resolution: opening a channel to @everyone or granting
    // manage permissions is critical.
    risk: (p) => (p.template === 'manage' ? RISK.HIGH : RISK.MEDIUM),
    describe: (p) => `Apply "${p.template}" permissions for ${p.targetLabel ?? p.target} in ${p.channelLabel ?? p.channel}`,
  },
  'role.create': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: {
      name: { type: 'string', required: true, maxLength: 100, minLength: 1 },
      color: { type: 'string', pattern: /^#?[0-9a-f]{6}$/i },
      template: { type: 'enum', values: Object.keys(ROLE_TEMPLATES), default: 'none' },
      hoist: { type: 'boolean', default: false },
      mentionable: { type: 'boolean', default: false },
    },
    risk: (p) => (p.template === 'moderator' ? RISK.HIGH : RISK.LOW),
    describe: (p) => `Create role "${p.name}" (${p.template} permissions)`,
  },
  'role.assign': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: true,
    params: { role: ref(), member: ref() },
    risk: () => RISK.MEDIUM,
    describe: (p) => `Give role ${p.roleLabel ?? p.role} to ${p.memberLabel ?? p.member}`,
  },
  'role.remove': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: true,
    params: { role: ref(), member: ref() },
    risk: () => RISK.MEDIUM,
    describe: (p) => `Remove role ${p.roleLabel ?? p.role} from ${p.memberLabel ?? p.member}`,
  },
  'role.bulk_assign': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: { role: ref(), fromRole: ref() },
    risk: () => RISK.CRITICAL,
    describe: (p) => `BULK: give ${p.roleLabel ?? p.role} to every member with ${p.fromRoleLabel ?? p.fromRole}`,
  },
  'role.delete': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: { role: ref() },
    risk: () => RISK.CRITICAL,
    describe: (p) => `DELETE role ${p.roleLabel ?? p.role} (irreversible)`,
  },
  'announce.send': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: {
      channel: ref(),
      message: { type: 'string', required: true, maxLength: 1900 },
      pingEveryone: { type: 'boolean', default: false },
    },
    risk: (p) => (p.pingEveryone ? RISK.HIGH : RISK.LOW),
    describe: (p) => `Announce in ${p.channelLabel ?? p.channel}${p.pingEveryone ? ' (@everyone ping)' : ''}: "${p.message.slice(0, 80)}"`,
  },
  'schedule.message': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: {
      channel: ref(),
      message: { type: 'string', required: true, maxLength: 1900 },
      at: { type: 'integer', min: 0 },
      dailyTime: { type: 'string', pattern: /^\d{1,2}:\d{2}$/ },
    },
    risk: () => RISK.LOW,
    describe: (p) =>
      `Schedule message in ${p.channelLabel ?? p.channel} ${p.dailyTime ? `daily at ${p.dailyTime}` : `at ${new Date(p.at).toISOString()}`}`,
  },
  'reminder.create': {
    bot: 'aegis', minAuth: AUTH.MEMBER, retryable: false,
    params: { message: { type: 'string', required: true, maxLength: 500 }, at: { type: 'integer', required: true, min: 0 }, channel: ref(false) },
    risk: () => RISK.LOW,
    describe: (p) => `Reminder at ${new Date(p.at).toISOString()}: ${p.message}`,
  },
  'research.run': {
    bot: 'aegis', minAuth: AUTH.MEMBER, retryable: true,
    params: {
      query: { type: 'string', required: true, maxLength: 200, minLength: 2 },
      timeframe: { type: 'enum', values: ['today', 'week', 'any'], default: 'today' },
      channel: ref(false),
      maxItems: { type: 'integer', min: 1, max: 10, default: 6 },
    },
    risk: () => RISK.LOW,
    describe: (p) => `Research "${p.query}" (${p.timeframe})${p.channel ? ` → ${p.channelLabel ?? p.channel}` : ''}`,
  },
  'research.schedule': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: { query: { type: 'string', required: true, maxLength: 200 }, channel: ref(), dailyTime: { type: 'string', required: true, pattern: /^\d{1,2}:\d{2}$/ } },
    risk: () => RISK.LOW,
    describe: (p) => `Daily research on "${p.query}" at ${p.dailyTime} → ${p.channelLabel ?? p.channel}`,
  },
  'report.activity': {
    bot: 'aegis', minAuth: AUTH.MODERATOR, retryable: true,
    params: { period: { type: 'enum', values: ['today', 'week'], default: 'today' }, channel: ref(false) },
    risk: () => RISK.LOW,
    describe: (p) => `Server activity report (${p.period})`,
  },
  'event.create': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: {
      name: { type: 'string', required: true, maxLength: 100 },
      startsAt: { type: 'integer', required: true, min: 0 },
      durationMs: { type: 'integer', min: 60000, max: 7 * 86400000, default: 3600000 },
      reward: { type: 'integer', min: 0, max: 10000, default: 100 },
      description: { type: 'string', maxLength: 1000 },
      channel: ref(false),
    },
    risk: () => RISK.LOW,
    describe: (p) => `Create event "${p.name}" at ${new Date(p.startsAt).toISOString()} (reward ${p.reward} aura)`,
  },
  'economy.grant': {
    bot: 'aegis', minAuth: AUTH.ADMIN, retryable: false,
    params: { member: ref(), amount: { type: 'integer', required: true, min: -100000, max: 100000 }, reason: { type: 'string', required: true, maxLength: 200 } },
    risk: (p) => (Math.abs(p.amount) > 5000 ? RISK.HIGH : RISK.MEDIUM),
    describe: (p) => `${p.amount >= 0 ? 'Grant' : 'Revoke'} ${Math.abs(p.amount)} aura ${p.amount >= 0 ? 'to' : 'from'} ${p.memberLabel ?? p.member}: ${p.reason}`,
  },
  'music.play': {
    bot: 'aegis', minAuth: AUTH.MEMBER, retryable: false,
    params: { query: { type: 'string', required: true, maxLength: 200 } },
    risk: () => RISK.LOW,
    describe: (p) => `Play "${p.query}"`,
  },
  'music.skip': { bot: 'aegis', minAuth: AUTH.MEMBER, retryable: false, params: {}, risk: () => RISK.LOW, describe: () => 'Skip track' },
  'music.pause': { bot: 'aegis', minAuth: AUTH.MEMBER, retryable: false, params: {}, risk: () => RISK.LOW, describe: () => 'Pause music' },
  'music.resume': { bot: 'aegis', minAuth: AUTH.MEMBER, retryable: false, params: {}, risk: () => RISK.LOW, describe: () => 'Resume music' },
  'music.stop': { bot: 'aegis', minAuth: AUTH.MEMBER, retryable: false, params: {}, risk: () => RISK.LOW, describe: () => 'Stop music and clear queue' },
  'music.queue': { bot: 'aegis', minAuth: AUTH.MEMBER, retryable: true, params: {}, risk: () => RISK.LOW, describe: () => 'Show queue' },
  'music.nowplaying': { bot: 'aegis', minAuth: AUTH.MEMBER, retryable: true, params: {}, risk: () => RISK.LOW, describe: () => 'Show current track' },
  'voice.stop_listening': { bot: 'aegis', minAuth: AUTH.TRUSTED, retryable: true, params: {}, risk: () => RISK.LOW, describe: () => 'Stop listening for ALPHA' },
  'system.status': { bot: 'any', minAuth: AUTH.MODERATOR, retryable: true, params: {}, risk: () => RISK.LOW, describe: () => 'System health status' },
  'system.help': { bot: 'any', minAuth: AUTH.MEMBER, retryable: true, params: {}, risk: () => RISK.LOW, describe: () => 'Show what ALPHA can do' },
};

export function getAction(name) {
  return Object.hasOwn(ACTIONS, name) ? ACTIONS[name] : null;
}

/** Compact catalogue for the optional AI interpreter (names and params only). */
export function actionCatalogue() {
  return Object.entries(ACTIONS).map(([name, a]) => ({
    action: name,
    params: Object.fromEntries(
      Object.entries(a.params).map(([k, s]) => [k, `${s.type}${s.values ? `(${s.values.join('|')})` : ''}${s.required ? '' : '?'}`]),
    ),
  }));
}
