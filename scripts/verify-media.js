// Media diagnostics that need no Discord connection:
//  1. Windows TTS → WAV
//  2. ffmpeg decode of a local library file to Discord-format PCM (48 kHz stereo s16le)
//  3. Internet Archive: search a licensed recording, resolve and stream real audio through ffmpeg
//  4. Audius: licensed online search, live stream decode, ffmpeg process cleanup
//  5. Opus encode → decode round trip (the codec path used by the voice receiver)
// Usage: npm run verify:media
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import prism from 'prism-media';
import { synthesize, ttsAvailable } from '../features/voice/tts.js';
import { ffmpegStream } from '../features/music/discordAdapter.js';
import { searchLocal, searchArchive, resolveArchiveStream, searchTracks, streamInput } from '../features/music/providers.js';
import { loadEnv, getConfig } from '../config/env.js';
import { downsampleTo16kMono, rmsLevel, pcmToWav } from '../features/voice/audio.js';

loadEnv();
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message, ms: Date.now() - t });
  }
};

/** Read up to `bytes` of PCM from an ffmpeg stream, then stop it. */
function readPcm(stream, bytes, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const timer = setTimeout(() => done(new Error('timed out waiting for audio')), timeoutMs);
    function done(err) {
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.destroy();
      err ? reject(err) : resolve(Buffer.concat(chunks).subarray(0, bytes));
    }
    stream.on('data', (c) => {
      chunks.push(c);
      n += c.length;
      if (n >= bytes) done();
    });
    stream.on('error', (e) => done(e));
    stream.on('end', () => (n > 0 ? done() : done(new Error('stream ended with no audio'))));
  });
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soul-media-'));
let wavPath;

await check('Windows TTS synthesis', async () => {
  wavPath = path.join(dir, 'Test Artist - Guardian Test Song.wav');
  if (!ttsAvailable()) {
    // Not Windows (e.g. the Linux container): use a generated tone for the next check.
    const tone = Buffer.alloc(16000 * 2);
    for (let i = 0; i < 16000; i++) tone.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / 16000) * 8000), i * 2);
    fs.writeFileSync(wavPath, pcmToWav(tone));
    return 'SKIPPED (Windows speech engine not available on this OS; used a test tone instead)';
  }
  const wav = await synthesize('This is Aegis, testing the music pipeline.');
  fs.writeFileSync(wavPath, wav);
  return `${wav.length} bytes WAV`;
});

await check('Local library search + ffmpeg decode to 48 kHz stereo PCM', async () => {
  const [hit] = await searchLocal('guardian test song', { dir });
  if (!hit) throw new Error('local search found nothing');
  const pcm = await readPcm(ffmpegStream(hit.input, { remote: false }), 48000 * 4);
  const level = rmsLevel(downsampleTo16kMono(pcm));
  if (level < 0.005) throw new Error(`decoded audio is silent (rms ${level})`);
  return `"${hit.artist} - ${hit.title}" → ${pcm.length} bytes PCM (1 s), rms ${level.toFixed(3)}`;
});

await check('Internet Archive licensed search + live stream decode', async () => {
  const results = await searchArchive('moonlight sonata');
  if (!results.length) throw new Error('no licensed results');
  const track = results[0];
  const url = await resolveArchiveStream(track);
  const pcm = await readPcm(ffmpegStream(url, { remote: true }), 48000 * 4 * 2, 30000);
  return `"${track.title}" (${track.license}) → ${pcm.length} bytes decoded from ${new URL(url).hostname}`;
});

await check('Audius online search + live stream decode + ffmpeg cleanup', async () => {
  const config = getConfig();
  const { results, failed } = await searchTracks('lofi chill beats', { config: { ...config, music: { ...config.music, providers: ['audius'] } } });
  if (!results.length) throw new Error(`no Audius results${failed.length ? ` (${failed[0].code})` : ''}`);
  const track = results[0];
  const ff = ffmpegStream(await streamInput(track), { remote: true });
  const exited = new Promise((r) => ff.process.once('exit', r));
  const pcm = await readPcm(ff, 48000 * 4 * 2, 30000);
  const level = rmsLevel(downsampleTo16kMono(pcm));
  await Promise.race([exited, new Promise((_, rej) => setTimeout(() => rej(new Error('ffmpeg process did not exit after destroy')), 5000))]);
  return `"${track.title}" by ${track.artist} (${track.license}) → ${pcm.length} bytes PCM, rms ${level.toFixed(3)}; ffmpeg exited after stop`;
});

await check('Opus encode → decode round trip (opusscript)', async () => {
  const enc = new prism.opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  const dec = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
  const frame = Buffer.alloc(960 * 4);
  for (let i = 0; i < 960; i++) {
    const v = Math.round(Math.sin((i / 960) * Math.PI * 2 * 10) * 8000);
    frame.writeInt16LE(v, i * 4);
    frame.writeInt16LE(v, i * 4 + 2);
  }
  const out = [];
  dec.on('data', (c) => out.push(c));
  enc.pipe(dec);
  for (let i = 0; i < 10; i++) enc.write(frame);
  enc.end();
  await new Promise((r) => dec.on('end', r));
  const pcm = Buffer.concat(out);
  if (pcm.length < 960 * 4 * 5) throw new Error(`decoded only ${pcm.length} bytes`);
  return `10 frames encoded/decoded → ${pcm.length} bytes PCM`;
});

fs.rmSync(dir, { recursive: true, force: true });
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)\n      ${r.detail}`);
process.exit(results.every((r) => r.ok) ? 0 : 1);
