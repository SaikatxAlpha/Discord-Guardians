// AEGIS voice connection hub: one connection per guild shared by music
// playback and ALPHA listening. Listening requires the bot not be deafened.
import {
  joinVoiceChannel,
  getVoiceConnection,
  entersState,
  VoiceConnectionStatus,
} from '@discordjs/voice';

export class VoiceHub {
  constructor({ bot, logger }) {
    this.group = bot; // keeps KNIGHT and AEGIS connections independent
    this.logger = logger;
    this.listening = new Set(); // guild ids with an active ALPHA listener
  }

  get(guildId) {
    return getVoiceConnection(guildId, this.group) ?? null;
  }

  async connect(guild, channelId) {
    const selfDeaf = !this.listening.has(guild.id);
    let conn = this.get(guild.id);
    if (conn && conn.joinConfig.channelId === channelId && conn.joinConfig.selfDeaf === selfDeaf && conn.state.status !== VoiceConnectionStatus.Destroyed) return conn;
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
      conn.rejoin({ channelId, selfDeaf, selfMute: false });
    } else {
      conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf, selfMute: false, group: this.group });
    }
    try {
      await entersState(conn, VoiceConnectionStatus.Ready, 20000);
    } catch (err) {
      conn.destroy();
      throw new Error(`Could not connect to the voice channel: ${err.message}`);
    }
    return conn;
  }

  async waitReconnect(conn) {
    try {
      await Promise.race([entersState(conn, VoiceConnectionStatus.Signalling, 5000), entersState(conn, VoiceConnectionStatus.Connecting, 5000)]);
      await entersState(conn, VoiceConnectionStatus.Ready, 15000);
      return true;
    } catch {
      return false;
    }
  }

  /** Leave only when neither music nor listening needs the connection. */
  release(guildId, { musicActive = false } = {}) {
    if (this.listening.has(guildId) || musicActive) return false;
    const conn = this.get(guildId);
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) conn.destroy();
    return true;
  }

  /** Disconnect now, even if the ALPHA listener is using the connection. */
  leave(guildId) {
    this.listening.delete(guildId);
    const conn = this.get(guildId);
    if (conn && conn.state.status !== VoiceConnectionStatus.Destroyed) {
      conn.destroy();
      return true;
    }
    return false;
  }

  destroyAll() {
    for (const guildId of this.listening) this.get(guildId)?.destroy();
    this.listening.clear();
  }
}
