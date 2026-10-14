import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { StreamType } from '@discordjs/voice';
import { sniffFormat, Resampler, Mp3ToPcm, detectFfmpeg, engineDescription, createPlayableStream, openInput } from '../features/music/audioEngine.js';
import { MusicError } from '../features/music/providers.js';
import { tempDir } from './helpers.js';

// tests/fixtures/tone-440hz.mp3: 1 s, 440 Hz sine, 22.05 kHz mono, 32 kbps (generated once with FFmpeg).
const MP3 = path.join(import.meta.dirname, 'fixtures', 'tone-440hz.mp3');
const NO_FFMPEG = { available: false };

const collect = async (stream) => {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
};

/** Estimate the dominant frequency of interleaved s16le stereo PCM by zero crossings (left channel). */
function zeroCrossingHz(pcm, rate = 48000) {
  let crossings = 0;
  let prev = 0;
  const frames = pcm.length / 4;
  for (let i = 0; i < frames; i++) {
    const v = pcm.readInt16LE(i * 4);
    if ((prev < 0 && v >= 0) || (prev >= 0 && v < 0)) crossings++;
    prev = v;
  }
  return crossings / 2 / (frames / rate);
}

test('format sniffing recognises the formats providers return', () => {
  const b = (s) => Buffer.from(s, 'latin1');
  assert.equal(sniffFormat(b('OggS\0\x02........OpusHead')), 'ogg-opus');
  assert.equal(sniffFormat(b('OggS\0\x02........\x01vorbis')), 'ogg-other');
  assert.equal(sniffFormat(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0])), 'webm');
  assert.equal(sniffFormat(b('ID3\x04\0\0\0\0\0\0')), 'mp3');
  assert.equal(sniffFormat(Buffer.from([0xff, 0xfb, 0x90, 0x64])), 'mp3', 'bare MPEG frame sync');
  assert.equal(sniffFormat(b('fLaC\0\0\0\x22')), 'flac');
  assert.equal(sniffFormat(b('RIFF\0\0\0\0WAVEfmt ')), 'wav');
  assert.equal(sniffFormat(b('\0\0\0\x20ftypM4A ')), 'mp4');
  assert.equal(sniffFormat(fs.readFileSync(MP3).subarray(0, 64)), 'mp3');
});

test('resampler converts to 48 kHz stereo at the right length, streaming across chunks', () => {
  const rs = new Resampler(22050);
  const total = 22050;
  const sine = new Float32Array(total).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 22050) * 0.5);
  const parts = [];
  for (let i = 0; i < total; i += 1000) parts.push(rs.process([sine.subarray(i, i + 1000)]));
  const pcm = Buffer.concat(parts);
  const frames = pcm.length / 4;
  assert.ok(Math.abs(frames - 48000) < 10, `~48000 frames, got ${frames}`);
  assert.equal(pcm.readInt16LE(4000 * 4), pcm.readInt16LE(4000 * 4 + 2), 'mono duplicated to both channels');
  assert.ok(Math.abs(zeroCrossingHz(pcm) - 440) < 5);
});

test('built-in MP3 decoder (no FFmpeg) produces correct 48 kHz PCM', async () => {
  const dec = new Mp3ToPcm();
  const pcm = await collect(fs.createReadStream(MP3, { highWaterMark: 777 }).pipe(dec));
  const seconds = pcm.length / 4 / 48000;
  assert.ok(seconds > 0.95 && seconds < 1.15, `about 1 s of audio, got ${seconds.toFixed(3)} s`);
  assert.ok(Math.abs(zeroCrossingHz(pcm) - 440) < 8, 'tone frequency preserved');
  assert.equal(dec.decoder, null, 'WASM decoder freed after the stream ends');
});

test('createPlayableStream without FFmpeg: MP3 decoded, Opus passed through, other formats refused clearly', async () => {
  const mp3 = await createPlayableStream(MP3, { ffmpeg: NO_FFMPEG });
  assert.deepEqual([mp3.engine, mp3.format, mp3.inputType], ['builtin', 'mp3', StreamType.Raw]);
  assert.ok((await collect(mp3.stream)).length > 150000);

  const dir = tempDir();
  const ogg = path.join(dir, 'a.opus');
  fs.writeFileSync(ogg, Buffer.concat([Buffer.from('OggS\0\x02', 'latin1'), Buffer.alloc(22), Buffer.from('OpusHead'), Buffer.alloc(40)]));
  const o = await createPlayableStream(ogg, { ffmpeg: NO_FFMPEG });
  assert.equal(o.inputType, StreamType.OggOpus);
  const head = await collect(o.stream);
  assert.equal(head.subarray(0, 4).toString('latin1'), 'OggS', 'peeked bytes are not lost');

  const wav = path.join(dir, 'a.wav');
  fs.writeFileSync(wav, Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt ', 'latin1'), Buffer.alloc(64)]));
  await assert.rejects(createPlayableStream(wav, { ffmpeg: NO_FFMPEG }), (e) => e instanceof MusicError && e.code === 'unsupported' && /needs FFmpeg/.test(e.message));
});

test('remote inputs: HTTP errors become clear music errors (MOCK HTTP)', async () => {
  const res = (status) => async () => ({ ok: status < 400, status, headers: { get: () => null }, body: null });
  await assert.rejects(openInput('https://x.example/a.mp3', { fetchImpl: res(404) }), (e) => e instanceof MusicError && e.code === 'not_found');
  await assert.rejects(openInput('https://x.example/a.mp3', { fetchImpl: res(429) }), (e) => e instanceof MusicError);
  await assert.rejects(openInput('https://x.example/a.mp3', { fetchImpl: res(403) }), (e) => e instanceof MusicError);
  const body = Readable.toWeb(fs.createReadStream(MP3));
  const ok = await createPlayableStream('https://x.example/a.mp3', { ffmpeg: NO_FFMPEG, fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'audio/mpeg' }, body }) });
  assert.equal(ok.format, 'mp3');
  assert.ok((await collect(ok.stream)).length > 150000);
});

test('FFmpeg detection: FFMPEG_PATH, PATH, or none — never assumed (MOCK process runner)', () => {
  const runner = (okCommands) => (cmd) => (okCommands.includes(cmd) ? { status: 0, stdout: 'ffmpeg version 7.1-static Copyright' } : { status: null, error: new Error('ENOENT') });
  const none = detectFfmpeg({ force: true, env: {}, run: runner([]) });
  assert.equal(none.available, false);
  assert.match(engineDescription(none), /built-in decoder.*MP3/);
  const custom = detectFfmpeg({ force: true, env: { FFMPEG_PATH: '/opt/ff/ffmpeg' }, run: runner(['/opt/ff/ffmpeg']) });
  assert.deepEqual([custom.available, custom.command, custom.source, custom.version], [true, '/opt/ff/ffmpeg', 'FFMPEG_PATH', '7.1-static']);
  const system = detectFfmpeg({ force: true, env: {}, run: runner(['ffmpeg']) });
  assert.equal(system.command, 'ffmpeg');
  detectFfmpeg({ force: true }); // restore the real cached value for other tests
});
