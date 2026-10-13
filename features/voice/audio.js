// Audio helpers for the speech pipeline. Captured audio only ever lives in
// memory: it is converted to a WAV buffer, sent to the configured STT
// provider and discarded.

const IN_RATE = 48000;
const OUT_RATE = 16000;
const DECIMATION = IN_RATE / OUT_RATE; // 3

/**
 * Windowed-sinc (Blackman) low-pass FIR. Cut-off below the 8 kHz Nyquist of
 * the 16 kHz output so higher frequencies do not alias into the speech band.
 */
function designLowPass(taps = 63, cutoffHz = 7200, rate = IN_RATE) {
  const fc = cutoffHz / rate;
  const m = taps - 1;
  const h = new Float64Array(taps);
  let sum = 0;
  for (let n = 0; n < taps; n++) {
    const x = n - m / 2;
    const sinc = x === 0 ? 2 * Math.PI * fc : Math.sin(2 * Math.PI * fc * x) / x;
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / m) + 0.08 * Math.cos((4 * Math.PI * n) / m);
    h[n] = sinc * w;
    sum += h[n];
  }
  for (let n = 0; n < taps; n++) h[n] /= sum;
  return h;
}
const LOW_PASS = designLowPass();

/** Downmix 48 kHz stereo s16le PCM to 16 kHz mono with anti-alias filtering. */
export function downsampleTo16kMono(pcm48kStereo) {
  const frames = Math.floor(pcm48kStereo.length / 4);
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) mono[i] = (pcm48kStereo.readInt16LE(i * 4) + pcm48kStereo.readInt16LE(i * 4 + 2)) / 2;
  const outFrames = Math.floor(frames / DECIMATION);
  const out = Buffer.alloc(outFrames * 2);
  const half = (LOW_PASS.length - 1) / 2;
  for (let o = 0; o < outFrames; o++) {
    const centre = o * DECIMATION;
    let acc = 0;
    for (let k = 0; k < LOW_PASS.length; k++) {
      const idx = centre + k - half;
      if (idx >= 0 && idx < frames) acc += mono[idx] * LOW_PASS[k];
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc))), o * 2);
  }
  return out;
}

/** Peak-normalise quiet speech (max gain 4×) so faint microphones are not lost. */
export function normaliseLevel(pcm16, { targetPeak = 0.7, maxGain = 4 } = {}) {
  const n = pcm16.length / 2;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(pcm16.readInt16LE(i * 2)));
  if (!peak) return pcm16;
  const gain = Math.min(maxGain, (targetPeak * 32767) / peak);
  if (gain <= 1.05) return pcm16;
  const out = Buffer.alloc(pcm16.length);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm16.readInt16LE(i * 2) * gain))), i * 2);
  return out;
}

/** Add silence before/after a clip (Whisper handles onsets better with lead-in). */
export function padSilence(pcm16, { leadMs = 200, tailMs = 300, rate = OUT_RATE } = {}) {
  return Buffer.concat([Buffer.alloc(Math.round((leadMs / 1000) * rate) * 2), pcm16, Buffer.alloc(Math.round((tailMs / 1000) * rate) * 2)]);
}

/**
 * Simple energy VAD: total milliseconds of 30 ms frames whose RMS exceeds a
 * threshold relative to the clip's noise floor. Used to skip clips that
 * contain no real speech (saves STT quota and avoids hallucinations).
 */
export function speechMs(pcm16, { rate = OUT_RATE, frameMs = 30, minRms = 0.012 } = {}) {
  const frame = Math.round((frameMs / 1000) * rate);
  const frames = Math.floor(pcm16.length / 2 / frame);
  if (!frames) return 0;
  const levels = [];
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = 0; i < frame; i++) {
      const v = pcm16.readInt16LE((f * frame + i) * 2) / 32768;
      sum += v * v;
    }
    levels.push(Math.sqrt(sum / frame));
  }
  const floor = [...levels].sort((a, b) => a - b)[Math.floor(levels.length * 0.1)] ?? 0;
  const threshold = Math.max(minRms, floor * 2.5);
  return levels.filter((l) => l > threshold).length * frameMs;
}

export function pcmToWav(pcm, { sampleRate = OUT_RATE, channels = 1, bitsPerSample = 16 } = {}) {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** RMS level (0..1) of 16-bit mono PCM. */
export function rmsLevel(pcm16) {
  const n = Math.floor(pcm16.length / 2);
  if (!n) return 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm16.readInt16LE(i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

export const durationMsOf16kMono = (pcm16) => Math.round((pcm16.length / 2 / OUT_RATE) * 1000);

/**
 * Turn decoded 20 ms Opus frames (48 kHz stereo) plus their arrival times
 * into one continuous PCM buffer, re-inserting the pauses during which the
 * Discord client sent no packets. Without this, "play … her by JVKE" reaches
 * the recogniser with the words glued together.
 * @param {{pcm:Buffer, at:number}[]} frames
 */
export function assembleWithGaps(frames, { frameMs = 20, gapThresholdMs = 80, maxGapMs = 1500 } = {}) {
  const parts = [];
  let filledMs = 0;
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) {
      const gap = frames[i].at - frames[i - 1].at - frameMs;
      if (gap >= gapThresholdMs) {
        const fill = Math.min(gap, maxGapMs);
        filledMs += fill;
        parts.push(Buffer.alloc(Math.round((fill / 1000) * IN_RATE) * 4));
      }
    }
    parts.push(frames[i].pcm);
  }
  return { pcm: Buffer.concat(parts), filledMs };
}

/** Full preprocessing used before transcription. */
export function prepareForStt(frames, opts = {}) {
  const { pcm, filledMs } = assembleWithGaps(frames, opts);
  const mono = normaliseLevel(downsampleTo16kMono(pcm));
  const speech = speechMs(mono);
  const padded = padSilence(mono);
  return { wav: pcmToWav(padded), durationMs: durationMsOf16kMono(mono), speechMs: speech, rms: rmsLevel(mono), filledMs };
}
