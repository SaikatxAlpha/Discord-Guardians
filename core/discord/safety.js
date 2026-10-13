// Safety checks performed before every real Discord action: permissions,
// role hierarchy, self-moderation, owner protection and bot-loop prevention.
import { DANGEROUS_PERMISSIONS } from '../actions/registry.js';

const ACTION_PERMS = {
  warn: null,
  timeout: 'ModerateMembers',
  untimeout: 'ModerateMembers',
  kick: 'KickMembers',
  ban: 'BanMembers',
};

const highest = (member) => member?.roles?.highest?.position ?? 0;

/**
 * @param {object} p
 * @param {'warn'|'timeout'|'untimeout'|'kick'|'ban'} p.action
 * @param {object} p.guild
 * @param {object} p.target GuildMember
 * @param {object} p.botMember the executing bot's GuildMember
 * @param {object|null} p.actor the requesting GuildMember (null for automod)
 * @param {{ownerId:string}} p.config
 * @param {{protectedRoleIds:string[]}} p.moderation guild moderation settings
 * @param {boolean} [p.automatic] true for automod
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
export function checkModeration({ action, guild, target, botMember, actor, config, moderation, automatic = false }) {
  if (!target) return { ok: false, reason: 'Target member is not in this server.' };
  if (target.id === botMember.id) return { ok: false, reason: 'I will not moderate myself.' };
  if (actor && target.id === actor.id) return { ok: false, reason: 'You cannot moderate yourself.' };
  if (target.id === guild.ownerId) return { ok: false, reason: 'The server owner cannot be moderated.' };
  if (config.ownerId && target.id === config.ownerId) return { ok: false, reason: 'The Soul Society owner is protected.' };
  if (target.user?.bot && (automatic || !actor || actor.id !== config.ownerId)) {
    return { ok: false, reason: 'Bots are not moderated automatically (prevents bot-to-bot loops).' };
  }
  const protectedIds = moderation?.protectedRoleIds ?? [];
  if (protectedIds.some((id) => target.roles?.cache?.has(id))) return { ok: false, reason: 'Target has a protected role.' };

  const perm = ACTION_PERMS[action];
  if (perm && !botMember.permissions?.has(perm)) return { ok: false, reason: `I am missing the ${perm} permission.` };
  if (action !== 'warn' && highest(target) >= highest(botMember)) {
    return { ok: false, reason: "Target's highest role is at or above mine; move my role higher." };
  }
  const actorIsOwner = actor && (actor.id === guild.ownerId || actor.id === config.ownerId);
  if (actor && !actorIsOwner && highest(target) >= highest(actor)) {
    return { ok: false, reason: "Target's highest role is at or above yours." };
  }
  if ((action === 'timeout' || action === 'untimeout') && target.permissions?.has('Administrator')) {
    return { ok: false, reason: 'Discord does not allow timing out administrators.' };
  }
  return { ok: true };
}

/** Does this role carry privileged permissions? */
export function dangerousPermissionsOf(role) {
  if (!role?.permissions?.has) return [];
  return DANGEROUS_PERMISSIONS.filter((p) => role.permissions.has(p));
}

/** Can `botMember` (and the actor) manage `role` given hierarchy? */
export function checkRoleManageable({ role, botMember, actor, guild, config }) {
  if (role.managed) return { ok: false, reason: `@${role.name} is managed by an integration and cannot be assigned.` };
  if (role.id === guild.id) return { ok: false, reason: '@everyone cannot be assigned.' };
  if (!botMember.permissions?.has('ManageRoles')) return { ok: false, reason: 'I am missing the Manage Roles permission.' };
  if (role.position >= highest(botMember)) return { ok: false, reason: `@${role.name} is at or above my highest role.` };
  const actorIsOwner = actor && (actor.id === guild.ownerId || actor.id === config.ownerId);
  if (actor && !actorIsOwner && role.position >= highest(actor)) return { ok: false, reason: `@${role.name} is at or above your highest role.` };
  return { ok: true };
}
