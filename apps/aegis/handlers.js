// AEGIS action handlers and scheduled-job handlers.
import { serverHandlers } from '../../features/server/handlers.js';
import { createEventAction, finalizeEvent, getEvent } from '../../features/events/events.js';
import { runResearch, researchEmbed, saveReport } from '../../features/intelligence/research.js';
import { activityStats, activityEmbed } from '../../features/intelligence/analytics.js';
import { applyLedger } from '../../features/progression/economy.js';
import { musicHandlers } from './music.js';
import { createJob } from '../../core/scheduler.js';
import { sendToChannel } from '../../core/discord/send.js';
import { guardianEmbed, safeText } from '../../core/discord/theme.js';
import { getGuildSettings } from '../../core/settings.js';
import { THEME } from '../../config/defaults.js';

export function aegisHandlers() {
  return {
    ...serverHandlers,
    'event.create': createEventAction,

    async 'research.run'(ctx, p) {
      const report = await runResearch({ query: p.query, timeframe: p.timeframe, maxItems: p.maxItems, config: ctx.config, ai: ctx.ai });
      const embed = researchEmbed(report, THEME.aegis);
      const channelId = p.channelId;
      if (channelId) {
        const msg = await sendToChannel(ctx.guild, channelId, { embeds: [embed] }, ctx.logger);
        saveReport(ctx.db, ctx.guild.id, report, { channelId, messageId: msg?.id });
        if (!msg) return { ok: false, message: `Research finished but I could not post in <#${channelId}>.` };
        return { ok: true, verified: true, message: `Research on "${safeText(p.query, 80)}": ${report.items.length} sourced item(s) posted in <#${channelId}>.${report.errors.length ? ` (${report.errors.length} source(s) unavailable)` : ''}` };
      }
      saveReport(ctx.db, ctx.guild.id, report);
      return { ok: true, message: `Research on "${safeText(p.query, 80)}": ${report.items.length} sourced item(s).`, embed };
    },

    async 'research.schedule'(ctx, p) {
      const job = createJob(ctx.db, {
        guildId: ctx.guild.id,
        bot: 'aegis',
        type: 'research.daily',
        payload: { query: p.query, channelId: p.channelId },
        schedule: { kind: 'daily', time: p.dailyTime },
        tz: ctx.config.timezone,
        createdBy: ctx.request.userId,
        uniqueKey: `research:${ctx.guild.id}:${p.channelId}:${p.query.toLowerCase()}`,
      });
      return { ok: true, message: `Daily research on "${safeText(p.query, 80)}" will post in <#${p.channelId}> at ${p.dailyTime} (next <t:${Math.floor(job.next_run_at / 1000)}:R>).` };
    },

    async 'report.activity'(ctx, p) {
      const embed = activityEmbed(activityStats(ctx.db, ctx.guild.id, p.period, ctx.config.timezone));
      if (p.channelId) {
        const msg = await sendToChannel(ctx.guild, p.channelId, { embeds: [embed] }, ctx.logger);
        return { ok: Boolean(msg), message: msg ? `Activity report posted in <#${p.channelId}>.` : 'Could not post the report there.' };
      }
      return { ok: true, message: 'Activity report ready.', embed };
    },

    async 'economy.grant'(ctx, p) {
      const r = applyLedger(ctx.db, {
        guildId: ctx.guild.id,
        userId: p.memberId,
        amount: p.amount,
        kind: p.amount >= 0 ? 'admin_grant' : 'admin_revoke',
        reason: `${p.reason} (by ${ctx.request.userId})`,
        idempotencyKey: `grant:${ctx.request.requestId}:${p.memberId}`,
        actorId: ctx.request.userId,
        season: ctx.settings.progression.season,
      });
      return { ok: true, verified: r.applied, message: r.applied ? `${p.amount >= 0 ? 'Granted' : 'Revoked'} ${Math.abs(p.amount)} aura ${p.amount >= 0 ? 'to' : 'from'} <@${p.memberId}>. Balance: ${r.balance}.` : 'Already applied.', refs: { member: p.memberId } };
    },

    ...musicHandlers,
    async 'voice.stop_listening'(ctx) {
      const musicActive = Boolean(ctx.music.peek(ctx.guild.id)?.queue.current);
      return ctx.listener.stop(ctx.guild.id, { musicActive }) ? { ok: true, message: 'Stopped listening. Audio capture is off.' } : { ok: false, message: 'I was not listening.' };
    },
  };
}

/** Scheduler job handlers owned by AEGIS. Throwing marks the run failed (retried). */
export function aegisJobs(app) {
  const guildOf = async (job) => {
    const g = await app.getGuild(job.guild_id);
    if (!g) throw new Error('guild unavailable');
    return g;
  };
  return {
    async 'message.send'(job) {
      const g = await guildOf(job);
      const msg = await sendToChannel(g, job.payload.channelId, { content: job.payload.message }, app.logger);
      if (!msg) throw new Error(`channel ${job.payload.channelId} unavailable`);
    },
    async reminder(job) {
      const g = await guildOf(job);
      const msg = await sendToChannel(g, job.payload.channelId, { content: `⏰ <@${job.payload.userId}> reminder: ${safeText(job.payload.message, 500)}`, allowedMentions: { users: [job.payload.userId] } }, app.logger);
      if (!msg) throw new Error('reminder channel unavailable');
    },
    async 'research.daily'(job) {
      const g = await guildOf(job);
      const report = await runResearch({ query: job.payload.query, timeframe: 'today', config: app.config, ai: app.ai });
      const msg = await sendToChannel(g, job.payload.channelId, { embeds: [researchEmbed(report, THEME.aegis)] }, app.logger);
      if (!msg) throw new Error('research channel unavailable');
      saveReport(app.db, g.id, report, { channelId: job.payload.channelId, messageId: msg.id });
    },
    async 'report.activity'(job) {
      const g = await guildOf(job);
      const s = getGuildSettings(app.db, g.id);
      const embed = activityEmbed(activityStats(app.db, g.id, job.payload.period, app.config.timezone));
      const msg = await sendToChannel(g, s.channels.reports, { embeds: [embed] }, app.logger);
      if (!msg) throw new Error('reports channel unavailable');
    },
    async 'event.reminder'(job) {
      const g = await guildOf(job);
      const ev = getEvent(app.db, job.payload.eventId);
      if (!ev || ev.status === 'cancelled' || !ev.channel_id) return;
      const people = app.db.all('SELECT user_id FROM event_participants WHERE event_id = ? LIMIT 50', ev.id).map((r) => r.user_id);
      const text = job.payload.phase === 'soon' ? `⏳ **${safeText(ev.name)}** starts <t:${Math.floor(ev.starts_at / 1000)}:R>!` : `✨ **${safeText(ev.name)}** is starting now!`;
      if (job.payload.phase === 'start') app.db.run(`UPDATE events SET status = 'live' WHERE id = ? AND status = 'scheduled'`, ev.id);
      await sendToChannel(g, ev.channel_id, { content: `${text}${people.length ? `\n${people.map((u) => `<@${u}>`).join(' ')}` : ''}`, allowedMentions: { users: people } }, app.logger);
    },
    async 'event.finalize'(job) {
      const g = await guildOf(job);
      const r = finalizeEvent(app.db, job.payload.eventId, { tz: app.config.timezone });
      if (!r || !r.event.channel_id) return;
      await sendToChannel(g, r.event.channel_id, {
        embeds: [guardianEmbed('aegis', { title: `Recap — ${r.event.name}`, description: `**Participants:** ${r.participants.length}\n**Rewarded:** ${r.rewarded} × ${r.event.reward} aura\n${r.participants.slice(0, 40).map((u) => `<@${u}>`).join(' ')}` })],
      }, app.logger);
    },
  };
}
