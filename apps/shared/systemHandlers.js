// Actions available on both bots.
import { healthReport } from '../../core/health.js';
import { guardianEmbed, STATUS_COLORS } from '../../core/discord/theme.js';

export function systemHandlers({ ai, stt }) {
  return {
    async 'system.status'(ctx) {
      const h = healthReport(ctx.db, { ai, stt });
      const bots = h.bots.map((b) => `**${b.bot.toUpperCase()}** — ${b.status} (seen ${b.lastSeenSecondsAgo}s ago)`).join('\n') || 'No heartbeats yet';
      const embed = guardianEmbed(ctx.bot, {
        title: 'System status',
        color: h.ok ? STATUS_COLORS.ok : STATUS_COLORS.warn,
        fields: [
          { name: 'Guardians', value: bots },
          { name: 'Database', value: `${h.database.ok ? 'OK' : 'ERROR'} · schema v${h.database.schema}`, inline: true },
          { name: 'Task queue', value: `${h.queue.pending} pending · ${h.queue.claimed} running · ${h.queue.failed24h} failed (24h)`, inline: true },
          { name: 'Jobs', value: `${h.jobs.active} active · ${h.jobs.overdue} overdue · ${h.jobs.failing} retrying`, inline: true },
          { name: 'Approvals pending', value: String(h.approvalsPending), inline: true },
          { name: 'Hosted AI', value: h.ai.enabled ? `${h.ai.provider} (${h.ai.usedToday}/${h.ai.dailyLimit} today${h.ai.circuitOpen ? ', paused' : ''})` : 'off — deterministic mode', inline: true },
          { name: 'Speech-to-text', value: h.stt.enabled ? `${h.stt.provider}${h.stt.provider === 'mock' ? ' (SIMULATED)' : ''}${h.stt.usedToday != null ? ` (${h.stt.usedToday}/${h.stt.dailyLimit} today)` : ''}` : 'not configured', inline: true },
        ],
      }).toJSON();
      return { ok: true, message: h.ok ? 'All guardians healthy.' : 'Some components need attention.', embed };
    },

    async 'system.help'(ctx) {
      const embed = guardianEmbed(ctx.bot, {
        title: 'ALPHA — what I can do',
        description: [
          '**Say or type** `ALPHA, <instruction>` (owner only). Examples:',
          '• find today\'s AI news and post a summary in research',
          '• create a gaming channel · give the Gaming role access to that channel',
          '• create a read-only announcement channel · make staff private',
          '• create a Research role · give John the Research role',
          '• play <song> · skip · pause · resume · show the queue · stop music',
          '• timeout that member for five minutes · warn Bob for spam',
          '• give me today\'s server activity report · moderation report for this week',
          '• schedule an announcement in general saying Hello tomorrow at 6pm',
          '• create an event called Valorant night tomorrow at 9pm · remind me to stretch in 20 minutes',
          '• stop listening',
          '',
          'Risky actions (bans, deletions, bulk or broad permission changes) always ask for confirmation.',
        ].join('\n'),
      }).toJSON();
      return { ok: true, message: 'Help', embed };
    },
  };
}
