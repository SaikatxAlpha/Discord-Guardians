// Identity and authorisation. The wake word is never treated as
// authentication: every decision here is based on the Discord user ID that
// Discord itself attached to the interaction, message or voice stream.

export const AUTH = Object.freeze({ MEMBER: 0, MODERATOR: 1, ADMIN: 2, TRUSTED: 3, OWNER: 4 });
export const AUTH_NAMES = Object.fromEntries(Object.entries(AUTH).map(([k, v]) => [v, k]));

/**
 * @param {object} p
 * @param {string} p.userId Discord user id
 * @param {{ownerId:string, trustedUserIds:string[]}} p.config
 * @param {{permissions?: {has:(perm:string)=>boolean}}|null} [p.member] guild member (optional)
 */
export function authLevel({ userId, config, member = null }) {
  if (!userId) return AUTH.MEMBER;
  if (config.ownerId && userId === config.ownerId) return AUTH.OWNER;
  if (config.trustedUserIds?.includes(userId)) return AUTH.TRUSTED;
  const perms = member?.permissions;
  if (perms?.has?.('Administrator') || perms?.has?.('ManageGuild')) return AUTH.ADMIN;
  if (perms?.has?.('ModerateMembers') || perms?.has?.('KickMembers') || perms?.has?.('BanMembers')) return AUTH.MODERATOR;
  return AUTH.MEMBER;
}

/** ALPHA natural-language control is limited to the owner and explicitly trusted users. */
export function canUseAlpha(userId, config) {
  return authLevel({ userId, config }) >= AUTH.TRUSTED;
}

export function isOwner(userId, config) {
  return Boolean(config.ownerId) && userId === config.ownerId;
}
