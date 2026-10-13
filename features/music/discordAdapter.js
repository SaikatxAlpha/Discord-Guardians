// Real @discordjs/voice adapter for GuildMusic. Audio is streamed by ffmpeg
// straight from the provider into the voice connection — never written to
// disk. A global cap bounds concurrent ffmpeg processes across all servers.
import prism from 'prism-media';
import { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { streamInput, MusicError } from './providers.js';

const active = new Set(); // live ffmpeg wrappers (all guilds)

export function activeStreams() {
  return active.size;
}

export function ffmpegStream(input, { remote }) {
  const args = [
    ...(remote ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000', '-user_agent', 'SoulSocietyGuardians/1.0'] : []),
    '-i', input,
    '-analyzeduration', '0',
    '-loglevel', '0',
    '-vn',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
  ];
  return new prism.FFmpeg({ args });
}

/** Kill every ffmpeg process (shutdown safety net). */
export function killAllStreams() {
  for (const ff of active) ff.destroy();
  active.clear();
}

export function createMusicAdapter({ guild, hub, maxStreams = 8, onMusicActive = () => {} }) {
  return {
    connect: (channelId) => hub.connect(guild, channelId),
    createPlayer: () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
    async createResource(track) {
      if (active.size >= maxStreams) throw new MusicError('busy', 'Too many servers are streaming music right now; try again shortly.');
      const input = await streamInput(track);
      const ff = ffmpegStream(input, { remote: /^https?:\/\//.test(input) });
      active.add(ff);
      const release = () => active.delete(ff);
      ff.once('close', release);
      ff.once('error', release);
      return createAudioResource(ff, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
    },
    waitReconnect: (conn) => hub.waitReconnect(conn),
    subscribe: (conn, player) => {
      conn.subscribe(player);
      onMusicActive(true);
    },
    disconnect: () => {
      onMusicActive(false);
      hub.release(guild.id);
    },
  };
}
