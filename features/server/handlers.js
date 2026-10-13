// AEGIS server administration: channels, roles, permission overwrites and
// announcements. Each handler re-validates against live Discord state,
// prevents privilege escalation and verifies the final state.
import { ChannelType, PermissionsBitField } from 'discord.js';
import { PERMISSION_TEMPLATES, ROLE_TEMPLATES } from '../../core/actions/registry.js';
import { checkRoleManageable } from '../../core/discord/safety.js';
import { normName } from '../../core/discord/resolve.js';
import { createJob } from '../../core/scheduler.js';

const TYPE_MAP = {
  text: ChannelType.GuildText,
  voice: ChannelType.GuildVoice,
  announcement: ChannelType.GuildAnnouncement,
  category: ChannelType.GuildCategory,
  forum: ChannelType.GuildForum,
};

const isSystemOwner = (ctx, member) => member && (member.id === ctx.config.ownerId || member.id === ctx.guild.ownerId);

async function actorOf(ctx) {
  return ctx.request.userId ? ctx.guild.members.fetch(ctx.request.userId).catch(() => null) : null;
}

/** Build an overwrite object from a template: { Perm: true|false }. */
export function overwriteFromTemplate(name) {
  const t = PERMISSION_TEMPLATES[name];
  if (!t) throw new Error(`unknown template ${name}`);
  const o = {};
  for (const p of t.allow) o[p] = true;
  for (const p of t.deny) o[p] = false;
  return o;
}

/** Non-owners may not grant permissions they do not hold themselves. */
function escalationCheck(ctx, actor, perms, channel) {
  if (isSystemOwner(ctx, actor)) return null;
  if (!actor) return 'Requester could not be verified.';
  const held = channel ? channel.permissionsFor(actor) : actor.permissions;
  const missing = perms.filter((p) => !held?.has(p));
  return missing.length ? `You cannot grant permissions you do not have: ${missing.join(', ')}.` : null;
}

function overwriteMatches(ow, overwrite) {
  if (!ow) return false;
  return Object.entries(overwrite).every(([perm, v]) => (v === true ? ow.allow.has(perm) : v === false ? ow.deny.has(perm) : true));
}

export const serverHandlers = {
  async 'channel.create'(ctx, p) {
    const { guild } = ctx;
    const me = guild.members.me;
    if (!me.permissions.has('ManageChannels')) return { ok: false, message: 'I need the Manage Channels permission.' };
    const existing = guild.channels.cache.find((c) => normName(c.name) === normName(p.name) && c.type === TYPE_MAP[p.type]);
    if (existing) return { ok: false, message: `A ${p.type} channel named <#${existing.id}> already exists; use it or choose another name.`, refs: { channel: existing.id } };
    const actor = await actorOf(ctx);
    const overwrites = [];
    if (p.template === 'readonly') overwrites.push({ id: guild.roles.everyone.id, deny: ['SendMessages', 'SendMessagesInThreads', 'CreatePublicThreads'] });
    if (p.template === 'private') {
      overwrites.push({ id: guild.roles.everyone.id, deny: ['ViewChannel'] });
      overwrites.push({ id: me.id, allow: ['ViewChannel', 'SendMessages', 'ManageChannels', 'Connect'] });
      if (actor) overwrites.push({ id: actor.id, allow: ['ViewChannel', 'SendMessages', 'Connect'] });
    }
    if (overwrites.length && !me.permissions.has('ManageRoles')) return { ok: false, message: 'I need Manage Roles to apply channel permissions.' };
    const opts = { name: p.name, type: TYPE_MAP[p.type], permissionOverwrites: overwrites, reason: `ALPHA by ${ctx.request.userId}` };
    if (p.categoryId && p.type !== 'category') opts.parent = p.categoryId;
    if (p.topic && ['text', 'announcement', 'forum'].includes(p.type)) opts.topic = p.topic;
    let channel;
    let note = '';
    try {
      channel = await guild.channels.create(opts);
    } catch (err) {
      // Announcement channels need a Community server: fall back to read-only text.
      if (p.type === 'announcement' && (err.code === 50035 || err.code === 50024)) {
        channel = await guild.channels.create({ ...opts, type: ChannelType.GuildText });
        note = ' (Announcement type needs a Community server; created a text channel instead.)';
      } else throw err;
    }
    const fresh = await guild.channels.fetch(channel.id, { force: true }).catch(() => null);
    let verified = Boolean(fresh);
    if (fresh && p.template !== 'public') {
      const ow = fresh.permissionOverwrites.cache.get(guild.roles.everyone.id);
      verified = p.template === 'private' ? Boolean(ow?.deny.has('ViewChannel')) : Boolean(ow?.deny.has('SendMessages'));
    }
    return {
      ok: verified,
      verified,
      message: `Created ${p.template} ${p.type} channel <#${channel.id}>${verified ? ' (verified)' : ' — verification failed'}.${note}`,
      refs: { channel: channel.id },
    };
  },

  async 'channel.rename'(ctx, p) {
    const channel = await ctx.guild.channels.fetch(p.channelId).catch(() => null);
    if (!channel) return { ok: false, message: 'Channel not found.' };
    if (!channel.permissionsFor(ctx.guild.members.me)?.has('ManageChannels')) return { ok: false, message: 'I need Manage Channels for that channel.' };
    const old = channel.name;
    await channel.setName(p.name, `ALPHA by ${ctx.request.userId}`);
    const fresh = await ctx.guild.channels.fetch(channel.id, { force: true });
    const verified = fresh.name !== old || fresh.name === p.name;
    return { ok: verified, verified, message: `Renamed #${old} → #${fresh.name}.`, refs: { channel: channel.id } };
  },

  async 'channel.delete'(ctx, p) {
    const channel = await ctx.guild.channels.fetch(p.channelId).catch(() => null);
    if (!channel) return { ok: false, message: 'Channel not found.' };
    if (!channel.deletable) return { ok: false, message: 'I cannot delete that channel (permissions or it is required by the server).' };
    const name = channel.name;
    await channel.delete(`ALPHA by ${ctx.request.userId} (approved)`);
    const still = await ctx.guild.channels.fetch(p.channelId, { force: true }).catch(() => null);
    return { ok: !still, verified: !still, message: still ? 'Deletion could not be verified.' : `Deleted #${name}.` };
  },

  async 'channel.permit'(ctx, p) {
    const { guild } = ctx;
    const channel = await guild.channels.fetch(p.channelId).catch(() => null);
    if (!channel?.permissionOverwrites) return { ok: false, message: 'Channel not found or has no permissions.' };
    const me = guild.members.me;
    if (!channel.permissionsFor(me)?.has('ManageRoles')) return { ok: false, message: 'I need Manage Permissions in that channel.' };
    const overwrite = overwriteFromTemplate(p.template);
    const granting = Object.entries(overwrite).filter(([, v]) => v).map(([k]) => k);
    const actor = await actorOf(ctx);
    const esc = escalationCheck(ctx, actor, granting, channel);
    if (esc) return { ok: false, message: esc };
    const target = p.targetKind === 'role' ? guild.roles.cache.get(p.targetId) ?? (await guild.roles.fetch(p.targetId)) : await guild.members.fetch(p.targetId);
    if (!target) return { ok: false, message: 'Target no longer exists.' };
    // Never lock the bot (or the requester) out of a channel being hidden.
    if (p.template === 'deny' && p.targetKind === 'role' && p.targetId === guild.id) {
      await channel.permissionOverwrites.edit(me.id, { ViewChannel: true, ManageRoles: true }, { reason: 'AEGIS keeps access' });
    }
    await channel.permissionOverwrites.edit(target, overwrite, { reason: `ALPHA by ${ctx.request.userId}: ${p.template}` });
    const fresh = await guild.channels.fetch(channel.id, { force: true });
    const verified = overwriteMatches(fresh.permissionOverwrites.cache.get(p.targetId), overwrite);
    return {
      ok: verified,
      verified,
      message: `Applied "${p.template}" for ${p.targetLabel} in <#${channel.id}>${verified ? ' (verified)' : ' — verification failed'}.`,
      refs: { channel: channel.id, ...(p.targetKind === 'role' ? { role: p.targetId } : { member: p.targetId }) },
    };
  },

  async 'role.create'(ctx, p) {
    const { guild } = ctx;
    if (!guild.members.me.permissions.has('ManageRoles')) return { ok: false, message: 'I need the Manage Roles permission.' };
    const existing = guild.roles.cache.find((r) => normName(r.name) === normName(p.name));
    if (existing) return { ok: false, message: `A role named @${existing.name} already exists; use it or choose another name.`, refs: { role: existing.id } };
    const perms = ROLE_TEMPLATES[p.template];
    const esc = escalationCheck(ctx, await actorOf(ctx), perms, null);
    if (esc) return { ok: false, message: esc };
    const role = await guild.roles.create({
      name: p.name,
      color: p.color ? `#${p.color.replace('#', '')}` : undefined,
      hoist: p.hoist,
      mentionable: p.mentionable,
      permissions: new PermissionsBitField(perms),
      reason: `ALPHA by ${ctx.request.userId}`,
    });
    const fresh = await guild.roles.fetch(role.id, { force: true }).catch(() => null);
    const verified = Boolean(fresh && fresh.name === p.name && perms.every((x) => fresh.permissions.has(x)) && !fresh.permissions.has('Administrator'));
    return { ok: verified, verified, message: `Created role <@&${role.id}>${verified ? ' (verified)' : ' — verification failed'}.`, refs: { role: role.id } };
  },

  async 'role.assign'(ctx, p) {
    return assignRole(ctx, p, true);
  },
  async 'role.remove'(ctx, p) {
    return assignRole(ctx, p, false);
  },

  async 'role.delete'(ctx, p) {
    const { guild } = ctx;
    const role = await guild.roles.fetch(p.roleId).catch(() => null);
    if (!role) return { ok: false, message: 'Role not found.' };
    const chk = checkRoleManageable({ role, botMember: guild.members.me, actor: await actorOf(ctx), guild, config: ctx.config });
    if (!chk.ok) return { ok: false, message: chk.reason };
    const name = role.name;
    await role.delete(`ALPHA by ${ctx.request.userId} (approved)`);
    const still = await guild.roles.fetch(p.roleId, { force: true }).catch(() => null);
    return { ok: !still, verified: !still, message: still ? 'Deletion could not be verified.' : `Deleted role @${name}.` };
  },

  async 'role.bulk_assign'(ctx, p) {
    const { guild } = ctx;
    const role = await guild.roles.fetch(p.roleId).catch(() => null);
    if (!role) return { ok: false, message: 'Role not found.' };
    const chk = checkRoleManageable({ role, botMember: guild.members.me, actor: await actorOf(ctx), guild, config: ctx.config });
    if (!chk.ok) return { ok: false, message: chk.reason };
    const all = await guild.members.fetch();
    const targets = [...all.values()].filter((m) => m.roles.cache.has(p.fromRoleId) && !m.roles.cache.has(p.roleId) && !m.user.bot);
    const LIMIT = 500;
    let done = 0;
    let failed = 0;
    for (const m of targets.slice(0, LIMIT)) {
      // discord.js queues requests to respect rate limits.
      await m.roles.add(role, `ALPHA bulk by ${ctx.request.userId} (approved)`).then(() => done++, () => failed++);
    }
    const skipped = Math.max(0, targets.length - LIMIT);
    return { ok: failed === 0, message: `Gave @${role.name} to ${done} member(s)${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped (limit ${LIMIT})` : ''}.`, refs: { role: role.id } };
  },

  async 'announce.send'(ctx, p) {
    const { guild } = ctx;
    const channel = await guild.channels.fetch(p.channelId).catch(() => null);
    if (!channel?.send) return { ok: false, message: 'That is not a text channel.' };
    const perms = channel.permissionsFor(guild.members.me);
    if (!perms?.has(['ViewChannel', 'SendMessages'])) return { ok: false, message: `I cannot send messages in <#${channel.id}>.` };
    if (p.pingEveryone && !perms.has('MentionEveryone')) return { ok: false, message: 'I am not allowed to mention @everyone there.' };
    const msg = await channel.send({
      content: `${p.pingEveryone ? '@everyone\n' : ''}${p.message}`,
      allowedMentions: p.pingEveryone ? { parse: ['everyone'] } : { parse: [] },
    });
    return { ok: Boolean(msg?.id), verified: Boolean(msg?.id), message: `Announcement posted in <#${channel.id}>.`, refs: { channel: channel.id } };
  },

  async 'schedule.message'(ctx, p) {
    const schedule = p.dailyTime ? { kind: 'daily', time: p.dailyTime } : { kind: 'once', at: p.at };
    if (schedule.kind === 'once' && p.at <= Date.now()) return { ok: false, message: 'That time is in the past.' };
    const job = createJob(ctx.db, {
      guildId: ctx.guild.id,
      bot: 'aegis',
      type: 'message.send',
      payload: { channelId: p.channelId, message: p.message },
      schedule,
      tz: ctx.config.timezone,
      createdBy: ctx.request.userId,
    });
    return { ok: true, message: `Scheduled for <t:${Math.floor(job.next_run_at / 1000)}:F> in <#${p.channelId}>${p.dailyTime ? ' (daily)' : ''}. Job ${job.id.slice(0, 8)}.` };
  },

  async 'reminder.create'(ctx, p) {
    if (p.at <= Date.now()) return { ok: false, message: 'That time is in the past.' };
    const channelId = p.channelId ?? ctx.request.channelId ?? ctx.settings.channels.alpha;
    const job = createJob(ctx.db, {
      guildId: ctx.guild.id,
      bot: 'aegis',
      type: 'reminder',
      payload: { channelId, userId: ctx.request.userId, message: p.message },
      schedule: { kind: 'once', at: p.at },
      tz: ctx.config.timezone,
      createdBy: ctx.request.userId,
    });
    return { ok: true, message: `I'll remind you <t:${Math.floor(job.next_run_at / 1000)}:R>.` };
  },
};

async function assignRole(ctx, p, add) {
  const { guild } = ctx;
  const role = await guild.roles.fetch(p.roleId).catch(() => null);
  const member = await guild.members.fetch(p.memberId).catch(() => null);
  if (!role || !member) return { ok: false, message: 'Role or member not found.' };
  const actor = await actorOf(ctx);
  const chk = checkRoleManageable({ role, botMember: guild.members.me, actor, guild, config: ctx.config });
  if (!chk.ok) return { ok: false, message: chk.reason };
  if (add && role.permissions.has('Administrator') && !isSystemOwner(ctx, actor)) {
    return { ok: false, message: 'Only the Soul Society owner may grant administrator roles.' };
  }
  if (add) await member.roles.add(role, `ALPHA by ${ctx.request.userId}`);
  else await member.roles.remove(role, `ALPHA by ${ctx.request.userId}`);
  const fresh = await guild.members.fetch({ user: member.id, force: true });
  const has = fresh.roles.cache.has(role.id);
  const verified = has === add;
  return {
    ok: verified,
    verified,
    message: `${add ? 'Gave' : 'Removed'} @${role.name} ${add ? 'to' : 'from'} ${member.displayName}${verified ? ' (verified)' : ' — verification failed'}.`,
    refs: { member: member.id, role: role.id },
  };
}
