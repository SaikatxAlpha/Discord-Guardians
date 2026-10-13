// KNIGHT slash commands.
import { SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags } from 'discord.js';
import { parseDuration, formatDuration } from '../../core/time.js';
import { getGuildSettings, setGuildSetting } from '../../core/settings.js';
import { authLevel, AUTH } from '../../core/auth.js';
import { audit } from '../../core/audit.js';
import { guardianEmbed, safeText, STATUS_COLORS } from '../../core/discord/theme.js';
import { listCases } from '../../features/moderation/enforce.js';
import { checkProfanity } from '../../features/moderation/filter.js';
import { activePoints, decideEscalation } from '../../features/moderation/escalation.js';

const P = PermissionFlagsBits;
const memberRef = (u) => `<@${u.id}>`;
const eph = { flags: MessageFlags.Ephemeral };

function requireAdmin(interaction, app) {
  if (authLevel({ userId: interaction.user.id, config: app.config, member: interaction.member, guild: interaction.guild, settings: getGuildSettings(app.db, interaction.guildId) }) < AUTH.ADMIN) {
    interaction.reply({ content: 'You need Manage Server permission for this.', ...eph });
    return false;
  }
  return true;
}

function changeSetting(app, interaction, path, value) {
  setGuildSetting(app.db, interaction.guildId, path, value);
  audit(app.db, { guildId: interaction.guildId, actorId: interaction.user.id, bot: 'knight', action: 'settings.update', target: path, params: { value }, outcome: 'success' });
}

export function knightCommands(automod, voiceMod) {
  return [
    {
      data: new SlashCommandBuilder().setName('warn').setDescription('Warn a member').setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
      execute: (i, app) => app.runSteps(i, [{ action: 'mod.warn', params: { member: memberRef(i.options.getUser('member')), reason: i.options.getString('reason') } }]),
    },
    {
      data: new SlashCommandBuilder().setName('timeout').setDescription('Timeout a member').setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('duration').setDescription('e.g. 10m, 1h, 2d (max 28d)').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
      async execute(i, app) {
        const ms = parseDuration(i.options.getString('duration'));
        if (!ms) return i.reply({ content: 'Could not read that duration. Try 10m, 1h or 2d.', ...eph });
        return app.runSteps(i, [{ action: 'mod.timeout', params: { member: memberRef(i.options.getUser('member')), durationMs: ms, reason: i.options.getString('reason') } }]);
      },
    },
    {
      data: new SlashCommandBuilder().setName('untimeout').setDescription('Remove a timeout').setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)),
      execute: (i, app) => app.runSteps(i, [{ action: 'mod.untimeout', params: { member: memberRef(i.options.getUser('member')) } }]),
    },
    {
      data: new SlashCommandBuilder().setName('kick').setDescription('Kick a member').setDefaultMemberPermissions(P.KickMembers)
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400)),
      execute: (i, app) => app.runSteps(i, [{ action: 'mod.kick', params: { member: memberRef(i.options.getUser('member')), reason: i.options.getString('reason') } }]),
    },
    {
      data: new SlashCommandBuilder().setName('ban').setDescription('Ban a member').setDefaultMemberPermissions(P.BanMembers)
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true))
        .addStringOption((o) => o.setName('reason').setDescription('Reason').setMaxLength(400))
        .addIntegerOption((o) => o.setName('delete_days').setDescription('Delete their recent messages (days)').setMinValue(0).setMaxValue(7)),
      execute: (i, app) =>
        app.runSteps(i, [{ action: 'mod.ban', params: { member: memberRef(i.options.getUser('member')), reason: i.options.getString('reason'), deleteMessageSeconds: (i.options.getInteger('delete_days') ?? 0) * 86400 } }]),
    },
    {
      data: new SlashCommandBuilder().setName('unban').setDescription('Unban a user by ID').setDefaultMemberPermissions(P.BanMembers)
        .addStringOption((o) => o.setName('user_id').setDescription('User ID').setRequired(true)),
      execute: (i, app) => app.runSteps(i, [{ action: 'mod.unban', params: { userId: i.options.getString('user_id').trim() } }]),
    },
    {
      data: new SlashCommandBuilder().setName('lockdown').setDescription('Lock or unlock a channel for @everyone').setDefaultMemberPermissions(P.ManageChannels)
        .addChannelOption((o) => o.setName('channel').setDescription('Channel').addChannelTypes(ChannelType.GuildText).setRequired(true))
        .addBooleanOption((o) => o.setName('enable').setDescription('true = lock, false = unlock').setRequired(true)),
      execute: (i, app) => app.runSteps(i, [{ action: 'security.lockdown', params: { channel: `<#${i.options.getChannel('channel').id}>`, enable: i.options.getBoolean('enable') } }]),
    },
    {
      data: new SlashCommandBuilder().setName('cases').setDescription('Moderation history for a member').setDefaultMemberPermissions(P.ModerateMembers)
        .addUserOption((o) => o.setName('member').setDescription('Member').setRequired(true)),
      async execute(i, app) {
        const user = i.options.getUser('member');
        const cases = listCases(app.db, i.guildId, user.id);
        const s = getGuildSettings(app.db, i.guildId);
        const pts = activePoints(app.db, i.guildId, user.id, s.moderation.escalation.decayHours);
        const lines = cases.map((c) => `\`#${c.id}\` <t:${Math.floor(c.created_at / 1000)}:d> **${c.action}**${c.simulated ? ' (sim)' : ''} · ${c.rule ?? 'manual'} · ${c.result} — ${safeText(c.reason ?? '', 120)}`);
        return i.reply({ embeds: [guardianEmbed('knight', { title: `Cases — ${user.username}`, description: lines.join('\n') || 'No cases.', fields: [{ name: 'Active points', value: `${pts} (decay ${s.moderation.escalation.decayHours}h)` }] })], ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('modreport').setDescription('Moderation statistics').setDefaultMemberPermissions(P.ModerateMembers)
        .addStringOption((o) => o.setName('period').setDescription('Period').addChoices({ name: 'today', value: 'today' }, { name: 'week', value: 'week' }, { name: 'month', value: 'month' })),
      execute: (i, app) => app.runSteps(i, [{ action: 'report.moderation', params: { period: i.options.getString('period') ?? 'week' } }], { ephemeral: true }),
    },
    {
      data: new SlashCommandBuilder().setName('simulate').setDescription('Test text against KNIGHT rules without taking action').setDefaultMemberPermissions(P.ModerateMembers)
        .addStringOption((o) => o.setName('text').setDescription('Text to test').setRequired(true).setMaxLength(1000))
        .addUserOption((o) => o.setName('as_member').setDescription('Preview escalation for this member')),
      async execute(i, app) {
        const s = getGuildSettings(app.db, i.guildId);
        const p = checkProfanity(i.options.getString('text'), automod.matcherFor(i.guildId, s.moderation.profanity));
        const fields = [{ name: 'Profanity', value: p.matched ? `${p.severity} — ${p.terms.join(', ')}${p.contextual ? ' (inside quote/code → review only)' : ''}` : 'clean' }];
        if (p.matched && !p.contextual) {
          const target = i.options.getUser('as_member') ?? i.user;
          const before = activePoints(app.db, i.guildId, target.id, s.moderation.escalation.decayHours);
          const d = decideEscalation({ before, add: s.moderation.escalation.points[p.severity], escalation: s.moderation.escalation });
          fields.push({ name: 'Would apply', value: `${d.action}${d.durationMs ? ` ${formatDuration(d.durationMs)}` : ''} (points ${d.before} → ${d.after})${s.moderation.simulate ? '\nGuild is in SIMULATION mode: automod only logs.' : ''}` });
        }
        return i.reply({ embeds: [guardianEmbed('knight', { title: 'Rule simulation (no action taken)', fields })], ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('modconfig').setDescription('Configure KNIGHT moderation').setDefaultMemberPermissions(P.ManageGuild)
        .addSubcommand((s) => s.setName('view').setDescription('Show moderation settings'))
        .addSubcommand((s) => s.setName('simulate').setDescription('Automod simulation mode').addBooleanOption((o) => o.setName('enabled').setDescription('true = log only').setRequired(true)))
        .addSubcommand((s) => s.setName('logs').setDescription('Set log channels')
          .addChannelOption((o) => o.setName('security_log').setDescription('Private security log').addChannelTypes(ChannelType.GuildText))
          .addChannelOption((o) => o.setName('mod_log').setDescription('Moderation case log').addChannelTypes(ChannelType.GuildText)))
        .addSubcommand((s) => s.setName('exempt').setDescription('Exempt a role from automod').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)).addBooleanOption((o) => o.setName('add').setDescription('true = add, false = remove').setRequired(true)))
        .addSubcommand((s) => s.setName('protect').setDescription('Protect a role from moderation').addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true)).addBooleanOption((o) => o.setName('add').setDescription('true = add, false = remove').setRequired(true)))
        .addSubcommand((s) => s.setName('word').setDescription('Block or allow a word')
          .addStringOption((o) => o.setName('word').setDescription('Word').setRequired(true).setMaxLength(40))
          .addStringOption((o) => o.setName('mode').setDescription('Mode').setRequired(true).addChoices({ name: 'block', value: 'block' }, { name: 'unblock', value: 'unblock' }, { name: 'allow (false positive)', value: 'allow' }, { name: 'unallow', value: 'unallow' })))
        .addSubcommand((s) => s.setName('voice').setDescription('Voice moderation settings')
          .addBooleanOption((o) => o.setName('enabled').setDescription('Enable voice moderation (tell members!)').setRequired(true))
          .addNumberOption((o) => o.setName('min_confidence').setDescription('0.5–0.99; below this → review queue').setMinValue(0.5).setMaxValue(0.99))
          .addStringOption((o) => o.setName('max_action').setDescription('Strongest automatic action').addChoices({ name: 'warn', value: 'warn' }, { name: 'timeout', value: 'timeout' })))
        .addSubcommand((s) => s.setName('spam').setDescription('Spam thresholds')
          .addIntegerOption((o) => o.setName('flood_count').setDescription('Messages within 8s').setMinValue(3).setMaxValue(30))
          .addIntegerOption((o) => o.setName('mention_limit').setDescription('Mentions per message').setMinValue(2).setMaxValue(50))
          .addBooleanOption((o) => o.setName('block_invites').setDescription('Treat Discord invites as spam'))),
      async execute(i, app) {
        if (!requireAdmin(i, app)) return;
        const sub = i.options.getSubcommand();
        const s = getGuildSettings(app.db, i.guildId);
        const m = s.moderation;
        if (sub === 'view') {
          return i.reply({
            embeds: [guardianEmbed('knight', {
              title: 'KNIGHT moderation settings',
              fields: [
                { name: 'Mode', value: m.simulate ? '🧪 SIMULATION (automod logs only)' : '⚔️ ENFORCING', inline: true },
                { name: 'Logs', value: `security: ${s.channels.securityLog ? `<#${s.channels.securityLog}>` : 'unset'}\ncases: ${s.channels.modLog ? `<#${s.channels.modLog}>` : 'unset'}`, inline: true },
                { name: 'Exempt roles', value: m.exemptRoleIds.map((r) => `<@&${r}>`).join(' ') || 'none', inline: true },
                { name: 'Protected roles', value: m.protectedRoleIds.map((r) => `<@&${r}>`).join(' ') || 'none', inline: true },
                { name: 'Escalation', value: m.escalation.steps.map((x) => `${x.points} pts → ${x.action}${x.durationMs ? ` ${formatDuration(x.durationMs)}` : ''}`).join('\n') },
                { name: 'Spam', value: `flood ${m.spam.floodCount}/${m.spam.floodWindowMs / 1000}s · dup ${m.spam.duplicateCount} · mentions ${m.spam.mentionLimit} · invites ${m.spam.blockInvites ? 'blocked' : 'allowed'}` },
                { name: 'Voice moderation', value: `${m.voice.enabled ? 'ON' : 'off'} · min confidence ${m.voice.minConfidence} · max auto action ${m.voice.maxAutoAction}` },
                { name: 'Custom words', value: `blocked: ${m.profanity.extraWords.length} · allowed: ${m.profanity.allowWords.length}` },
              ],
            })],
            ...eph,
          });
        }
        if (sub === 'simulate') changeSetting(app, i, 'moderation.simulate', i.options.getBoolean('enabled'));
        if (sub === 'logs') {
          const sec = i.options.getChannel('security_log');
          const mod = i.options.getChannel('mod_log');
          if (sec) changeSetting(app, i, 'channels.securityLog', sec.id);
          if (mod) changeSetting(app, i, 'channels.modLog', mod.id);
        }
        if (sub === 'exempt' || sub === 'protect') {
          const key = sub === 'exempt' ? 'exemptRoleIds' : 'protectedRoleIds';
          const role = i.options.getRole('role');
          const set = new Set(m[key]);
          i.options.getBoolean('add') ? set.add(role.id) : set.delete(role.id);
          changeSetting(app, i, `moderation.${key}`, [...set]);
        }
        if (sub === 'word') {
          const w = i.options.getString('word').toLowerCase().trim();
          const mode = i.options.getString('mode');
          const key = mode === 'block' || mode === 'unblock' ? 'extraWords' : 'allowWords';
          const set = new Set(m.profanity[key]);
          mode === 'block' || mode === 'allow' ? set.add(w) : set.delete(w);
          changeSetting(app, i, `moderation.profanity.${key}`, [...set]);
        }
        if (sub === 'voice') {
          changeSetting(app, i, 'moderation.voice.enabled', i.options.getBoolean('enabled'));
          const c = i.options.getNumber('min_confidence');
          if (c != null) changeSetting(app, i, 'moderation.voice.minConfidence', c);
          const a = i.options.getString('max_action');
          if (a) changeSetting(app, i, 'moderation.voice.maxAutoAction', a);
        }
        if (sub === 'spam') {
          const f = i.options.getInteger('flood_count');
          const ml = i.options.getInteger('mention_limit');
          const bi = i.options.getBoolean('block_invites');
          if (f != null) changeSetting(app, i, 'moderation.spam.floodCount', f);
          if (ml != null) changeSetting(app, i, 'moderation.spam.mentionLimit', ml);
          if (bi != null) changeSetting(app, i, 'moderation.spam.blockInvites', bi);
        }
        return i.reply({ content: '✅ Moderation settings updated.', ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('voicemod').setDescription('KNIGHT voice moderation in your current voice channel').setDefaultMemberPermissions(P.ManageGuild)
        .addSubcommand((s) => s.setName('start').setDescription('Join your voice channel and moderate speech'))
        .addSubcommand((s) => s.setName('stop').setDescription('Stop voice moderation')),
      async execute(i, app) {
        if (!requireAdmin(i, app)) return;
        if (i.options.getSubcommand() === 'stop') return i.reply({ content: voiceMod.stop(i.guildId) ? 'Voice moderation stopped.' : 'Voice moderation was not running.', ...eph });
        const vc = i.member.voice?.channelId;
        if (!vc) return i.reply({ content: 'Join a voice channel first.', ...eph });
        await i.deferReply(eph);
        try {
          await voiceMod.start(i.guild, vc);
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'knight', action: 'voicemod.start', target: vc, outcome: 'success' });
          return i.editReply(`🎙️ KNIGHT is moderating <#${vc}>. Uncertain transcripts go to /reviews; automatic action is capped at **${getGuildSettings(app.db, i.guildId).moderation.voice.maxAutoAction}**.`);
        } catch (err) {
          return i.editReply(`Could not start: ${err.message}`);
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('reviews').setDescription('Uncertain voice-moderation transcripts awaiting review').setDefaultMemberPermissions(P.ModerateMembers)
        .addIntegerOption((o) => o.setName('dismiss').setDescription('Dismiss review #id')),
      async execute(i, app) {
        const id = i.options.getInteger('dismiss');
        if (id) {
          const r = app.db.run(`UPDATE voice_reviews SET status = 'dismissed', reviewed_by = ? WHERE id = ? AND guild_id = ? AND status = 'open'`, i.user.id, id, i.guildId);
          return i.reply({ content: r.changes ? `Review #${id} dismissed.` : 'No open review with that ID.', ...eph });
        }
        const rows = app.db.all(`SELECT * FROM voice_reviews WHERE guild_id = ? AND status = 'open' ORDER BY id DESC LIMIT 15`, i.guildId);
        const lines = rows.map((r) => `\`#${r.id}\` <@${r.user_id}> · ${(r.confidence * 100).toFixed(0)}% · "${safeText(r.transcript, 120)}"`);
        return i.reply({ embeds: [guardianEmbed('knight', { title: 'Voice review queue', color: STATUS_COLORS.warn, description: lines.join('\n') || 'Nothing to review.' })], ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('knight-status').setDescription('Guardian system health'),
      execute: (i, app) => app.runSteps(i, [{ action: 'system.status', params: {} }], { ephemeral: true }),
    },
  ];
}
