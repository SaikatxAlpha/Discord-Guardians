// Audio helpers. Captured audio only ever lives in memory: it is converted
// to a WAV buffer, sent to the configured STT provider and discarded.

/** Downmix 48 kHz stereo s16le PCM to 16 kHz mono (averaging decimation). */
export function downsampleTo16kMono(pcm48kStereo) {
  const samples = Math.floor(pcm48kStereo.length / 4); // frames (2 ch * 2 bytes)
  const outFrames = Math.floor(samples / 3);
  const out = Buffer.alloc(outFrames * 2);
  for (let i = 0; i < outFrames; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) {
      const f = (i * 3 + k) * 4;
      acc += pcm48kStereo.readInt16LE(f) + pcm48kStereo.readInt16LE(f + 2);
    }
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc / 6))), i * 2);
  }
  return out;
}

export function pcmToWav(pcm, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
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

/** RMS level (0..1) of 16-bit mono PCM; used to skip silent/noise utterances. */
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

export const durationMsOf16kMono = (pcm16) => Math.round((pcm16.length / 2 / 16000) * 1000);
