// /voice (diagnostics + per-server voice settings) and /settings (view/reset).
import { SlashCommandBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import { getGuildSettings, setGuildSetting, resetGuildSettings, initGuildSettings } from '../../core/settings.js';
import { authLevel, AUTH, canUseAlpha } from '../../core/auth.js';
import { audit } from '../../core/audit.js';
import { guardianEmbed, safeText, STATUS_COLORS } from '../../core/discord/theme.js';
import { guildUsageToday } from '../../ai/usage.js';
import { activeStreams } from '../../features/music/discordAdapter.js';

const eph = { flags: MessageFlags.Ephemeral };
const levelOf = (i, app) => authLevel({ userId: i.user.id, config: app.config, member: i.member, guild: i.guild, settings: getGuildSettings(app.db, i.guildId) });
const langLabel = (s, app) => (s.voice.language === '' ? 'auto' : s.voice.language ?? (app.config.stt.language || 'auto'));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

export function configCommands({ listener, music }) {
  return [
    {
      data: new SlashCommandBuilder().setName('voice').setDescription('Voice assistant diagnostics and settings for this server')
        .addSubcommand((s) => s.setName('diagnostics').setDescription('Pipeline status, timings and quality (no audio or transcripts)'))
        .addSubcommand((s) => s.setName('settings').setDescription('Voice recognition settings (admins)')
          .addStringOption((o) => o.setName('language').setDescription('ISO-639-1 code (en, hi, es…) or "auto"').setMaxLength(4))
          .addBooleanOption((o) => o.setName('echo').setDescription('Post what was heard in the alpha channel'))
          .addStringOption((o) => o.setName('add_word').setDescription('Add a name/word to help recognition (e.g. a game or artist)').setMaxLength(40))
          .addStringOption((o) => o.setName('remove_word').setDescription('Remove a vocabulary word').setMaxLength(40))
          .addIntegerOption((o) => o.setName('daily_limit').setDescription('Max voice commands per day for this server').setMinValue(0).setMaxValue(5000))),
      async execute(i, app) {
        const sub = i.options.getSubcommand();
        const s = getGuildSettings(app.db, i.guildId);
        if (sub === 'diagnostics') {
          if (!canUseAlpha(i.user.id, app.config, { member: i.member, guild: i.guild, settings: s }) && levelOf(i, app) < AUTH.ADMIN) {
            return i.reply({ content: 'Diagnostics are available to admins and users trusted with ALPHA.', ...eph });
          }
          const stt = app.stt.status();
          const session = listener?.sessions.get(i.guildId);
          const conn = listener?.hub.get(i.guildId);
          const runs = listener?.pipeline.diagnosticsFor(i.guildId) ?? [];
          const counts = runs.reduce((acc, r) => ({ ...acc, [r.reason ?? r.status]: (acc[r.reason ?? r.status] ?? 0) + 1 }), {});
          const transcribed = runs.filter((r) => r.sttMs != null);
          const limit = s.voice.dailyLimit ?? app.config.stt.guildDailyLimit;
          const embed = guardianEmbed('aegis', {
            title: 'Voice diagnostics',
            color: stt.enabled && !stt.circuitOpen ? STATUS_COLORS.ok : STATUS_COLORS.warn,
            fields: [
              { name: 'Speech-to-text', value: `${stt.provider}${stt.model ? ` · ${stt.model}` : ''} · ${stt.enabled ? (stt.circuitOpen ? '⚠️ paused (errors/rate limit)' : '✅ available') : '❌ not configured'}\nLanguage: ${langLabel(s, app)} · wake word: ${app.config.voice.wakeWord}`, inline: false },
              { name: 'Usage today', value: `this server ${guildUsageToday(app.db, i.guildId, 'stt')}/${limit} · deployment ${stt.usedToday ?? 0}/${stt.dailyLimit ?? '—'}`, inline: true },
              { name: 'Listening', value: session ? `yes, in <#${session.channelId}> since <t:${Math.floor(session.startedAt / 1000)}:R>` : 'no', inline: true },
              { name: 'Voice connection', value: conn ? conn.state.status : 'none', inline: true },
              { name: `Last ${runs.length} utterances`, value: runs.length ? Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(' · ') : 'none yet' },
              {
                name: 'Timing & quality (median)',
                value: transcribed.length
                  ? `capture ${median(transcribed.map((r) => r.captureMs ?? 0))} ms · STT ${median(transcribed.map((r) => r.sttMs))} ms · total ${median(transcribed.map((r) => r.totalMs))} ms\nconfidence ${median(transcribed.map((r) => r.confidence))} · pauses restored ${median(transcribed.map((r) => r.gapsFilledMs ?? 0))} ms · decode errors ${transcribed.reduce((a, r) => a + (r.decodeErrors ?? 0), 0)}`
                  : '—',
              },
              { name: 'Music', value: `queue ${music?.peek(i.guildId)?.queue.length ?? 0} · active streams (all servers) ${activeStreams()}/${app.config.music.maxStreams}`, inline: true },
            ],
            footer: 'AEGIS • audio and transcript text are never stored or shown here',
          });
          return i.reply({ embeds: [embed], ...eph });
        }
        if (levelOf(i, app) < AUTH.ADMIN) return i.reply({ content: 'Admins only.', ...eph });
        const set = (path, v) => {
          setGuildSetting(app.db, i.guildId, path, v);
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'aegis', action: 'settings.update', target: path, params: { value: v }, outcome: 'success' });
        };
        const lang = i.options.getString('language')?.trim().toLowerCase();
        if (lang) {
          if (lang !== 'auto' && !/^[a-z]{2}$/.test(lang)) return i.reply({ content: 'Use a two-letter ISO-639-1 code (en, hi, es, …) or "auto".', ...eph });
          set('voice.language', lang === 'auto' ? '' : lang);
        }
        const echo = i.options.getBoolean('echo');
        if (echo != null) set('voice.echoTranscripts', echo);
        const vocab = new Set(s.voice.vocabulary);
        const add = i.options.getString('add_word')?.trim();
        const rem = i.options.getString('remove_word')?.trim();
        if (add) {
          if (vocab.size >= 30) return i.reply({ content: 'At most 30 vocabulary words.', ...eph });
          vocab.add(add);
        }
        if (rem) vocab.delete(rem);
        if (add || rem) set('voice.vocabulary', [...vocab]);
        const lim = i.options.getInteger('daily_limit');
        if (lim != null) set('voice.dailyLimit', lim);
        return i.reply({ content: '✅ Voice settings saved. Vocabulary words are sent to the speech-to-text provider with each voice command.', ...eph });
      },
    },
    {
      data: new SlashCommandBuilder().setName('settings').setDescription('View or reset this server\'s Soul Society settings').setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((s) => s.setName('view').setDescription('Show all settings for this server'))
        .addSubcommand((s) => s.setName('reset').setDescription('Reset ALL settings to defaults (server owner only)')
          .addStringOption((o) => o.setName('confirm').setDescription('Type RESET to confirm').setRequired(true))),
      async execute(i, app) {
        const level = levelOf(i, app);
        if (level < AUTH.ADMIN) return i.reply({ content: 'Admins only.', ...eph });
        const sub = i.options.getSubcommand();
        if (sub === 'reset') {
          if (level < AUTH.OWNER) return i.reply({ content: 'Only the server owner can reset all settings.', ...eph });
          if (i.options.getString('confirm') !== 'RESET') return i.reply({ content: 'Not reset. Type RESET exactly to confirm.', ...eph });
          resetGuildSettings(app.db, i.guildId);
          initGuildSettings(app.db, i.guildId);
          setGuildSetting(app.db, i.guildId, 'meta.knightIntroAt', new Date().toISOString());
          setGuildSetting(app.db, i.guildId, 'meta.aegisIntroAt', new Date().toISOString());
          audit(app.db, { guildId: i.guildId, actorId: i.user.id, bot: 'aegis', action: 'settings.reset', outcome: 'success' });
          return i.reply({ content: '✅ All settings were reset to safe defaults (moderation back in simulation mode).', ...eph });
        }
        const s = getGuildSettings(app.db, i.guildId);
        const chan = (v) => (v ? `<#${v}>` : '—');
        const embed = guardianEmbed('aegis', {
          title: `Settings — ${safeText(s.branding.displayName ?? i.guild.name, 80)}`,
          fields: [
            { name: 'Channels', value: Object.entries(s.channels).map(([k, v]) => `${k}: ${chan(v)}`).join('\n') },
            { name: 'ALPHA access', value: `server owner${s.alpha.trustedUserIds.length ? ` · users ${s.alpha.trustedUserIds.map((u) => `<@${u}>`).join(' ')}` : ''}${s.alpha.trustedRoleIds.length ? ` · roles ${s.alpha.trustedRoleIds.map((r) => `<@&${r}>`).join(' ')}` : ''}\ntyped prefix ${s.alpha.textPrefixEnabled ? 'on' : 'off'} · confirm medium voice ${s.alpha.confirmMediumFromVoice ? 'on' : 'off'}`, inline: false },
            { name: 'Voice', value: `language ${langLabel(s, app)} · echo ${s.voice.echoTranscripts ? 'on' : 'off'} · vocabulary ${s.voice.vocabulary.length} · daily limit ${s.voice.dailyLimit ?? app.config.stt.guildDailyLimit}`, inline: false },
            { name: 'Music', value: `volume ${s.music.volume}% · DJ role ${s.music.djRoleId ? `<@&${s.music.djRoleId}>` : 'none'} · announce ${s.music.announceTracks ? 'on' : 'off'}`, inline: false },
            { name: 'Welcome', value: `${s.welcome.enabled ? 'on' : 'off'} · ${s.welcome.format} · tagline "${safeText(s.welcome.tagline, 40)}" · background ${s.welcome.background ? 'custom' : 'default'}`, inline: false },
            { name: 'Moderation (KNIGHT)', value: `${s.moderation.simulate ? '🧪 simulation' : '⚔️ enforcing'} · voice moderation ${s.moderation.voice.enabled ? 'on' : 'off'} · use /modconfig`, inline: false },
            { name: 'Reports', value: `daily ${s.reports.dailyEnabled ? s.reports.dailyTime : 'off'} · weekly ${s.reports.weeklyEnabled ? 'on' : 'off'}`, inline: true },
            { name: 'Economy', value: `season ${s.progression.season} · progression ${s.progression.enabled ? 'on' : 'off'}`, inline: true },
          ],
        });
        return i.reply({ embeds: [embed], allowedMentions: { parse: [] }, ...eph });
      },
    },
  ];
}
