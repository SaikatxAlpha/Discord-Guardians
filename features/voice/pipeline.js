// Discord-independent ALPHA voice pipeline:
//   utterance (WAV, from a Discord-identified speaker)
//   -> speech-to-text -> wake-word detection -> owner verification
//   -> ALPHA coordinator -> result callback
// The wake word only activates command recognition. Authorisation is based
// solely on the Discord user ID that the voice packets belong to.
import { WAKE_WORD_RE } from '../../core/intents/parser.js';
import { canUseAlpha } from '../../core/auth.js';

const ARM_WINDOW_MS = 8000;

/** Find "ALPHA" in the first few words of a transcript. */
export function detectWakeWord(transcript) {
  const t = String(transcript ?? '').trim();
  if (!t) return { activated: false, command: '' };
  const m = WAKE_WORD_RE.exec(t);
  if (m) return { activated: true, command: t.slice(m[0].length).trim() };
  // Allow a short lead-in ("um, alpha ...", "okay so alpha ...").
  const words = t.split(/\s+/);
  for (let i = 1; i < Math.min(4, words.length); i++) {
    const rest = words.slice(i).join(' ');
    const mm = WAKE_WORD_RE.exec(rest);
    if (mm && /^(?:um+|uh+|ok(?:ay)?|so|hey|hi|yo|and)[,.]?$/i.test(words.slice(0, i).join(' ').replace(/[,.]/g, '').split(' ').pop())) {
      return { activated: true, command: rest.slice(mm[0].length).trim() };
    }
  }
  return { activated: false, command: '' };
}

export class VoicePipeline {
  /**
   * @param {object} o
   * @param {{transcribe:Function, available:Function}} o.stt
   * @param {(req:object)=>Promise<object>} o.handleCommand coordinator.handleText
   * @param {object} o.config
   * @param {(event:object)=>void} [o.onEvent] status/result reporting
   */
  constructor({ stt, handleCommand, config, onEvent = () => {}, minDurationMs = 400, maxDurationMs = 15000, minRms = 0.008 }) {
    Object.assign(this, { stt, handleCommand, config, onEvent, minDurationMs, maxDurationMs, minRms });
    this.armedUntil = new Map(); // userId -> ts after a bare "ALPHA"
    this.busy = new Set();
    this.counter = 0;
  }

  /**
   * @param {{guildId:string, channelId:string, userId:string, wav:Buffer, durationMs:number, rms?:number}} u
   */
  async handleUtterance(u) {
    // Identity first: only the owner/trusted users' audio is ever processed.
    if (!canUseAlpha(u.userId, this.config)) return { status: 'ignored', reason: 'not_authorised_speaker' };
    if (u.durationMs < this.minDurationMs) return { status: 'ignored', reason: 'too_short' };
    if (u.durationMs > this.maxDurationMs) return { status: 'ignored', reason: 'too_long' };
    if (u.rms != null && u.rms < this.minRms) return { status: 'ignored', reason: 'silence' };
    if (this.busy.has(u.userId)) return { status: 'ignored', reason: 'busy' };
    this.busy.add(u.userId);
    try {
      let tr;
      try {
        tr = await this.stt.transcribe(u.wav, { durationMs: u.durationMs });
      } catch (err) {
        this.onEvent({ type: 'stt_error', error: err.message, ...u });
        return { status: 'error', reason: 'stt_failed', error: err.message };
      }
      const now = Date.now();
      const wake = detectWakeWord(tr.text);
      let command = wake.command;
      if (!wake.activated) {
        if ((this.armedUntil.get(u.userId) ?? 0) > now) {
          command = tr.text.trim();
          this.armedUntil.delete(u.userId);
        } else return { status: 'ignored', reason: 'no_wake_word', transcript: tr.text };
      }
      if (!command) {
        this.armedUntil.set(u.userId, now + ARM_WINDOW_MS);
        this.onEvent({ type: 'armed', userId: u.userId, guildId: u.guildId });
        return { status: 'armed' };
      }
      this.onEvent({ type: 'heard', transcript: tr.text, command, confidence: tr.confidence, ...u, wav: undefined });
      const result = await this.handleCommand({
        requestId: `voice:${u.guildId}:${u.userId}:${now}:${++this.counter}`,
        guildId: u.guildId,
        channelId: u.channelId,
        userId: u.userId,
        source: 'voice',
        text: command,
      });
      this.onEvent({ type: 'result', command, result, guildId: u.guildId, userId: u.userId });
      return { status: 'handled', command, result, confidence: tr.confidence };
    } finally {
      this.busy.delete(u.userId);
    }
  }
}
