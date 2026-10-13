// AEGIS ALPHA listener: joins the owner's voice channel and listens ONLY to
// the owner/trusted users for the wake word.
import { UtteranceCapture } from './receiver.js';
import { canUseAlpha } from '../../core/auth.js';

export class AlphaListener {
  constructor({ hub, pipeline, config, logger, onChange = () => {} }) {
    Object.assign(this, { hub, pipeline, config, logger, onChange });
    this.sessions = new Map(); // guildId -> { capture, channelId, startedAt }
  }

  isListening(guildId) {
    return this.sessions.has(guildId);
  }

  async start(guild, voiceChannelId, { textChannelId }) {
    if (!this.pipeline.stt.available()) throw new Error('No speech-to-text provider is available, so voice commands cannot be transcribed. Use /alpha or type "ALPHA, ..." instead.');
    // Replace an existing session's capture without releasing the shared
    // connection (music may be using it).
    const prev = this.sessions.get(guild.id);
    if (prev) {
      prev.capture.stop();
      this.sessions.delete(guild.id);
    }
    this.hub.listening.add(guild.id);
    let connection;
    try {
      connection = await this.hub.connect(guild, voiceChannelId);
    } catch (err) {
      this.hub.listening.delete(guild.id);
      throw err;
    }
    const capture = new UtteranceCapture({
      connection,
      logger: this.logger,
      allow: (userId) => canUseAlpha(userId, this.config),
      onUtterance: (u) =>
        this.pipeline
          .handleUtterance({ ...u, guildId: guild.id, channelId: textChannelId })
          .catch((err) => this.logger.error('voice pipeline error', { err })),
    });
    this.sessions.set(guild.id, { capture, channelId: voiceChannelId, textChannelId, startedAt: Date.now() });
    this.onChange(guild.id, true);
    return { channelId: voiceChannelId };
  }

  stop(guildId, { silent = false, musicActive = false } = {}) {
    const s = this.sessions.get(guildId);
    if (!s) return false;
    s.capture.stop();
    this.sessions.delete(guildId);
    this.hub.listening.delete(guildId);
    this.hub.release(guildId, { musicActive });
    if (!silent) this.onChange(guildId, false);
    return true;
  }

  stopAll() {
    for (const guildId of [...this.sessions.keys()]) this.stop(guildId, { silent: true });
  }
}
