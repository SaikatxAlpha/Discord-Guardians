// Speech-to-text providers behind one interface:
//   transcribe(wav: Buffer, {durationMs}) -> {text, confidence (0..1), provider}
// Replacing the provider only requires another class with this shape.
import { groqTranscribe } from '../../ai/groq.js';
import { reserveUsage, CircuitBreaker, usageToday } from '../../ai/usage.js';

export class NoSTT {
  name = 'none';
  available() {
    return false;
  }
  status() {
    return { provider: 'none', enabled: false, note: 'No speech-to-text provider configured (set GROQ_API_KEY).' };
  }
  async transcribe() {
    throw new Error('Speech-to-text is not configured.');
  }
}

/** Groq Whisper (free plan, no payment method; rate limited). */
export class GroqSTT {
  constructor({ config, db, logger, fetchImpl }) {
    this.name = 'groq';
    this.cfg = config.stt;
    this.db = db;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.breaker = new CircuitBreaker({ threshold: 3, cooldownMs: 2 * 60000 });
  }
  available() {
    return Boolean(this.cfg.apiKey) && !this.breaker.open;
  }
  status() {
    const u = usageToday(this.db, 'groq', 'stt');
    return { provider: 'groq', model: this.cfg.model, enabled: Boolean(this.cfg.apiKey), circuitOpen: this.breaker.open, usedToday: u.requests, audioSecondsToday: u.units, dailyLimit: this.cfg.dailyLimit };
  }
  async transcribe(wav, { durationMs = 0 } = {}) {
    if (!this.available()) throw new Error('Speech-to-text is temporarily unavailable.');
    if (!reserveUsage(this.db, 'groq', 'stt', this.cfg.dailyLimit, Math.ceil(durationMs / 1000))) throw new Error('Daily speech-to-text limit reached.');
    try {
      const out = await groqTranscribe({ apiKey: this.cfg.apiKey, model: this.cfg.model, wav, language: this.cfg.language, timeoutMs: this.cfg.timeoutMs, fetchImpl: this.fetchImpl });
      this.breaker.success();
      return { text: String(out.text ?? '').trim(), confidence: confidenceFromSegments(out.segments), provider: 'groq' };
    } catch (err) {
      this.breaker.failure(err.status === 429 ? err.retryAfterMs || 60000 : undefined);
      throw err;
    }
  }
}

/**
 * Whisper reports avg_logprob and no_speech_prob per segment; convert to a
 * conservative 0..1 confidence (duration-weighted).
 */
export function confidenceFromSegments(segments) {
  if (!Array.isArray(segments) || !segments.length) return 0.5;
  let total = 0;
  let acc = 0;
  for (const s of segments) {
    const dur = Math.max(0.1, (s.end ?? 0) - (s.start ?? 0));
    const c = Math.exp(Math.min(0, s.avg_logprob ?? -1)) * (1 - Math.min(1, s.no_speech_prob ?? 0));
    acc += c * dur;
    total += dur;
  }
  return Math.max(0, Math.min(1, acc / total));
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
  async transcribe() {
    this.calls++;
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    if (typeof next === 'string') return { text: next, confidence: 0.95, provider: 'mock' };
    return { text: next?.text ?? '', confidence: next?.confidence ?? 0.95, provider: 'mock' };
  }
}

export function createSTT({ config, db, logger, fetchImpl }) {
  if (config.stt.provider === 'groq' && config.stt.apiKey) return new GroqSTT({ config, db, logger, fetchImpl });
  if (config.stt.provider === 'mock') return new MockSTT();
  return new NoSTT();
}
