// Live speech-to-text benchmark against Groq (uses GROQ_API_KEY from .env).
//
// Synthesises command phrases with the Windows speech engine, pushes them
// through an emulation of Discord's voice transport (20 ms Opus packets, no
// packets during pauses), then transcribes them with:
//   A  old pipeline   (gaps removed, 3-sample average resampling, no prompt) — turbo
//   B  new pipeline, no prompt                                                 — turbo
//   C  new pipeline + domain prompt                                            — turbo
//   D  new pipeline + domain prompt                                            — whisper-large-v3
// Reports word error rate, wake-word detection, correct command parsing and latency.
// Synthetic speech is cleaner than a real microphone: treat results as a
// comparison between configurations, not as real-world accuracy.
// Usage: npm run benchmark:stt [-- --quick] [-- --heldout]
import { spawnSync } from 'node:child_process';
import OpusScript from 'opusscript';
import { loadEnv, getConfig } from '../config/env.js';
import { synthesize, ttsAvailable } from '../features/voice/tts.js';
import { ffmpegPath } from '../features/welcome/renderer.js';
import { prepareForStt, pcmToWav } from '../features/voice/audio.js';
import { groqTranscribe } from '../ai/groq.js';
import { buildSttPrompt } from '../features/voice/stt.js';
import { detectWakeWord } from '../features/voice/pipeline.js';
import { parseCommand } from '../core/intents/parser.js';

loadEnv();
const cfg = getConfig();
if (!cfg.stt.apiKey) {
  console.error('GROQ_API_KEY is not set; nothing to benchmark.');
  process.exit(1);
}
if (!ttsAvailable()) {
  console.error('This benchmark synthesises speech with the Windows speech engine; run it on Windows.');
  process.exit(1);
}

const PHRASES = [
  ['Alpha, play Her by JVKE.', 'music.play'],
  ['Alpha, skip.', 'music.skip'],
  ['Alpha, show the queue.', 'music.queue'],
  ['Alpha, pause.', 'music.pause'],
  ['Alpha, timeout Bob for five minutes.', 'mod.timeout'],
  ['Alpha, create a gaming channel.', 'channel.create'],
  ['Alpha, give the Gaming role access to that channel.', 'channel.permit'],
  ["Alpha, give me today's server activity report.", 'report.activity'],
  ["Alpha, find today's AI news, and post a summary in research.", 'research.run'],
  ['Alpha, stop listening.', 'voice.stop_listening'],
];
// Held-out commands: none of these appear in the STT prompt, and no custom vocabulary is used.
const HELDOUT = [
  ['Alpha, resume the music.', 'music.resume'],
  ['Alpha, warn Kai for spamming.', 'mod.warn'],
  ['Alpha, create a Research role.', 'role.create'],
  ['Alpha, remind me to stretch in twenty minutes.', 'reminder.create'],
  ['Alpha, lock general.', 'security.lockdown'],
  ['Alpha, set the volume to forty.', 'music.volume'],
  ['Alpha, shuffle the queue.', 'music.shuffle'],
  ['Alpha, play Moonlight Sonata by Beethoven.', 'music.play'],
  ['Alpha, loop this song.', 'music.loop'],
  ["Alpha, what's playing?", 'music.nowplaying'],
];
const quick = process.argv.includes('--quick');
const heldout = process.argv.includes('--heldout');
const phrases = (heldout ? HELDOUT : PHRASES).slice(0, quick ? 4 : undefined);

/** WAV (any rate) → 48 kHz stereo s16le via ffmpeg. */
function to48kStereo(wav) {
  const r = spawnSync(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { input: wav, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
  return r.stdout;
}

/**
 * Emulate a Discord client: Opus-encode 20 ms frames and do not send frames
 * during silence (client-side voice activity), keeping real arrival times.
 * Optionally add background noise at a given SNR.
 */
function discordTransport(pcm48, { noiseSnrDb = null } = {}) {
  const enc = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const dec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const FRAME = 3840;
  let src = pcm48;
  if (noiseSnrDb != null) {
    let sig = 0;
    for (let i = 0; i < src.length; i += 2) sig += (src.readInt16LE(i) / 32768) ** 2;
    const noiseRms = Math.sqrt(sig / (src.length / 2)) / 10 ** (noiseSnrDb / 20);
    src = Buffer.from(src);
    for (let i = 0; i < src.length; i += 2) {
      const n = (Math.random() * 2 - 1) * noiseRms * Math.sqrt(3) * 32768;
      src.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(src.readInt16LE(i) + n))), i);
    }
  }
  const frames = [];
  let hangover = 0;
  for (let off = 0, t = 0; off + FRAME <= src.length; off += FRAME, t += 20) {
    const f = src.subarray(off, off + FRAME);
    let e = 0;
    for (let i = 0; i < FRAME; i += 4) e += (f.readInt16LE(i) / 32768) ** 2;
    const voiced = Math.sqrt(e / 960) > 0.01;
    hangover = voiced ? 10 : hangover - 1; // keep ~200 ms after speech, like a client VAD
    if (hangover <= 0) continue; // client sends nothing during silence
    const pkt = enc.encode(f, 960);
    frames.push({ pcm: Buffer.from(dec.decode(pkt)), at: t });
  }
  enc.delete();
  dec.delete();
  return frames;
}

/** The previous implementation: gaps dropped, 3-sample averaging, no padding. */
function oldPipeline(frames) {
  const pcm = Buffer.concat(frames.map((f) => f.pcm));
  const n = Math.floor(pcm.length / 4 / 3);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) acc += pcm.readInt16LE((i * 3 + k) * 4) + pcm.readInt16LE((i * 3 + k) * 4 + 2);
    out.writeInt16LE(Math.round(acc / 6), i * 2);
  }
  return pcmToWav(out);
}

const norm = (s) =>
  String(s).toLowerCase().replace(/\balfa\b/g, 'alpha').replace(/\bfive\b/g, '5').replace(/['’]/g, '').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
function wer(ref, hyp) {
  const r = norm(ref);
  const h = norm(hyp);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / r.length;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CONFIGS = [
  { id: 'A', label: 'old pipeline, turbo, no prompt', model: 'whisper-large-v3-turbo', newPipe: false, prompt: false },
  { id: 'B', label: 'new pipeline, turbo, no prompt', model: 'whisper-large-v3-turbo', newPipe: true, prompt: false },
  { id: 'C', label: 'new pipeline, turbo, prompt', model: 'whisper-large-v3-turbo', newPipe: true, prompt: true },
  { id: 'D', label: 'new pipeline, large-v3, prompt', model: 'whisper-large-v3', newPipe: true, prompt: true },
];
const VARIANTS = quick ? [{ id: 'clean', snr: null }] : [{ id: 'clean', snr: null }, { id: 'noisy (15 dB SNR)', snr: 15 }];
const prompt = buildSttPrompt({ wakeWord: cfg.voice.wakeWord, vocabulary: heldout ? [] : ['JVKE'] });

const stats = Object.fromEntries(CONFIGS.map((c) => [c.id, { wer: 0, wake: 0, parsed: 0, latency: [], n: 0, samples: [] }]));
console.log(`Set: ${heldout ? 'HELD-OUT (not in prompt, no vocabulary)' : 'standard (overlaps prompt examples; vocabulary: JVKE)'}`);
console.log(`Benchmarking ${phrases.length} phrases × ${VARIANTS.length} variant(s) × ${CONFIGS.length} configurations (${phrases.length * VARIANTS.length * CONFIGS.length} Groq requests, paced at ≤20/min)…`);
for (const [text, action] of phrases) {
  const pcm48 = to48kStereo(await synthesize(text));
  for (const v of VARIANTS) {
    const frames = discordTransport(pcm48, { noiseSnrDb: v.snr });
    const newWav = prepareForStt(frames).wav;
    const oldWav = oldPipeline(frames);
    for (const c of CONFIGS) {
      const started = Date.now();
      let out;
      try {
        out = await groqTranscribe({ apiKey: cfg.stt.apiKey, model: c.model, wav: c.newPipe ? newWav : oldWav, language: 'en', prompt: c.prompt ? prompt : undefined, timeoutMs: 20000 });
      } catch (err) {
        console.log(`  ${c.id} ${v.id}: request failed (${err.status ?? err.name})`);
        await sleep(3500);
        continue;
      }
      const ms = Date.now() - started;
      const hyp = String(out.text ?? '').trim();
      const s = stats[c.id];
      const wk = detectWakeWord(hyp, cfg.voice.wakeWord);
      const steps = wk.activated ? parseCommand(wk.command).steps : [];
      s.wer += wer(text, hyp);
      s.wake += wk.activated ? 1 : 0;
      s.parsed += steps[0]?.action === action ? 1 : 0;
      s.latency.push(ms);
      s.n++;
      if (s.samples.length < 4 && wer(text, hyp) > 0) s.samples.push(`"${text}" → "${hyp}"`);
      await sleep(3200); // stay under 20 requests/minute
    }
  }
  process.stdout.write('.');
}
console.log('\n');
console.log('Config | Description                         | WER    | Wake word | Correct command | Median latency');
console.log('-------|-------------------------------------|--------|-----------|-----------------|---------------');
for (const c of CONFIGS) {
  const s = stats[c.id];
  if (!s.n) continue;
  const lat = [...s.latency].sort((a, b) => a - b)[Math.floor(s.latency.length / 2)];
  console.log(`${c.id}      | ${c.label.padEnd(35)} | ${((s.wer / s.n) * 100).toFixed(1).padStart(5)}% | ${String(s.wake).padStart(3)}/${s.n}    | ${String(s.parsed).padStart(3)}/${s.n}          | ${lat} ms`);
}
console.log('\nSample errors (reference → transcript):');
for (const c of CONFIGS) for (const e of stats[c.id].samples) console.log(`  ${c.id}: ${e}`);
console.log('\nPricing (Groq docs): whisper-large-v3-turbo $0.04/h, whisper-large-v3 $0.111/h; free plan is rate limited, not billed.');
