// Discord-independent ALPHA voice pipeline:
//   utterance (WAV, from a Discord-identified speaker)
//   -> speaker authorisation (this server's policy) -> speech check
//   -> speech-to-text -> transcript quality gate -> wake word
//   -> ALPHA coordinator (with forced confirmation when uncertain)
// The wake word only activates command recognition. Authorisation is based
// solely on the Discord user ID that the voice packets belong to.
import { canUseAlpha } from '../../core/auth.js';
import { parseCommand } from '../../core/intents/parser.js';
import { buildWakeMatcher, normaliseTranscript } from './wakeword.js';
import { buildSttPrompt } from './stt.js';

const ARM_WINDOW_MS = 8000;
const MAX_PENDING_PER_USER = 3;
const DIAG_KEEP = 20;

/** Default matcher for the default wake word (kept for existing callers). */
export function detectWakeWord(transcript, wakeWord = 'ALPHA') {
  return buildWakeMatcher(wakeWord).detect(transcript);
}

export class VoicePipeline {
  /**
   * @param {object} o
   * @param {{transcribe:Function, available:Function}} o.stt
   * @param {(req:object)=>Promise<object>} o.handleCommand coordinator.handleText
   * @param {object} o.config
   * @param {(u:object)=>boolean} [o.authorize] speaker policy for the utterance's server
   * @param {(guildId:string)=>{language?:string|null, vocabulary?:string[], guildLimit?:number}} [o.guildOptions]
   * @param {(event:object)=>void} [o.onEvent] status/result reporting
   */
  constructor({ stt, handleCommand, config, authorize, guildOptions = () => ({}), onEvent = () => {}, minDurationMs = 350, minSpeechMs = 250, now = () => Date.now() }) {
    const voice = config.voice ?? { wakeWord: 'ALPHA', repeatBelow: 0.45, confirmBelow: 0.7, maxUtteranceMs: 15000 };
    Object.assign(this, { stt, handleCommand, config, guildOptions, onEvent, minDurationMs, minSpeechMs, now, voice });
    this.authorize = authorize ?? ((u) => canUseAlpha(u.userId, config));
    this.wake = buildWakeMatcher(voice.wakeWord);
    this.armed = new Map(); // userId -> { until, prefix }
    this.queues = new Map(); // userId -> { tail: Promise, depth }
    this.counter = 0;
    this.diagnostics = new Map(); // guildId -> recent runs (metrics only, no audio, no transcripts)
  }

  record(guildId, entry) {
    const list = this.diagnostics.get(guildId) ?? [];
    list.push({ at: this.now(), ...entry });
    while (list.length > DIAG_KEEP) list.shift();
    this.diagnostics.set(guildId, list);
  }

  /** Process utterances of one speaker in order (never drop the second half of a split command). */
  handleUtterance(u) {
    const q = this.queues.get(u.userId) ?? { tail: Promise.resolve(), depth: 0 };
    if (q.depth >= MAX_PENDING_PER_USER) return Promise.resolve({ status: 'ignored', reason: 'backlog' });
    q.depth++;
    this.queues.set(u.userId, q);
    const run = q.tail.then(() => this.process(u)).finally(() => {
      q.depth--;
      if (q.depth === 0) this.queues.delete(u.userId);
    });
    q.tail = run.catch(() => undefined);
    return run;
  }

  /**
   * @param {{guildId:string, channelId:string, userId:string, wav:Buffer, durationMs:number, speechMs?:number, rms?:number, metrics?:object}} u
   */
  async process(u) {
    const t0 = this.now();
    const done = (result, extra = {}) => {
      this.record(u.guildId, { status: result.status, reason: result.reason ?? null, durationMs: u.durationMs, speechMs: u.speechMs ?? null, totalMs: this.now() - t0, ...u.metrics, ...extra });
      return result;
    };
    // Identity first: only authorised speakers' audio is ever transcribed.
    if (!this.authorize(u)) return done({ status: 'ignored', reason: 'not_authorised_speaker' });
    if (u.durationMs < this.minDurationMs) return done({ status: 'ignored', reason: 'too_short' });
    if (u.durationMs > this.voice.maxUtteranceMs + 1000) return done({ status: 'ignored', reason: 'too_long' });
    if (u.speechMs != null && u.speechMs < this.minSpeechMs) return done({ status: 'ignored', reason: 'no_speech' });

    const opts = this.guildOptions(u.guildId) ?? {};
    let tr;
    const sttStart = this.now();
    try {
      tr = await this.stt.transcribe(u.wav, {
        durationMs: u.durationMs,
        guildId: u.guildId,
        language: opts.language ?? undefined,
        prompt: buildSttPrompt({ wakeWord: this.voice.wakeWord, vocabulary: opts.vocabulary ?? [] }),
        guildLimit: opts.guildLimit,
      });
    } catch (err) {
      this.onEvent({ type: 'stt_error', code: err.code ?? 'failed', error: err.message, guildId: u.guildId, userId: u.userId });
      return done({ status: 'error', reason: err.code ?? 'stt_failed', error: err.message });
    }
    const sttMs = this.now() - sttStart;
    const text = normaliseTranscript(tr.text);
    const quality = { sttMs, confidence: Number((tr.confidence ?? 0).toFixed(2)), noSpeech: Number((tr.noSpeech ?? 0).toFixed(2)), attempts: tr.attempts ?? 1 };
    if (!text || tr.hallucination || (tr.noSpeech ?? 0) > 0.6) return done({ status: 'ignored', reason: 'no_speech' }, quality);

    const now = this.now();
    const wake = this.wake.detect(text);
    const armed = this.armed.get(u.userId);
    let command;
    if (wake.activated) {
      command = wake.command;
      this.armed.delete(u.userId);
    } else if (armed && armed.until > now) {
      // Continuation after a bare "ALPHA" or an incomplete command ("ALPHA, play" … "Her by JVKE").
      command = normaliseTranscript(`${armed.prefix} ${text}`);
      this.armed.delete(u.userId);
    } else return done({ status: 'ignored', reason: 'no_wake_word' }, quality);

    if (!command) {
      this.armed.set(u.userId, { until: now + ARM_WINDOW_MS, prefix: '' });
      this.onEvent({ type: 'armed', userId: u.userId, guildId: u.guildId });
      return done({ status: 'armed' }, quality);
    }
    // Too uncertain to act on at all: ask to repeat instead of guessing.
    if (tr.confidence < this.voice.repeatBelow) {
      this.onEvent({ type: 'repeat', userId: u.userId, guildId: u.guildId, confidence: tr.confidence });
      return done({ status: 'repeat', reason: 'low_confidence' }, quality);
    }
    const parsed = parseCommand(command, { now });
    if (!parsed.steps.length && command.split(/\s+/).length <= 2) {
      // Probably cut off mid-command: wait briefly for the rest.
      this.armed.set(u.userId, { until: now + ARM_WINDOW_MS, prefix: command });
      this.onEvent({ type: 'armed', userId: u.userId, guildId: u.guildId, partial: true });
      return done({ status: 'armed', reason: 'incomplete' }, quality);
    }
    const forceConfirm = tr.confidence < this.voice.confirmBelow;
    this.onEvent({ type: 'heard', command, confidence: tr.confidence, forceConfirm, guildId: u.guildId, channelId: u.channelId, userId: u.userId });
    const result = await this.handleCommand({
      requestId: `voice:${u.guildId}:${u.userId}:${now}:${++this.counter}`,
      guildId: u.guildId,
      channelId: u.channelId,
      userId: u.userId,
      source: 'voice',
      text: command,
      heard: command,
      confidence: tr.confidence,
      forceConfirm,
    });
    this.onEvent({ type: 'result', command, result, guildId: u.guildId, userId: u.userId });
    return done({ status: 'handled', command, result, confidence: tr.confidence, forceConfirm }, { ...quality, outcome: result?.status ?? null });
  }

  /** Metrics for /voice diagnostics (no audio, no transcript text). */
  diagnosticsFor(guildId) {
    return [...(this.diagnostics.get(guildId) ?? [])];
  }
}
