// Speech-to-text providers behind one interface:
//   transcribe(wav, {durationMs, guildId, language, prompt, guildLimit})
//     -> {text, confidence (0..1), noSpeech (0..1), hallucination, provider, model, latencyMs, attempts}
// Replacing the provider only requires another class with this shape.
import { groqTranscribe, isRetryable } from '../../ai/groq.js';
import { reserveUsage, reserveGuildUsage, CircuitBreaker, usageToday } from '../../ai/usage.js';

export class SttError extends Error {
  /** @param {'limit_global'|'limit_guild'|'rate_limited'|'unavailable'|'failed'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Phrases Whisper is known to produce on silence/noise. Only discarded when
// they are the whole transcript.
const HALLUCINATIONS = [
  /^(thank you|thanks)( (so much|very much))?( for watching)?[.!]*$/i,
  /^(you|bye|bye-bye|okay|ok|hmm+|uh+|um+)[.!?]*$/i,
  /^[.\s…!?-]*$/,
  /(subtitles|captions) by/i,
  /please subscribe|like and subscribe/i,
];

/**
 * Whisper reports avg_logprob, no_speech_prob and compression_ratio per
 * segment; combine them into a conservative 0..1 confidence.
 */
export function assessTranscript({ text, segments }) {
  const t = String(text ?? '').trim();
  if (!Array.isArray(segments) || !segments.length) {
    return { text: t, confidence: t ? 0.5 : 0, noSpeech: t ? 0 : 1, hallucination: HALLUCINATIONS.some((re) => re.test(t)) };
  }
  let total = 0;
  let conf = 0;
  let noSpeech = 0;
  let worstCompression = 0;
  for (const s of segments) {
    const dur = Math.max(0.1, (s.end ?? 0) - (s.start ?? 0));
    const ns = Math.min(1, Math.max(0, s.no_speech_prob ?? 0));
    conf += Math.exp(Math.min(0, s.avg_logprob ?? -1)) * (1 - ns) * dur;
    noSpeech += ns * dur;
    total += dur;
    worstCompression = Math.max(worstCompression, s.compression_ratio ?? 0);
  }
  let confidence = conf / total;
  // A very high compression ratio means repetitive (likely garbage) output.
  if (worstCompression > 2.4) confidence *= 0.5;
  return {
    text: t,
    confidence: Math.max(0, Math.min(1, confidence)),
    noSpeech: noSpeech / total,
    hallucination: HALLUCINATIONS.some((re) => re.test(t)),
  };
}

/** Backwards-compatible helper used by older callers/tests. */
export function confidenceFromSegments(segments) {
  return assessTranscript({ text: 'x', segments }).confidence;
}

/**
 * Short domain prompt (Groq: ≤224 tokens). Example commands teach Whisper
 * the wake word's spelling and the command vocabulary; optional per-server
 * vocabulary helps with names. Kept well under the limit.
 */
export function buildSttPrompt({ wakeWord = 'ALPHA', vocabulary = [], extra = '' } = {}) {
  const w = wakeWord;
  let p = `${w}, play Blinding Lights. ${w}, skip. ${w}, pause. ${w}, resume. ${w}, show the queue. ${w}, volume 50. ${w}, stop listening. ${w}, timeout Bob for five minutes. ${w}, create a gaming channel.`;
  const words = [...new Set(vocabulary.map((v) => String(v).trim()).filter((v) => v && v.length <= 40))].slice(0, 30);
  if (words.length) p += ` Names: ${words.join(', ')}.`;
  if (extra) p += ` ${extra}`;
  return p.slice(0, 700); // ≈ 175 tokens
}

export class NoSTT {
  name = 'none';
  available() {
    return false;
  }
  status() {
    return { provider: 'none', enabled: false, note: 'No speech-to-text provider configured (set GROQ_API_KEY).' };
  }
  async transcribe() {
    throw new SttError('unavailable', 'Speech-to-text is not configured.');
  }
}

/** Groq Whisper (free plan, no payment method; rate limited). */
export class GroqSTT {
  constructor({ config, db, logger, fetchImpl, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
    this.name = 'groq';
    this.cfg = config.stt;
    this.db = db;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 2 * 60000 });
  }
  available() {
    return Boolean(this.cfg.apiKey) && !this.breaker.open;
  }
  status() {
    const u = usageToday(this.db, 'groq', 'stt');
    return { provider: 'groq', model: this.cfg.model, language: this.cfg.language || 'auto', enabled: Boolean(this.cfg.apiKey), circuitOpen: this.breaker.open, usedToday: u.requests, audioSecondsToday: u.units, dailyLimit: this.cfg.dailyLimit };
  }

  async transcribe(wav, { durationMs = 0, guildId = null, language, prompt, guildLimit = this.cfg.guildDailyLimit } = {}) {
    if (!this.cfg.apiKey) throw new SttError('unavailable', 'Speech-to-text is not configured.');
    if (this.breaker.open) throw new SttError('rate_limited', 'Speech-to-text is cooling down after errors or rate limiting.');
    if (!reserveGuildUsage(this.db, guildId, 'stt', guildLimit)) throw new SttError('limit_guild', "This server's daily voice-command limit was reached.");
    if (!reserveUsage(this.db, 'groq', 'stt', this.cfg.dailyLimit, Math.ceil(durationMs / 1000))) throw new SttError('limit_global', 'Daily speech-to-text limit reached.');
    const started = Date.now();
    const maxAttempts = 1 + Math.max(0, this.cfg.maxRetries ?? 1);
    for (let attempt = 1; ; attempt++) {
      try {
        const out = await groqTranscribe({
          apiKey: this.cfg.apiKey,
          model: this.cfg.model,
          wav,
          language: language === undefined ? this.cfg.language : language,
          prompt: prompt ?? this.cfg.prompt,
          timeoutMs: this.cfg.timeoutMs,
          fetchImpl: this.fetchImpl,
        });
        this.breaker.success();
        return { ...assessTranscript(out), provider: 'groq', model: this.cfg.model, latencyMs: Date.now() - started, attempts: attempt };
      } catch (err) {
        if (err.status === 429) {
          this.breaker.failure(err.retryAfterMs || 60000);
          throw new SttError('rate_limited', 'Speech-to-text is rate limited right now.');
        }
        if (attempt < maxAttempts && isRetryable(err)) {
          await this.sleep(400 * 2 ** (attempt - 1));
          continue;
        }
        this.breaker.failure();
        // Log status/type only: never the audio, the key or the transcript.
        this.logger?.warn('speech-to-text request failed', { status: err.status ?? null, type: err.name, attempts: attempt });
        throw new SttError('failed', err.status ? `Speech-to-text failed (HTTP ${err.status}).` : 'Speech-to-text request failed (network/timeout).');
      }
    }
  }
}

/**
 * MOCK provider for tests and safe simulation. It does not listen to audio:
 * it returns scripted transcripts in order. Never use it as proof that real
 * speech recognition works.
 */
export class MockSTT {
  constructor(script = []) {
    this.name = 'mock';
    this.script = [...script];
    this.calls = 0;
    this.lastOptions = null;
  }
  available() {
    return true;
  }
  status() {
    return { provider: 'mock', enabled: true, note: 'SIMULATED transcription (MOCK)' };
  }
  push(...items) {
    this.script.push(...items);
  }
  async transcribe(_wav, options = {}) {
    this.calls++;
    this.lastOptions = options;
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    const item = typeof next === 'string' ? { text: next } : next ?? { text: '' };
    return { text: item.text ?? '', confidence: item.confidence ?? 0.95, noSpeech: item.noSpeech ?? 0, hallucination: false, provider: 'mock', model: 'mock', latencyMs: 0, attempts: 1 };
  }
}

export function createSTT({ config, db, logger, fetchImpl }) {
  if (config.stt.provider === 'groq' && config.stt.apiKey) return new GroqSTT({ config, db, logger, fetchImpl });
  if (config.stt.provider === 'mock') return new MockSTT();
  return new NoSTT();
}
