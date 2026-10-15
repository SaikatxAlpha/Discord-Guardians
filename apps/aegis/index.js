// AEGIS — The Ancient Guardian. Intelligence, administration and automation.
import { GatewayIntentBits, Events, Partials, ChannelType, MessageFlags } from 'discord.js';
import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import { pathToFileURL } from 'node:url';
import { GuardianBot } from '../shared/botBase.js';
import { spokenSummary } from '../shared/render.js';
import { aegisHandlers, aegisJobs } from './handlers.js';
import { takePick, enqueueTrack, targetVoiceChannel } from './music.js';
import { aegisCommands, onEventJoinButton } from './commands.js';
import { syncReportJobs } from './reports.js';
import { VoiceHub } from '../../features/voice/hub.js';
import { VoicePipeline } from '../../features/voice/pipeline.js';
import { AlphaListener } from '../../features/voice/listener.js';
import { synthesize, ttsAvailable } from '../../features/voice/tts.js';
import { MusicManager } from '../../features/music/manager.js';
import { createMusicAdapter, killAllStreams } from '../../features/music/discordAdapter.js';
import { detectFfmpeg, engineDescription } from '../../features/music/audioEngine.js';
import { describeTrack } from '../../features/music/providers.js';
import { onMemberJoin, onMemberLeave } from '../../features/welcome/handler.js';
import { recordMessageActivity } from '../../features/intelligence/analytics.js';
import { rewardMessage, rewardVoiceMinute, isVoiceEligible, seedShop } from '../../features/progression/economy.js';
import { buildWakeMatcher } from '../../features/voice/wakeword.js';
import { canUseAlpha } from '../../core/auth.js';
import { getGuildSettings } from '../../core/settings.js';
import { checkRoleManageable } from '../../core/discord/safety.js';
import { sendToChannel } from '../../core/discord/send.js';
import { guardianEmbed, safeText, STATUS_COLORS } from '../../core/discord/theme.js';

export const AEGIS_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildScheduledEvents,
];

export function createAegis() {
  const app = new GuardianBot({ name: 'aegis', intents: AEGIS_INTENTS, partials: [Partials.GuildMember] });
  const { db, config, logger, client } = app;
  const hub = new VoiceHub({ bot: 'aegis', logger });
  const textWake = buildWakeMatcher(config.voice.wakeWord);
  const music = new MusicManager({
    db,
    logger,
    idleLeaveMs: config.music.idleLeaveMs,
    maxQueue: config.music.maxQueue,
    defaultVolume: config.music.defaultVolume,
    adapterFor: (guild) => createMusicAdapter({ guild, hub, maxStreams: config.music.maxStreams, logger }),
  });

  // ---------------------------------------------------------------- spoken responses
  async function speak(guild, text) {
    const s = getGuildSettings(db, guild.id);
    if (!config.tts.enabled || !s.alpha.speakResponses || !ttsAvailable()) return;
    const conn = hub.get(guild.id);
    if (!conn) return;
    try {
      const wav = await synthesize(text);
      const ff = new prism.FFmpeg({ args: ['-analyzeduration', '0', '-loglevel', '0', '-i', '-', '-f', 's16le', '-ar', '48000', '-ac', '2'] });
      ff.end(wav);
      const tts = createAudioPlayer();
      const gm = music.peek(guild.id);
      const wasPlaying = gm?.status === AudioPlayerStatus.Playing;
      if (wasPlaying) gm.pause();
      conn.subscribe(tts);
      tts.play(createAudioResource(ff, { inputType: StreamType.Raw }));
      await entersState(tts, AudioPlayerStatus.Idle, 30000).catch(() => null);
      tts.stop(true);
      if (gm?.player) conn.subscribe(gm.player);
      if (wasPlaying) gm.resume();
    } catch (err) {
      logger.warn('spoken response failed', { err: err.message });
    }
  }

  // ---------------------------------------------------------------- ALPHA voice
  // Speaker policy is evaluated per server: its owner plus the users/roles it trusts.
  const allowSpeaker = (guild, userId) =>
    canUseAlpha(userId, config, { guild, settings: getGuildSettings(db, guild.id), member: guild.members.cache.get(userId) ?? null });
  const sttWarnedAt = new Map(); // guildId -> ts (throttle notices per server)
  const STT_ERRORS = {
    limit_guild: "This server's daily voice-command limit was reached. Use `/alpha` or type \"ALPHA, ...\" until tomorrow.",
    limit_global: 'The daily speech-to-text allowance is used up. Use `/alpha` or type "ALPHA, ..." until tomorrow.',
    rate_limited: 'Speech-to-text is rate limited right now; voice commands will resume shortly.',
    unavailable: 'Speech-to-text is not configured on this deployment.',
    failed: 'Speech-to-text did not respond. Please try again.',
  };
  const pipeline = new VoicePipeline({
    stt: app.stt,
    config,
    authorize: (u) => {
      const guild = client.guilds.cache.get(u.guildId);
      return Boolean(guild) && allowSpeaker(guild, u.userId);
    },
    guildOptions: (guildId) => {
      const s = getGuildSettings(db, guildId);
      return { language: s.voice.language ?? undefined, vocabulary: s.voice.vocabulary, guildLimit: s.voice.dailyLimit ?? config.stt.guildDailyLimit };
    },
    handleCommand: (req) => app.coordinator.handleText(req),
    onEvent: async (ev) => {
      const guild = client.guilds.cache.get(ev.guildId);
      const session = listener.sessions.get(ev.guildId);
      if (!guild || !session) return;
      const s = getGuildSettings(db, guild.id);
      if (ev.type === 'heard') {
        if (s.voice.echoTranscripts) {
          const note = ev.forceConfirm ? ' — not fully sure, so I will ask before changing anything' : '';
          await sendToChannel(guild, session.textChannelId, { content: `🎙️ <@${ev.userId}>: “${safeText(ev.command, 300)}” (${Math.round(ev.confidence * 100)}%${note})` }, logger);
        }
      } else if (ev.type === 'repeat') {
        await sendToChannel(guild, session.textChannelId, { content: `🎙️ <@${ev.userId}>, I didn't catch that clearly — please repeat. Nothing was done.` }, logger);
      } else if (ev.type === 'result') {
        await app.postResponse(guild, session.textChannelId, ev.result);
        await speak(guild, spokenSummary(ev.result));
      } else if (ev.type === 'stt_error' && Date.now() - (sttWarnedAt.get(guild.id) ?? 0) > 60000) {
        sttWarnedAt.set(guild.id, Date.now());
        logger.warn('voice transcription unavailable', { guildId: guild.id, code: ev.code });
        await sendToChannel(guild, session.textChannelId, { embeds: [guardianEmbed('aegis', { title: 'Voice commands paused', color: STATUS_COLORS.warn, description: STT_ERRORS[ev.code] ?? STT_ERRORS.failed })] }, logger);
      }
    },
  });
  const updatePresence = () => {
    const n = listener.sessions.size;
    client.user?.setPresence({ activities: [{ name: 'status', type: 4, state: n ? `🎙️ Listening for ${config.voice.wakeWord} in ${n} server${n > 1 ? 's' : ''}` : app.theme.presence }], status: 'online' });
  };
  const listener = new AlphaListener({
    hub,
    pipeline,
    config,
    logger,
    allowSpeaker,
    onChange: (guildId, on) => {
      updatePresence();
      logger.info(on ? 'voice listening started' : 'voice listening stopped', { guildId });
      if (!on) {
        const guild = client.guilds.cache.get(guildId);
        const s = guild && getGuildSettings(db, guildId);
        if (guild && s.channels.alpha) sendToChannel(guild, s.channels.alpha, { content: `🔇 ${config.voice.wakeWord} stopped listening. Audio capture is off.` }, logger);
      }
    },
  });

  app.extraContext = () => ({ music, listener, hub });
  app.addHandlers(aegisHandlers());
  Object.assign(app.jobHandlers, aegisJobs(app));
  app.addCommands(aegisCommands({ listener, music }));
  app.buttons.set('event:join', onEventJoinButton);
  app.buttons.set('music:pick', async (i) => {
    const p = takePick(i.customId.split(':')[2], i.user.id);
    if (p.error) return i.reply({ content: p.error, flags: MessageFlags.Ephemeral });
    const track = p.results[Number(i.values[0])];
    const guild = await app.getGuild(p.guildId);
    const ctx = { music, listener, guild, request: { userId: i.user.id, source: 'slash' } };
    // Re-check at pick time: the user may have moved channels since searching.
    const target = await targetVoiceChannel(ctx);
    if (target.error) return i.reply({ content: target.error, flags: MessageFlags.Ephemeral });
    await i.deferUpdate();
    const r = await enqueueTrack(ctx, track, target.channelId, p.textChannelId ?? i.channelId).catch((err) => ({ ok: false, message: `Couldn't play that track: ${err.message}` }));
    await i.editReply({ content: r.message, components: [], embeds: [] });
  });

  // ---------------------------------------------------------------- music notifications (wired once per server)
  music.onCreate((gm) => {
    const post = (content, always = false) =>
      client.guilds
        .fetch(gm.guildId)
        .then((g) => (always || getGuildSettings(db, g.id).music.announceTracks ? sendToChannel(g, gm.textChannelId, { content }, logger) : null))
        .catch(() => null);
    // Errors while answering a /play are already in that reply; don't post them twice.
    gm.on('trackError', (track, err, info) => !info?.viaRequest && post(`⚠️ Could not play **${safeText(track?.title ?? 'track', 100)}** (${safeText(err.message, 150)}). ${info?.fallback ? 'Trying another upload of the same song.' : 'Skipping.'}`, true));
    gm.on('halted', () => post('⛔ Several tracks failed in a row; playback stopped.', true));
    gm.on('disconnected', () => post('🔌 Lost the voice connection. The queue was saved — use /play to continue.', true));
    gm.on('trackStart', (t, info) => !info?.viaRequest && post(`🎶 Now playing **${safeText(describeTrack(t), 150)}**`));
  });

  // ---------------------------------------------------------------- level rewards
  async function onLevelUp(guild, member, level, channel) {
    const s = getGuildSettings(db, guild.id);
    for (const [lvl, roleId] of Object.entries(s.progression.levelRoles)) {
      if (level < Number(lvl) || member.roles.cache.has(roleId)) continue;
      const role = guild.roles.cache.get(roleId);
      if (role && checkRoleManageable({ role, botMember: guild.members.me, actor: null, guild, config }).ok) {
        await member.roles.add(role, `Reached level ${lvl}`).catch((err) => logger.warn('level role failed', { err: err.message }));
      }
    }
    if (channel) await channel.send({ content: `✦ **${safeText(member.displayName, 60)}** ascended to **level ${level}**!`, allowedMentions: { parse: [] } }).catch(() => null);
  }

  // ---------------------------------------------------------------- events
  client.on(Events.MessageCreate, async (message) => {
    if (!message.guild || message.author.bot || message.webhookId || message.system) return;
    try {
      recordMessageActivity(db, { guildId: message.guild.id, channelId: message.channelId, userId: message.author.id, tz: config.timezone });
      const s = getGuildSettings(db, message.guild.id);
      // Typed ALPHA commands (server owner / trusted only; ignored silently for others).
      const typed = s.alpha.textPrefixEnabled ? textWake.detect(message.content.slice(0, 600)) : { activated: false };
      if (typed.activated && allowSpeaker(message.guild, message.author.id) && (!s.channels.alpha || s.channels.alpha === message.channelId)) {
        await message.channel.sendTyping().catch(() => null);
        const res = await app.coordinator.handleText({ requestId: `msg:${message.id}`, guildId: message.guild.id, channelId: message.channelId, userId: message.author.id, member: message.member, source: 'text', text: typed.command || 'help' });
        await app.postResponse(message.guild, message.channelId, res);
        return;
      }
      const r = rewardMessage(db, { guildId: message.guild.id, userId: message.author.id, messageId: message.id, content: message.content, settings: s, tz: config.timezone });
      if (r.levelUp && message.member) await onLevelUp(message.guild, message.member, r.levelUp, message.channel);
    } catch (err) {
      logger.error('message handling failed', { err });
    }
  });
  client.on(Events.GuildMemberAdd, (m) => onMemberJoin(m, { db, config, logger }).catch((err) => logger.error('welcome failed', { err })));
  client.on(Events.GuildMemberRemove, (m) => onMemberLeave(m, { db, logger }).catch((err) => logger.error('leave message failed', { err })));
  client.on(Events.VoiceStateUpdate, (oldS, newS) => {
    const session = listener.sessions.get(oldS.guild.id);
    if (!session) return;
    // Stop listening once nobody allowed to use ALPHA remains in that channel.
    if (oldS.channelId !== session.channelId || newS.channelId === session.channelId) return;
    const channel = oldS.guild.channels.cache.get(session.channelId);
    const stillAllowed = channel?.members?.some((m) => !m.user.bot && allowSpeaker(oldS.guild, m.id));
    if (!stillAllowed) listener.stop(oldS.guild.id, { musicActive: Boolean(music.peek(oldS.guild.id)?.queue.current) });
  });

  // Voice activity rewards (idempotent per user-minute; idle farming filtered).
  const voiceTick = setInterval(() => {
    const minuteBucket = Math.floor(Date.now() / 60000);
    for (const guild of client.guilds.cache.values()) {
      const s = getGuildSettings(db, guild.id);
      if (!s.progression.enabled) continue;
      for (const channel of guild.channels.cache.values()) {
        if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
        const humans = [...channel.members.values()].filter((m) => !m.user.bot).map((m) => m.voice);
        for (const state of humans) {
          if (!isVoiceEligible(state, humans, guild.afkChannelId)) continue;
          const r = rewardVoiceMinute(db, { guildId: guild.id, userId: state.id, minuteBucket, settings: s, tz: config.timezone });
          if (r.levelUp) onLevelUp(guild, state.member, r.levelUp, null).catch(() => null);
        }
      }
    }
  }, 60000);
  app.timers.push(voiceTick);

  app.onReady = async (c) => {
    logger.info('music audio engine', { engine: engineDescription(detectFfmpeg()) });
    for (const guild of c.guilds.cache.values()) {
      seedShop(db, guild.id);
      syncReportJobs(app, guild.id);
    }
  };
  app.onGuildJoin = (guild) => seedShop(db, guild.id);
  app.introMessage = () =>
    guardianEmbed('aegis', {
      title: 'AEGIS has arrived',
      description: [
        'I run music, the `' + config.voice.wakeWord + '` assistant, welcome cards, research, reports, events and the aura economy.',
        '',
        '**Next steps (admins):**',
        '1. `/setup channel` — pick welcome, alpha, music, reports and research channels.',
        '2. `/setup trusted` — besides the server owner, who may give `' + config.voice.wakeWord + '` commands.',
        '3. `/setup welcome` — welcome text and an optional image (PNG/JPG/WebP/GIF) shown below it.',
        '4. `/settings view` — review everything; `/voice diagnostics` — check voice.',
        '',
        'Music: `/play` searches licensed sources (Audius, Jamendo, Internet Archive).',
      ].join('\n'),
    });
  app.onShutdown = async () => {
    listener.stopAll();
    music.shutdown();
    killAllStreams();
    hub.destroyAll();
  };
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAegis()
    .start()
    .catch((err) => {
      console.error(`AEGIS failed to start: ${err.message}`);
      process.exit(1);
    });
}
