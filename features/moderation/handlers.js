// KNIGHT action handlers (invoked through the ALPHA coordinator or task queue).
import { enforce, moderationStats } from './enforce.js';
import { guardianEmbed, safeText } from '../../core/discord/theme.js';
import { sendToChannel } from '../../core/discord/send.js';
import { dayKey, zonedParts, zonedToUtc } from '../../core/time.js';

async function members(ctx, params) {
  const { guild, request } = ctx;
  const target = await guild.members.fetch(params.memberId).catch(() => null);
  const actor = request.userId ? await guild.members.fetch(request.userId).catch(() => null) : null;
  return { target, actor };
}

function modHandler(action) {
  return async (ctx, params) => {
    const { target, actor } = await members(ctx, params);
    if (!target) return { ok: false, message: 'That member is no longer in the server.' };
    const r = await enforce({
      ...ctx,
      action,
      target,
      actor,
      durationMs: params.durationMs,
      reason: params.reason,
      rule: ctx.request.source === 'voice' ? 'alpha-voice' : ctx.request.source === 'slash' ? 'manual' : 'alpha-text',
      points: action === 'warn' ? ctx.settings.moderation.escalation.points.mild : 0,
      deleteMessageSeconds: params.deleteMessageSeconds,
    });
    return { ok: r.ok, message: r.message, verified: r.verified, refs: { member: target.id }, caseId: r.caseId };
  };
}

export function periodStart(period, tz, now = Date.now()) {
  const p = zonedParts(now, tz);
  const midnight = zonedToUtc({ year: p.year, month: p.month, day: p.day, hour: 0, minute: 0 }, tz);
  if (period === 'today') return midnight;
  if (period === 'week') return midnight - 6 * 86400000;
  return midnight - 29 * 86400000;
}

export function moderationReportEmbed(db, guild, period, tz) {
  const since = periodStart(period, tz);
  const s = moderationStats(db, guild.id, since);
  const totals = {};
  for (const r of s.byAction) {
    const key = r.result === 'simulated' ? `${r.action} (simulated)` : r.result === 'refused' ? `${r.action} (refused)` : r.action;
    totals[key] = (totals[key] ?? 0) + r.n;
  }
  return guardianEmbed('knight', {
    title: `Moderation report — ${period === 'today' ? dayKey(Date.now(), tz) : `last ${period === 'week' ? '7' : '30'} days`}`,
    fields: [
      { name: 'Actions', value: Object.entries(totals).map(([k, v]) => `**${k}**: ${v}`).join('\n') || 'No moderation activity.' },
      { name: 'Top rules', value: s.byRule.map((r) => `${r.rule}: ${r.n}`).join('\n') || '—', inline: true },
      { name: 'Most cases', value: s.topUsers.map((u) => `<@${u.user_id}>: ${u.n}`).join('\n') || '—', inline: true },
      { name: 'Open voice reviews', value: String(s.openReviews), inline: true },
    ],
  }).toJSON();
}

export const knightHandlers = {
  'mod.warn': modHandler('warn'),
  'mod.timeout': modHandler('timeout'),
  'mod.untimeout': modHandler('untimeout'),
  'mod.kick': modHandler('kick'),
  'mod.ban': modHandler('ban'),

  async 'mod.unban'(ctx, params) {
    const { guild, request } = ctx;
    const ban = await guild.bans.fetch(params.userId).catch(() => null);
    if (!ban) return { ok: false, message: 'That user is not banned.' };
    await guild.bans.remove(params.userId, `${params.reason} | by ${request.userId}`);
    const still = await guild.bans.fetch({ user: params.userId, force: true }).catch(() => null);
    return { ok: !still, verified: !still, message: still ? 'Unban did not take effect.' : `Unbanned ${safeText(ban.user?.username ?? params.userId)}.` };
  },

  async 'security.lockdown'(ctx, params) {
    const { guild } = ctx;
    const channel = await guild.channels.fetch(params.channelId).catch(() => null);
    if (!channel?.permissionOverwrites) return { ok: false, message: 'Channel not found or does not support permissions.' };
    const me = guild.members.me;
    if (!channel.permissionsFor(me)?.has('ManageRoles')) return { ok: false, message: 'I need Manage Permissions in that channel.' };
    const everyone = guild.roles.everyone;
    // Keep KNIGHT able to post in a locked channel.
    if (params.enable) await channel.permissionOverwrites.edit(me.id, { SendMessages: true, ViewChannel: true }, { reason: 'KNIGHT lockdown (self access)' });
    await channel.permissionOverwrites.edit(everyone, { SendMessages: params.enable ? false : null, AddReactions: params.enable ? false : null, SendMessagesInThreads: params.enable ? false : null }, { reason: `KNIGHT lockdown by ${ctx.request.userId}` });
    const fresh = await guild.channels.fetch(channel.id, { force: true });
    const ow = fresh.permissionOverwrites.cache.get(everyone.id);
    const locked = Boolean(ow?.deny?.has('SendMessages'));
    const verified = locked === params.enable;
    return { ok: verified, verified, message: `${params.enable ? 'Locked' : 'Unlocked'} #${channel.name}${verified ? ' (verified)' : ' — verification failed'}.`, refs: { channel: channel.id } };
  },

  async 'report.moderation'(ctx, params) {
    const embed = moderationReportEmbed(ctx.db, ctx.guild, params.period, ctx.config.timezone);
    if (params.channelId) {
      const sent = await sendToChannel(ctx.guild, params.channelId, { embeds: [embed] }, ctx.logger);
      return { ok: Boolean(sent), message: sent ? `Report posted in <#${params.channelId}>.` : 'Could not post the report there.' };
    }
    return { ok: true, message: 'Moderation report ready.', embed };
  },
};
