// Real @discordjs/voice adapter for GuildMusic. Audio is streamed from the
// provider into the voice connection — never written to disk. The audio
// engine is FFmpeg when available, otherwise the built-in MP3/Opus decoder
// (see audioEngine.js). A global cap bounds concurrent streams across servers.
import { PermissionFlagsBits } from 'discord.js';
import { createAudioPlayer, createAudioResource, NoSubscriberBehavior } from '@discordjs/voice';
import { streamInput, MusicError } from './providers.js';
import { createPlayableStream } from './audioEngine.js';

const active = new Set(); // live audio streams (all guilds)

export function activeStreams() {
  return active.size;
}

/** Destroy every audio stream (shutdown safety net). */
export function killAllStreams() {
  for (const s of active) s.destroy();
  active.clear();
}

/** Can AEGIS join and speak in this voice channel? Returns a user-facing reason if not. */
export function voicePermissionProblem(channel, me) {
  if (!channel) return 'That voice channel no longer exists.';
  const perms = channel.permissionsFor?.(me);
  if (!perms?.has(PermissionFlagsBits.ViewChannel) || !perms.has(PermissionFlagsBits.Connect)) return `I don't have permission to **connect** to <#${channel.id}>.`;
  if (!perms.has(PermissionFlagsBits.Speak)) return `I can join <#${channel.id}> but I don't have permission to **speak** there.`;
  if (channel.full && !perms.has(PermissionFlagsBits.MoveMembers) && !channel.members?.has?.(me.id)) return `<#${channel.id}> is full.`;
  return null;
}

export function createMusicAdapter({ guild, hub, maxStreams = 8, logger, onMusicActive = () => {} }) {
  return {
    connect: (channelId) => hub.connect(guild, channelId),
    createPlayer: () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause, maxMissedFrames: 250 } }),
    async createResource(track) {
      if (active.size >= maxStreams) throw new MusicError('busy', 'Too many servers are streaming music right now; try again shortly.');
      const input = await streamInput(track);
      const { stream, inputType, engine, format } = await createPlayableStream(input);
      active.add(stream);
      const release = () => active.delete(stream);
      stream.once('close', release);
      stream.once('error', (err) => {
        release();
        logger?.warn('audio stream error', { guildId: guild.id, provider: track.provider, engine, err: err.message });
      });
      logger?.info('audio stream opened', { guildId: guild.id, provider: track.provider, engine, format });
      return createAudioResource(stream, { inputType, inlineVolume: true, metadata: { ...track, engine } });
    },
    waitReconnect: (conn) => hub.waitReconnect(conn),
    subscribe: (conn, player) => {
      conn.subscribe(player);
      onMusicActive(true);
    },
    disconnect: (_conn, { force = false } = {}) => {
      onMusicActive(false);
      if (force) hub.leave(guild.id);
      else hub.release(guild.id);
    },
  };
}
