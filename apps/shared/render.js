// Render coordinator responses as themed Discord messages.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { guardianEmbed, STATUS_COLORS, safeText } from '../../core/discord/theme.js';
import { getAction } from '../../core/actions/registry.js';

const ICON = { true: '✅', false: '❌', null: '⏳' };

export function approvalButtons(approvalId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`alpha:approve:${approvalId}`).setLabel('Approve').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId(`alpha:reject:${approvalId}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled),
  );
}

/** @returns {{embeds:object[], components:object[], content?:string}} */
export function renderResponse(bot, res) {
  switch (res.status) {
    case 'awaiting_approval': {
      const a = res.approval;
      const embed = guardianEmbed(bot, {
        title: 'Confirmation required',
        color: STATUS_COLORS.pending,
        description: `${safeText(res.summary, 3000)}\n\n**Risk:** ${res.risk.toUpperCase()}\n**Requested by:** <@${a.owner_id}> (only they can approve)\n**Expires:** <t:${Math.floor(a.expires_at / 1000)}:R>`,
        fields: res.warnings?.length ? [{ name: '⚠️ Warnings', value: res.warnings.map((w) => `• ${w}`).join('\n') }] : [],
      });
      return { embeds: [embed], components: [approvalButtons(a.id)] };
    }
    case 'executed':
    case 'failed':
    case 'queued': {
      const lines = res.results.map((r) => `${ICON[String(r.ok ?? null)]} **${r.action}** — ${r.message ?? ''}`);
      const color = res.status === 'executed' ? STATUS_COLORS.ok : res.status === 'queued' ? STATUS_COLORS.pending : STATUS_COLORS.error;
      const title = res.status === 'executed' ? 'Done' : res.status === 'queued' ? 'Queued' : 'Not completed';
      const extra = res.results.map((r) => r.embed).filter(Boolean);
      const components = res.results.flatMap((r) => r.components ?? []);
      const sim = res.results.some((r) => r.simulated);
      return {
        embeds: [guardianEmbed(bot, { title: `ALPHA • ${title}${sim ? ' (simulation)' : ''}`, color, description: lines.join('\n').slice(0, 4000) }), ...extra].slice(0, 10),
        components: components.slice(0, 5),
      };
    }
    case 'clarify':
      return { embeds: [guardianEmbed(bot, { title: 'ALPHA needs more detail', color: STATUS_COLORS.warn, description: safeText(res.message, 2000) })], components: [] };
    case 'cancelled':
      return { embeds: [guardianEmbed(bot, { title: 'Cancelled', description: res.message })], components: [] };
    case 'duplicate':
      return { embeds: [], components: [], content: 'Already handled.' };
    default:
      return { embeds: [guardianEmbed(bot, { title: 'Refused', color: STATUS_COLORS.error, description: safeText(res.message ?? 'Request refused.', 2000) })], components: [] };
  }
}

/** One-line plain summary (used for spoken responses). */
export function spokenSummary(res) {
  if (res.status === 'awaiting_approval') return 'This needs your confirmation. Please approve it in Discord.';
  if (res.results) return res.results.map((r) => `${r.ok === false ? 'Failed: ' : ''}${r.message ?? getAction(r.action)?.describe?.({}) ?? r.action}`).join('. ');
  return res.message ?? 'Done.';
}
