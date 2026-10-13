// Community events: creation, reminders, participation, rewards and recaps.
// Rewards use idempotent ledger keys, and reminders/finalisation are
// persistent scheduler jobs, so restarts never duplicate them.
import crypto from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, GuildScheduledEventEntityType, GuildScheduledEventPrivacyLevel } from 'discord.js';
import { createJob } from '../../core/scheduler.js';
import { applyLedger, progressQuests } from '../progression/economy.js';
import { getGuildSettings } from '../../core/settings.js';

export function insertEvent(db, { guildId, name, description = null, channelId = null, startsAt, endsAt, reward, createdBy, now = Date.now() }) {
  const id = crypto.randomBytes(6).toString('hex');
  db.run(
    `INSERT INTO events (id, guild_id, name, description, channel_id, starts_at, ends_at, reward, status, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`,
    id, guildId, name, description, channelId, startsAt, endsAt, reward, createdBy, now,
  );
  return getEvent(db, id);
}

export const getEvent = (db, id) => db.get('SELECT * FROM events WHERE id = ?', id);

export function joinEvent(db, eventId, userId, now = Date.now()) {
  const ev = getEvent(db, eventId);
  if (!ev) return { ok: false, reason: 'not_found' };
  if (ev.status === 'completed' || ev.status === 'cancelled') return { ok: false, reason: 'closed' };
  const r = db.run('INSERT OR IGNORE INTO event_participants (event_id, user_id, joined_at) VALUES (?, ?, ?)', eventId, userId, now);
  return { ok: true, already: r.changes === 0, event: ev };
}

/** Reward participants exactly once and mark the event complete. */
export function finalizeEvent(db, eventId, { tz, now = Date.now() } = {}) {
  return db.transaction(() => {
    const ev = getEvent(db, eventId);
    if (!ev) return null;
    const participants = db.all('SELECT user_id FROM event_participants WHERE event_id = ?', eventId);
    const settings = getGuildSettings(db, ev.guild_id);
    let rewarded = 0;
    for (const p of participants) {
      if (ev.reward > 0) {
        const r = applyLedger(db, { guildId: ev.guild_id, userId: p.user_id, amount: ev.reward, kind: 'event', reason: `Event: ${ev.name}`, idempotencyKey: `event:${eventId}:${p.user_id}`, season: settings.progression.season, now });
        if (r.applied) {
          rewarded++;
          progressQuests(db, { guildId: ev.guild_id, userId: p.user_id, metric: 'events', now, tz, season: settings.progression.season });
        }
      }
    }
    db.run(`UPDATE events SET status = 'completed' WHERE id = ?`, eventId);
    return { event: { ...ev, status: 'completed' }, participants: participants.map((p) => p.user_id), rewarded };
  });
}

export function joinButton(eventId) {
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`event:join:${eventId}`).setLabel('Join event').setEmoji('✨').setStyle(ButtonStyle.Primary));
}

/** Handler for the event.create action (AEGIS). */
export async function createEventAction(ctx, p) {
  const { db, guild, settings, config, request } = ctx;
  if (p.startsAt <= Date.now()) return { ok: false, message: 'The event start time is in the past.' };
  const channelId = p.channelId ?? settings.channels.announcements ?? request.channelId ?? null;
  const ev = insertEvent(db, { guildId: guild.id, name: p.name, description: p.description, channelId, startsAt: p.startsAt, endsAt: p.startsAt + p.durationMs, reward: p.reward, createdBy: request.userId });

  let discordEvent = null;
  if (guild.members.me.permissions.has('ManageEvents')) {
    discordEvent = await guild.scheduledEvents
      .create({
        name: p.name,
        scheduledStartTime: new Date(p.startsAt),
        scheduledEndTime: new Date(p.startsAt + p.durationMs),
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: 'Soul Society' },
        description: p.description ?? `Reward: ${p.reward} aura for participants`,
      })
      .catch((err) => {
        ctx.logger.warn('Discord scheduled event creation failed', { err: err.message });
        return null;
      });
    if (discordEvent) db.run('UPDATE events SET discord_event_id = ? WHERE id = ?', discordEvent.id, ev.id);
  }
  const tz = config.timezone;
  const reminderAt = p.startsAt - 15 * 60000;
  if (reminderAt > Date.now() + 60000) createJob(db, { guildId: guild.id, bot: 'aegis', type: 'event.reminder', payload: { eventId: ev.id, phase: 'soon' }, schedule: { kind: 'once', at: reminderAt }, tz, uniqueKey: `event:${ev.id}:soon` });
  createJob(db, { guildId: guild.id, bot: 'aegis', type: 'event.reminder', payload: { eventId: ev.id, phase: 'start' }, schedule: { kind: 'once', at: p.startsAt }, tz, uniqueKey: `event:${ev.id}:start` });
  createJob(db, { guildId: guild.id, bot: 'aegis', type: 'event.finalize', payload: { eventId: ev.id }, schedule: { kind: 'once', at: p.startsAt + p.durationMs }, tz, uniqueKey: `event:${ev.id}:end` });

  if (channelId) {
    const ch = await guild.channels.fetch(channelId).catch(() => null);
    await ch
      ?.send({
        embeds: [
          {
            title: `✨ ${p.name}`,
            color: 0x22d3ee,
            description: `${p.description ?? ''}\n**Starts:** <t:${Math.floor(p.startsAt / 1000)}:F> (<t:${Math.floor(p.startsAt / 1000)}:R>)\n**Reward:** ${p.reward} aura for participants`,
            footer: { text: `AEGIS • event ${ev.id}` },
          },
        ],
        components: [joinButton(ev.id)],
        allowedMentions: { parse: [] },
      })
      .catch(() => null);
  }
  return { ok: true, verified: true, message: `Event "${p.name}" created for <t:${Math.floor(p.startsAt / 1000)}:F>${discordEvent ? ' (also added to Discord Events)' : ''}. ID ${ev.id}.` };
}
