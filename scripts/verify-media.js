// Media diagnostics that need no Discord connection. They exercise the same
// code path as real playback (provider → createPlayableStream → @discordjs/voice
// AudioResource → Opus packets) and stop right before sending audio to Discord.
//  1. Audio engine detection (FFmpeg or the built-in decoder)
//  2. Built-in decoder: MP3 → 48 kHz PCM → Opus packets (works without FFmpeg)
//  3. Audius: licensed online search, live stream → Opus packets, stream cleanup
//  4. Internet Archive: licensed search, live stream → PCM (format depends on the item)
//  5. Windows TTS → WAV (Windows only)
//  6. Opus encode → decode round trip (the codec path used by the voice receiver)
// Usage: npm run verify:media                 (uses FFmpeg if present)
//        npm run verify:media -- --builtin    (simulate a host without FFmpeg)
import path from 'node:path';
import prism from 'prism-media';
import { createAudioResource } from '@discordjs/voice';
import { synthesize, ttsAvailable } from '../features/voice/tts.js';
import { detectFfmpeg, engineDescription, createPlayableStream } from '../features/music/audioEngine.js';
import { searchArchive, resolveArchiveStream, searchTracks, streamInput } from '../features/music/providers.js';
import { loadEnv, getConfig, ROOT } from '../config/env.js';
import { downsampleTo16kMono, rmsLevel } from '../features/voice/audio.js';

loadEnv();
const forceBuiltin = process.argv.includes('--builtin');
const ffmpeg = forceBuiltin ? { available: false } : detectFfmpeg();
const results = [];
const check = async (name, fn) => {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail, ms: Date.now() - t });
  } catch (err) {
    results.push({ name, ok: false, detail: `${err.code ? `[${err.code}] ` : ''}${err.message}`, ms: Date.now() - t });
  }
};

/** Read up to `bytes` of PCM from a stream, then destroy it. */
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

/** Pull Opus packets from an AudioResource exactly as the AudioPlayer does. */
async function readOpusPackets(resource, count, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const packets = [];
  while (packets.length < count) {
    if (Date.now() > deadline) throw new Error(`only ${packets.length} Opus packets before timeout`);
    if (resource.ended) throw new Error(`stream ended after ${packets.length} Opus packets`);
    const p = resource.readable ? resource.read() : null;
    if (p) packets.push(p);
    else await new Promise((r) => setTimeout(r, 20));
  }
  resource.playStream.destroy();
  return packets;
}

const engineName = forceBuiltin ? 'built-in decoder (forced with --builtin)' : engineDescription(ffmpeg);

await check('Audio engine', async () => engineName);

await check('Built-in decoder: MP3 → 48 kHz PCM → Opus packets (no FFmpeg)', async () => {
  const file = path.join(ROOT, 'tests', 'fixtures', 'tone-440hz.mp3');
  const p = await createPlayableStream(file, { ffmpeg: { available: false } });
  const resource = createAudioResource(p.stream, { inputType: p.inputType, inlineVolume: true });
  resource.volume.setVolume(0.7);
  const packets = await readOpusPackets(resource, 25);
  return `${p.format} via ${p.engine} → ${packets.length} Opus packets (0.5 s), first packet ${packets[0].length} bytes`;
});

await check('Audius licensed search + live stream → Opus packets + cleanup', async () => {
  const config = getConfig();
  const { results: found, failed } = await searchTracks('lofi chill beats', { config: { ...config, music: { ...config.music, providers: ['audius'] } } });
  if (!found.length) throw new Error(`no Audius results${failed.length ? ` (${failed[0].code})` : ''}`);
  const track = found[0];
  const p = await createPlayableStream(await streamInput(track), { ffmpeg });
  const pcmProbe = p.inputType === 'raw';
  const resource = createAudioResource(p.stream, { inputType: p.inputType, inlineVolume: true });
  const packets = await readOpusPackets(resource, 50, 30000);
  const closed = await Promise.race([
    new Promise((r) => (p.stream.destroyed ? r(true) : p.stream.once('close', () => r(true)))),
    new Promise((r) => setTimeout(() => r(false), 5000)),
  ]);
  if (!closed) throw new Error('stream did not close after stop');
  return `"${track.title}" by ${track.artist} (${track.license}) · ${p.format} via ${p.engine}${pcmProbe ? ' (decoded to PCM)' : ''} → ${packets.length} Opus packets (1 s); stream closed after stop`;
});

await check('Audius stream audio level (not silence)', async () => {
  const config = getConfig();
  const { results: found } = await searchTracks('lofi chill beats', { config: { ...config, music: { ...config.music, providers: ['audius'] } } });
  const track = found[0];
  const p = await createPlayableStream(await streamInput(track), { ffmpeg });
  if (p.inputType !== 'raw') return `SKIPPED (${p.format} passthrough — level is not measured without decoding)`;
  const pcm = await readPcm(p.stream, 48000 * 4 * 3, 30000);
  const level = rmsLevel(downsampleTo16kMono(pcm.subarray(48000 * 4)));
  if (level < 0.003) throw new Error(`decoded audio is silent (rms ${level})`);
  return `rms ${level.toFixed(3)} over 2 s of decoded audio`;
});

await check('Internet Archive licensed search + live stream', async () => {
  const found = await searchArchive('moonlight sonata');
  if (!found.length) throw new Error('no licensed results');
  const track = found[0];
  const url = await resolveArchiveStream(track);
  const p = await createPlayableStream(url, { ffmpeg });
  const bytes = await readPcm(p.stream, 48000 * 4, 30000);
  return `"${track.title}" (${track.license}) · ${p.format} via ${p.engine} → ${bytes.length} bytes from ${new URL(url).hostname}`;
});

await check('Windows TTS synthesis', async () => {
  if (!ttsAvailable()) return 'SKIPPED (Windows speech engine not available on this OS — spoken replies are off there)';
  const wav = await synthesize('This is Aegis, testing the voice pipeline.');
  return `${wav.length} bytes WAV`;
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

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} (${r.ms} ms)\n      ${r.detail}`);
console.log('\nNote: this verifies stream creation and Opus encoding only. Playback inside a Discord voice channel is verified only by a live /play test.');
process.exit(results.every((r) => r.ok) ? 0 : 1);
