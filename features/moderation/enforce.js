// Moderation executor used by slash commands, ALPHA and automod alike.
// Every attempt (including refusals and simulations) becomes a case record.
import { checkModeration } from '../../core/discord/safety.js';
import { sendToChannel } from '../../core/discord/send.js';
import { guardianEmbed, STATUS_COLORS, safeText } from '../../core/discord/theme.js';
import { formatDuration } from '../../core/time.js';
import { audit } from '../../core/audit.js';

export function recordCase(db, c) {
  const res = db.run(
    `INSERT INTO mod_cases (guild_id, user_id, moderator_id, bot, action, reason, rule, points, duration_ms, evidence, simulated, result, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.guildId,
    c.userId,
    c.moderatorId ?? null,
    c.bot ?? 'knight',
    c.action,
    c.reason ?? null,
    c.rule ?? null,
    c.points ?? 0,
    c.durationMs ?? null,
    c.evidence ? String(c.evidence).slice(0, 1000) : null,
    c.simulated ? 1 : 0,
    c.result,
    c.now ?? Date.now(),
  );
  return Number(res.lastInsertRowid);
}

export function listCases(db, guildId, userId, limit = 15) {
  return db.all('SELECT * FROM mod_cases WHERE guild_id = ? AND user_id = ? ORDER BY id DESC LIMIT ?', guildId, userId, limit);
}

async function verify(action, guild, target, durationMs) {
  const now = Date.now();
  switch (action) {
    case 'timeout': {
      const m = await guild.members.fetch({ user: target.id, force: true }).catch(() => null);
      return Boolean(m?.communicationDisabledUntilTimestamp && m.communicationDisabledUntilTimestamp > now + Math.min(durationMs, 60000) / 2);
    }
    case 'untimeout': {
      const m = await guild.members.fetch({ user: target.id, force: true }).catch(() => null);
      return Boolean(m && !(m.communicationDisabledUntilTimestamp > now));
    }
    case 'kick': {
      const m = await guild.members.fetch({ user: target.id, force: true }).catch(() => null);
      return !m;
    }
    case 'ban': {
      const b = await guild.bans.fetch({ user: target.id, force: true }).catch(() => null);
      return Boolean(b);
    }
    default:
      return true;
  }
}

/**
 * @param {object} o
 * @param {'warn'|'timeout'|'untimeout'|'kick'|'ban'} o.action
 * @param {object} o.target GuildMember
 * @param {object|null} o.actor GuildMember of the requesting moderator (null = automatic)
 * @returns {Promise<{ok:boolean, simulated?:boolean, caseId:number, message:string, verified?:boolean}>}
 */
export async function enforce({ db, config, settings, logger, guild, action, target, actor = null, durationMs, reason, rule = 'manual', points = 0, evidence, automatic = false, deleteMessageSeconds = 0 }) {
  const botMember = guild.members.me ?? (await guild.members.fetchMe());
  const base = { guildId: guild.id, userId: target?.id, moderatorId: actor?.id ?? botMember.id, action, reason, rule, points, durationMs, evidence };
  const check = checkModeration({ action, guild, target, botMember, actor, config, moderation: settings.moderation, automatic });
  if (!check.ok) {
    const caseId = target ? recordCase(db, { ...base, result: 'refused', points: 0, reason: `${reason} [refused: ${check.reason}]` }) : 0;
    return { ok: false, caseId, message: check.reason };
  }

  if (automatic && settings.moderation.simulate) {
    const caseId = recordCase(db, { ...base, simulated: true, result: 'simulated' });
    const message = `[SIMULATION] Would ${action} ${target.displayName}${durationMs ? ` for ${formatDuration(durationMs)}` : ''} (${rule}).`;
    await postCase(guild, settings, { caseId, action, target, actor, reason, rule, durationMs, simulated: true, verified: null }, logger);
    return { ok: true, simulated: true, caseId, message };
  }

  const auditReason = `${reason} | ${automatic ? 'KNIGHT automod' : `by ${actor?.user?.username ?? actor?.id}`}`.slice(0, 500);
  try {
    switch (action) {
      case 'warn':
        await target.send({ embeds: [guardianEmbed('knight', { title: 'Warning', description: `You received a warning in **${safeText(guild.name, 100)}**.\n**Reason:** ${safeText(reason, 500)}` })] }).catch(() => null);
        break;
      case 'timeout':
        await target.timeout(durationMs, auditReason);
        break;
      case 'untimeout':
        await target.timeout(null, auditReason);
        break;
      case 'kick':
        await target.kick(auditReason);
        break;
      case 'ban':
        await guild.members.ban(target.id, { reason: auditReason, deleteMessageSeconds });
        break;
      default:
        throw new Error(`unknown moderation action ${action}`);
    }
  } catch (err) {
    const caseId = recordCase(db, { ...base, result: `error: ${err.code ?? ''} ${err.message}`.slice(0, 200) });
    logger?.error('moderation action failed', { action, guildId: guild.id, target: target.id, err });
    return { ok: false, caseId, message: err.code === 50013 ? 'Discord refused: missing permissions or role hierarchy.' : `Action failed: ${err.message}` };
  }
  const verified = await verify(action, guild, target, durationMs);
  const caseId = recordCase(db, { ...base, result: verified ? 'success' : 'unverified' });
  audit(db, { guildId: guild.id, actorId: actor?.id ?? 'automod', bot: 'knight', action: `mod.${action}`, target: target.id, params: { durationMs, rule }, outcome: verified ? 'success' : 'unverified', detail: `case ${caseId}` });
  await postCase(guild, settings, { caseId, action, target, actor, reason, rule, durationMs, simulated: false, verified }, logger);
  const verb = { warn: 'Warned', timeout: 'Timed out', untimeout: 'Removed timeout from', kick: 'Kicked', ban: 'Banned' }[action];
  return {
    ok: true,
    verified,
    caseId,
    message: `${verb} ${target.displayName}${durationMs && action === 'timeout' ? ` for ${formatDuration(durationMs)}` : ''} (case #${caseId}${verified ? ', verified' : ', NOT verified'}).`,
  };
}

async function postCase(guild, settings, c, logger) {
  const channelId = settings.channels.modLog ?? settings.channels.securityLog;
  if (!channelId) return;
  const title = `${c.simulated ? '[SIMULATION] ' : ''}Case #${c.caseId} — ${c.action.toUpperCase()}`;
  await sendToChannel(
    guild,
    channelId,
    {
      embeds: [
        guardianEmbed('knight', {
          title,
          color: c.simulated ? STATUS_COLORS.pending : c.verified === false ? STATUS_COLORS.warn : undefined,
          fields: [
            { name: 'Member', value: `${safeText(c.target.displayName, 80)} (<@${c.target.id}>)`, inline: true },
            { name: 'By', value: c.actor ? `<@${c.actor.id}>` : 'KNIGHT automod', inline: true },
            { name: 'Rule', value: c.rule, inline: true },
            ...(c.durationMs ? [{ name: 'Duration', value: formatDuration(c.durationMs), inline: true }] : []),
            { name: 'Reason', value: safeText(c.reason ?? '—', 900) },
            ...(c.verified != null ? [{ name: 'Verified', value: c.verified ? 'Yes' : 'No — check manually' , inline: true }] : []),
          ],
        }),
      ],
    },
    logger,
  );
}

export function moderationStats(db, guildId, sinceTs) {
  const byAction = db.all(
    `SELECT action, result, COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND created_at >= ? GROUP BY action, result`,
    guildId,
    sinceTs,
  );
  const byRule = db.all(`SELECT rule, COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND created_at >= ? GROUP BY rule ORDER BY n DESC LIMIT 8`, guildId, sinceTs);
  const topUsers = db.all(
    `SELECT user_id, COUNT(*) AS n FROM mod_cases WHERE guild_id = ? AND created_at >= ? AND result != 'refused' GROUP BY user_id ORDER BY n DESC LIMIT 5`,
    guildId,
    sinceTs,
  );
  const openReviews = db.get(`SELECT COUNT(*) AS n FROM voice_reviews WHERE guild_id = ? AND status = 'open'`, guildId).n;
  return { byAction, byRule, topUsers, openReviews };
}
