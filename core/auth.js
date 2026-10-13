// Identity and authorisation. The wake word is never treated as
// authentication: every decision here is based on the Discord user ID that
// Discord itself attached to the interaction, message or voice stream, and
// on the settings of the server where the request happens.

export const AUTH = Object.freeze({ MEMBER: 0, MODERATOR: 1, ADMIN: 2, TRUSTED: 3, OWNER: 4 });
export const AUTH_NAMES = Object.fromEntries(Object.entries(AUTH).map(([k, v]) => [v, k]));

/** Global operator access (OWNER_ID / TRUSTED_USER_IDS) only when explicitly enabled. */
function operatorLevel(userId, config) {
  if (!config.operatorGlobalAccess) return null;
  if (config.ownerId && userId === config.ownerId) return AUTH.OWNER;
  if (config.trustedUserIds?.includes(userId)) return AUTH.TRUSTED;
  return null;
}

/**
 * @param {object} p
 * @param {string} p.userId Discord user id
 * @param {{ownerId:string, trustedUserIds:string[], operatorGlobalAccess:boolean}} p.config
 * @param {object|null} [p.member] GuildMember (roles + permissions)
 * @param {{ownerId?:string}|null} [p.guild]
 * @param {{alpha?:{trustedUserIds?:string[], trustedRoleIds?:string[]}}|null} [p.settings] this server's settings
 */
export function authLevel({ userId, config, member = null, guild = null, settings = null }) {
  if (!userId) return AUTH.MEMBER;
  const op = operatorLevel(userId, config);
  if (op != null) return op;
  if (guild?.ownerId && userId === guild.ownerId) return AUTH.OWNER;
  const alpha = settings?.alpha;
  if (alpha?.trustedUserIds?.includes(userId)) return AUTH.TRUSTED;
  if (alpha?.trustedRoleIds?.length && alpha.trustedRoleIds.some((r) => member?.roles?.cache?.has(r))) return AUTH.TRUSTED;
  const perms = member?.permissions;
  if (perms?.has?.('Administrator') || perms?.has?.('ManageGuild')) return AUTH.ADMIN;
  if (perms?.has?.('ModerateMembers') || perms?.has?.('KickMembers') || perms?.has?.('BanMembers')) return AUTH.MODERATOR;
  return AUTH.MEMBER;
}

/**
 * ALPHA natural-language / voice control: the server owner and the users or
 * roles that server has explicitly trusted (plus the operator if enabled).
 */
export function canUseAlpha(userId, config, ctx = {}) {
  return authLevel({ userId, config, ...ctx }) >= AUTH.TRUSTED;
}

export function isOperator(userId, config) {
  return Boolean(config.ownerId) && userId === config.ownerId;
}

/** Highest authority in a given server: its owner (or the operator if global access is enabled). */
export function isServerSupreme(userId, guild, config) {
  if (!userId) return false;
  if (guild?.ownerId && userId === guild.ownerId) return true;
  return Boolean(config.operatorGlobalAccess && isOperator(userId, config));
}
