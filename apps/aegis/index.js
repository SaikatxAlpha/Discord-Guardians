// AEGIS — The Ancient Guardian. Intelligence, administration and automation.
import { GatewayIntentBits, Events, Partials, ChannelType, MessageFlags } from 'discord.js';
import { createAudioPlayer, createAudioResource, StreamType, AudioPlayerStatus, entersState } from '@discordjs/voice';
import prism from 'prism-media';
import { pathToFileURL } from 'node:url';
import { GuardianBot } from '../shared/botBase.js';
import { spokenSummary } from '../shared/render.js';
import { aegisHandlers, aegisJobs, takePick, enqueueTrack } from './handlers.js';
import { aegisCommands, onEventJoinButton } from './commands.js';
import { syncReportJobs } from './reports.js';
import { VoiceHub } from '../../features/voice/hub.js';
import { VoicePipeline } from '../../features/voice/pipeline.js';
import { AlphaListener } from '../../features/voice/listener.js';
import { synthesize, ttsAvailable } from '../../features/voice/tts.js';
import { MusicManager } from '../../features/music/manager.js';
import { createMusicAdapter } from '../../features/music/discordAdapter.js';
import { describeTrack } from '../../features/music/providers.js';
import { onMemberJoin, onMemberLeave } from '../../features/welcome/handler.js';
import { recordMessageActivity } from '../../features/intelligence/analytics.js';
import { rewardMessage, rewardVoiceMinute, isVoiceEligible, seedShop } from '../../features/progression/economy.js';
import { WAKE_WORD_RE } from '../../core/intents/parser.js';
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
  const music = new MusicManager({ db, logger, idleLeaveMs: config.music.idleLeaveMs, adapterFor: (guild) => createMusicAdapter({ guild, hub }) });

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
  let lastSttWarning = 0;
  const pipeline = new VoicePipeline({
    stt: app.stt,
    config,
    handleCommand: (req) => app.coordinator.handleText(req),
    onEvent: async (ev) => {
      const guild = client.guilds.cache.get(ev.guildId);
      const session = listener.sessions.get(ev.guildId);
      if (!guild || !session) return;
      if (ev.type === 'heard') {
        await sendToChannel(guild, session.textChannelId, { content: `🎙️ <@${ev.userId}>: “${safeText(ev.command, 300)}”` }, logger);
      } else if (ev.type === 'result') {
        await app.postResponse(guild, session.textChannelId, ev.result);
        await speak(guild, spokenSummary(ev.result));
      } else if (ev.type === 'stt_error' && Date.now() - lastSttWarning > 60000) {
        lastSttWarning = Date.now();
        await sendToChannel(guild, session.textChannelId, { embeds: [guardianEmbed('aegis', { title: 'Speech-to-text unavailable', color: STATUS_COLORS.warn, description: `${safeText(ev.error, 300)}\nUse \`/alpha\` or type "ALPHA, ..." meanwhile.` })] }, logger);
      }
    },
  });
  const listener = new AlphaListener({
    hub,
    pipeline,
    config,
    logger,
    onChange: (guildId, on) => {
      client.user?.setPresence({ activities: [{ name: 'status', type: 4, state: on ? '🎙️ Listening for ALPHA' : app.theme.presence }], status: on ? 'dnd' : 'online' });
      if (!on) {
        const guild = client.guilds.cache.get(guildId);
        const s = guild && getGuildSettings(db, guildId);
        if (guild && s.channels.alpha) sendToChannel(guild, s.channels.alpha, { content: '🔇 ALPHA stopped listening. Audio capture is off.' }, logger);
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
    await i.deferUpdate();
    const guild = await app.getGuild(p.guildId);
    const r = await enqueueTrack({ music, guild }, track, p.voiceChannelId, p.textChannelId).catch((err) => ({ ok: false, message: err.message }));
    await i.editReply({ content: r.message, components: [], embeds: [] });
  });

  // ---------------------------------------------------------------- music notifications
  const announced = new WeakSet();
  const wireMusic = (gm) => {
    if (announced.has(gm)) return;
    announced.add(gm);
    const post = (content) => client.guilds.fetch(gm.guildId).then((g) => sendToChannel(g, gm.textChannelId, { content }, logger)).catch(() => null);
    gm.on('trackError', (track, err) => post(`⚠️ Could not play **${safeText(track?.title ?? 'track', 100)}** (${safeText(err.message, 150)}). Skipping.`));
    gm.on('halted', () => post('⛔ Several tracks failed in a row; playback stopped.'));
    gm.on('disconnected', () => post('🔌 Lost the voice connection. The queue was saved — use /play to continue.'));
    gm.on('trackStart', (t) => post(`🎶 Now playing **${safeText(describeTrack(t), 150)}**`));
  };
  const origGet = music.get.bind(music);
  music.get = (guild) => {
    const gm = origGet(guild);
    wireMusic(gm);
    return gm;
  };

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
      // Typed ALPHA commands (owner only; ignored silently for others).
      if (s.alpha.textPrefixEnabled && WAKE_WORD_RE.test(message.content) && canUseAlpha(message.author.id, config) && (!s.channels.alpha || s.channels.alpha === message.channelId)) {
        await message.channel.sendTyping().catch(() => null);
        const res = await app.coordinator.handleText({ requestId: `msg:${message.id}`, guildId: message.guild.id, channelId: message.channelId, userId: message.author.id, source: 'text', text: message.content });
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
    // Stop listening when the owner leaves the channel ALPHA is in.
    if (oldS.id === config.ownerId && oldS.channelId === session.channelId && newS.channelId !== session.channelId) {
      listener.stop(oldS.guild.id, { musicActive: Boolean(music.peek(oldS.guild.id)?.queue.current) });
    }
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
    for (const guild of c.guilds.cache.values()) {
      seedShop(db, guild.id);
      syncReportJobs(app, guild.id);
    }
  };
  app.onShutdown = async () => {
    listener.stopAll();
    music.shutdown();
    hub.destroyAll();
  };
  return app;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  createAegis()
    .start()
    .catch((err) => {
      console.error(`AEGIS failed to start: ${err.message}`);
      process.exit(1);
    });
}
