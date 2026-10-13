// Real @discordjs/voice adapter for GuildMusic (ffmpeg via ffmpeg-static).
import prism from 'prism-media';
import { createAudioPlayer, createAudioResource, NoSubscriberBehavior, StreamType } from '@discordjs/voice';
import { resolveArchiveStream } from './providers.js';

export function ffmpegStream(input, { remote }) {
  const args = [
    ...(remote ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5'] : []),
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

export function createMusicAdapter({ guild, hub, onMusicActive = () => {} }) {
  return {
    connect: (channelId) => hub.connect(guild, channelId),
    createPlayer: () => createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }),
    async createResource(track) {
      const input = track.source === 'archive' ? await resolveArchiveStream(track) : track.input;
      if (!input) throw new Error('Track has no playable input.');
      const stream = ffmpegStream(input, { remote: /^https:\/\//.test(input) });
      return createAudioResource(stream, { inputType: StreamType.Raw, inlineVolume: true, metadata: track });
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
