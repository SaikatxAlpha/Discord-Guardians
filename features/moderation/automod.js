// KNIGHT automatic moderation: profanity, spam and raid protection.
import { buildMatcher, checkProfanity } from './filter.js';
import { SpamTracker, RaidDetector } from './spam.js';
import { activePoints, decideEscalation } from './escalation.js';
import { enforce, recordCase } from './enforce.js';
import { sendToChannel } from '../../core/discord/send.js';
import { guardianEmbed, STATUS_COLORS, safeText } from '../../core/discord/theme.js';
import { getGuildSettings } from '../../core/settings.js';
import { isServerSupreme } from '../../core/auth.js';

export class AutoModerator {
  constructor({ db, config, logger }) {
    Object.assign(this, { db, config, logger });
    this.spam = new SpamTracker();
    this.raid = new RaidDetector();
    this.matchers = new Map(); // guildId -> { key, fn }
    this.sweepTimer = setInterval(() => this.spam.sweep(), 60000).unref();
  }

  stop() {
    clearInterval(this.sweepTimer);
  }

  matcherFor(guildId, profanity) {
    const key = JSON.stringify([profanity.extraWords, profanity.allowWords]);
    const cached = this.matchers.get(guildId);
    if (cached?.key === key) return cached.fn;
    const fn = buildMatcher(profanity);
    this.matchers.set(guildId, { key, fn });
    return fn;
  }

  isExempt(member, channelId, mod) {
    if (!member) return true;
    if (isServerSupreme(member.id, member.guild, this.config)) return true;
    if (mod.exemptChannelIds.includes(channelId)) return true;
    if (mod.exemptRoleIds.some((id) => member.roles.cache.has(id))) return true;
    if (mod.exemptModerators && (member.permissions.has('ManageMessages') || member.permissions.has('ModerateMembers'))) return true;
    return false;
  }

  /**
   * Evaluate a message without side effects (used by /simulate and tests).
   * @returns {null|{rule:string, category:'mild'|'severe'|'spam', detail:string, contextual:boolean}}
   */
  evaluate({ guildId, userId, content, mentionCount }, settings) {
    const mod = settings.moderation;
    const spam = this.spam.check({ guildId, userId, content, mentionCount }, mod.spam);
    if (spam.spam) return { rule: spam.rule, category: 'spam', detail: spam.detail, contextual: false };
    if (mod.profanity.enabled) {
      const p = checkProfanity(content, this.matcherFor(guildId, mod.profanity));
      if (p.matched) return { rule: `profanity_${p.severity}`, category: p.severity, detail: `matched: ${p.terms.join(', ')}`, contextual: p.contextual };
    }
    return null;
  }

  async onMessage(message) {
    if (!message.guild || message.author?.bot || message.webhookId || message.system) return null;
    const settings = getGuildSettings(this.db, message.guild.id);
    const mod = settings.moderation;
    if (!mod.enabled) return null;
    const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
    if (this.isExempt(member, message.channelId, mod)) return null;

    const verdict = this.evaluate(
      { guildId: message.guild.id, userId: message.author.id, content: message.content ?? '', mentionCount: message.mentions?.users?.size ?? 0 },
      settings,
    );
    if (!verdict) return null;
    const evidence = `#${message.channel?.name ?? message.channelId}: ${String(message.content).slice(0, 300)}`;

    // Quoted / code-block matches are only flagged for human review.
    if (verdict.contextual) {
      recordCase(this.db, { guildId: message.guild.id, userId: message.author.id, action: 'flag', reason: 'Matched inside quote/code; not punished', rule: verdict.rule, evidence, result: 'review' });
      await this.securityLog(message.guild, settings, 'Flagged for review', `${safeText(member.displayName)}: ${verdict.detail} (inside a quote or code block — no action taken).`, STATUS_COLORS.warn);
      return { ...verdict, action: 'review' };
    }

    if (verdict.category === 'severe' && mod.deleteSevereMessages && !mod.simulate) {
      await message.delete().catch((err) => this.logger.warn('could not delete message', { err: err.message }));
    }
    const add = mod.escalation.points[verdict.category === 'spam' ? 'spam' : verdict.category] ?? 1;
    const before = activePoints(this.db, message.guild.id, message.author.id, mod.escalation.decayHours);
    const decision = decideEscalation({ before, add, escalation: mod.escalation });
    const result = await enforce({
      db: this.db,
      config: this.config,
      settings,
      logger: this.logger,
      guild: message.guild,
      action: decision.action,
      target: member,
      durationMs: decision.durationMs,
      reason: `Automatic: ${verdict.rule} (${verdict.detail})`,
      rule: verdict.rule,
      points: add,
      evidence,
      automatic: true,
    });
    return { ...verdict, action: decision.action, result };
  }

  async onMemberJoin(member) {
    const settings = getGuildSettings(this.db, member.guild.id);
    const r = this.raid.onJoin({ guildId: member.guild.id, accountCreatedAt: member.user?.createdTimestamp }, settings.moderation.raid);
    if (r.started) {
      await this.securityLog(member.guild, settings, '🚨 Possible raid detected', `${r.count} joins within ${settings.moderation.raid.joinWindowMs / 1000}s. Review new members and consider enabling a higher verification level.`, STATUS_COLORS.error);
    }
    if (r.newAccount) {
      await this.securityLog(member.guild, settings, 'New account joined', `${safeText(member.user.tag ?? member.user.username)} (<@${member.id}>) — account created <t:${Math.floor(member.user.createdTimestamp / 1000)}:R>.`, STATUS_COLORS.warn);
      if (r.raid && settings.moderation.raid.autoTimeoutNewAccountsDuringRaid) {
        await enforce({ db: this.db, config: this.config, settings, logger: this.logger, guild: member.guild, action: 'timeout', target: member, durationMs: 30 * 60000, reason: 'Raid protection: new account during raid', rule: 'raid', automatic: true });
      }
    }
    return r;
  }

  async securityLog(guild, settings, title, description, color) {
    await sendToChannel(guild, settings.channels.securityLog, { embeds: [guardianEmbed('knight', { title, description, color })] }, this.logger);
  }
}
