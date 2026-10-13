// KNIGHT voice profanity moderation (opt-in, off by default).
// Safeguards: confidence threshold, per-user debounce, a human review queue
// for uncertain transcripts, and a hard cap on automatic punishment (never
// kick/ban from speech recognition).
import { joinVoiceChannel, entersState, VoiceConnectionStatus } from '@discordjs/voice';
import { checkProfanity, buildMatcher } from '../moderation/filter.js';
import { activePoints, decideEscalation, capAction } from '../moderation/escalation.js';
import { getGuildSettings } from '../../core/settings.js';
import { UtteranceCapture } from './receiver.js';

/** Pure decision logic (testable without Discord). */
export class VoiceModerationPipeline {
  constructor({ db, stt, logger, enforce, now = () => Date.now() }) {
    Object.assign(this, { db, stt, logger, enforce, now });
    this.lastAction = new Map();
  }

  /**
   * @param {{guildId:string, channelId:string, userId:string, text:string, confidence:number, member?:object, guild?:object}} t
   * @returns {Promise<{decision:'clean'|'review'|'debounced'|'enforced', detail?:any}>}
   */
  async handleTranscript(t) {
    const settings = getGuildSettings(this.db, t.guildId);
    const vm = settings.moderation.voice;
    const p = checkProfanity(t.text, buildMatcher(settings.moderation.profanity));
    if (!p.matched) return { decision: 'clean' };
    if (t.confidence < vm.minConfidence) {
      this.db.run(
        `INSERT INTO voice_reviews (guild_id, user_id, channel_id, transcript, confidence, matched, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        t.guildId, t.userId, t.channelId, t.text.slice(0, 500), t.confidence, p.terms.join(','), this.now(),
      );
      return { decision: 'review', detail: { confidence: t.confidence, terms: p.terms } };
    }
    const key = `${t.guildId}:${t.userId}`;
    if (this.now() - (this.lastAction.get(key) ?? 0) < vm.debounceMs) return { decision: 'debounced' };
    this.lastAction.set(key, this.now());
    const add = settings.moderation.escalation.points.voice;
    const before = activePoints(this.db, t.guildId, t.userId, settings.moderation.escalation.decayHours, this.now());
    const decision = capAction(decideEscalation({ before, add, escalation: settings.moderation.escalation }), vm.maxAutoAction === 'timeout' ? 'timeout' : 'warn');
    const result = await this.enforce({
      settings,
      guild: t.guild,
      action: decision.action,
      target: t.member,
      durationMs: decision.durationMs,
      reason: `Voice profanity (${p.terms.join(', ')}; confidence ${(t.confidence * 100).toFixed(0)}%)`,
      rule: 'voice_profanity',
      points: add,
      evidence: `voice transcript: ${t.text.slice(0, 200)}`,
      automatic: true,
    });
    return { decision: 'enforced', detail: { action: decision.action, result } };
  }
}

/** Discord wiring for KNIGHT. */
export class VoiceModerator {
  constructor({ db, stt, logger, enforce, config }) {
    Object.assign(this, { db, stt, logger, config });
    this.pipeline = new VoiceModerationPipeline({ db, stt, logger, enforce });
    this.sessions = new Map();
  }

  async start(guild, channelId) {
    const settings = getGuildSettings(this.db, guild.id);
    if (!settings.moderation.voice.enabled) throw new Error('Voice moderation is disabled. Enable it with /modconfig voice enabled:true (members should be told voice is monitored).');
    if (!this.stt.available()) throw new Error('No speech-to-text provider is configured, so voice cannot be moderated.');
    this.stop(guild.id);
    const conn = joinVoiceChannel({ channelId, guildId: guild.id, adapterCreator: guild.voiceAdapterCreator, selfDeaf: false, selfMute: true, group: 'knight' });
    await entersState(conn, VoiceConnectionStatus.Ready, 20000).catch((err) => {
      conn.destroy();
      throw new Error(`Could not join voice: ${err.message}`);
    });
    const capture = new UtteranceCapture({
      connection: conn,
      logger: this.logger,
      allow: (userId) => {
        const m = guild.members.cache.get(userId);
        const s = getGuildSettings(this.db, guild.id).moderation;
        return Boolean(m && !m.user.bot && userId !== this.config.ownerId && !s.exemptRoleIds.some((r) => m.roles.cache.has(r)));
      },
      onUtterance: async (u) => {
        if (u.durationMs < 500 || u.rms < 0.01) return;
        try {
          const tr = await this.stt.transcribe(u.wav, { durationMs: u.durationMs });
          const member = guild.members.cache.get(u.userId) ?? (await guild.members.fetch(u.userId).catch(() => null));
          if (!member) return;
          await this.pipeline.handleTranscript({ guildId: guild.id, channelId, userId: u.userId, text: tr.text, confidence: tr.confidence, member, guild });
        } catch (err) {
          this.logger.warn('voice moderation transcription failed', { err: err.message });
        }
      },
    });
    this.sessions.set(guild.id, { conn, capture, channelId });
  }

  stop(guildId) {
    const s = this.sessions.get(guildId);
    if (!s) return false;
    s.capture.stop();
    s.conn.destroy();
    this.sessions.delete(guildId);
    return true;
  }

  stopAll() {
    for (const id of [...this.sessions.keys()]) this.stop(id);
  }
}
