// Turns a track's stream URL/path into something @discordjs/voice can play.
//
//   Engine "ffmpeg": used when an FFmpeg binary is available (FFMPEG_PATH,
//     ffmpeg-static, or `ffmpeg` on PATH). Decodes any format.
//   Engine "builtin": no FFmpeg needed (for hosts that block ffmpeg-static's
//     install script). MP3 is decoded with mpg123 compiled to WebAssembly and
//     resampled to 48 kHz stereo; Ogg/Opus and WebM/Opus are passed through
//     untouched. Other formats (AAC, Vorbis, FLAC) need FFmpeg and are
//     reported clearly instead of failing silently.
//
// Audio is streamed chunk by chunk with backpressure; nothing is written to disk.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Readable, Transform } from 'node:stream';
import { StreamType } from '@discordjs/voice';
import { MPEGDecoder } from 'mpg123-decoder';
import { MusicError } from './providers.js';

const require = createRequire(import.meta.url);
const UA = 'SoulSocietyGuardians/1.0 (Discord bot)';

// ------------------------------------------------------------------ FFmpeg detection

let cachedFfmpeg = null;

/**
 * Find a working FFmpeg binary. Order: FFMPEG_PATH, ffmpeg-static (only if
 * its binary was actually downloaded), `ffmpeg` on PATH.
 * @returns {{available:boolean, command:string|null, source:string|null, version:string|null}}
 */
export function detectFfmpeg({ force = false, env = process.env, run = spawnSync } = {}) {
  if (cachedFfmpeg && !force) return cachedFfmpeg;
  const candidates = [];
  if (env.FFMPEG_PATH) candidates.push([env.FFMPEG_PATH, 'FFMPEG_PATH']);
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) candidates.push([p, 'ffmpeg-static']);
  } catch {
    /* optional dependency not installed */
  }
  candidates.push(['ffmpeg', 'system PATH']);
  for (const [command, source] of candidates) {
    try {
      const r = run(command, ['-hide_banner', '-version'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      if (r.error || r.status !== 0) continue;
      const version = /ffmpeg version (\S+)/.exec(String(r.stdout))?.[1] ?? 'unknown';
      cachedFfmpeg = { available: true, command, source, version };
      return cachedFfmpeg;
    } catch {
      /* try next */
    }
  }
  cachedFfmpeg = { available: false, command: null, source: null, version: null };
  return cachedFfmpeg;
}

export function engineDescription(info = detectFfmpeg()) {
  return info.available ? `FFmpeg ${info.version} (${info.source}) — all formats` : 'built-in decoder (no FFmpeg): MP3, Ogg/Opus, WebM/Opus';
}

/** Spawn FFmpeg reading `input` and emitting 48 kHz stereo s16le on stdout. */
export function spawnFfmpeg(command, input, { remote }) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    ...(remote ? ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '5', '-rw_timeout', '15000000', '-user_agent', UA] : []),
    '-i', input, '-analyzeduration', '0', '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
  ];
  const proc = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = proc.stdout;
  let stderr = '';
  proc.stderr.on('data', (d) => {
    if (stderr.length < 2000) stderr += d;
  });
  proc.on('error', (err) => out.destroy(err));
  proc.on('close', (code) => {
    if (code && code !== 255 && !out.destroyed && !out.readableEnded) out.destroy(new Error(`FFmpeg exited with code ${code}: ${stderr.trim().slice(0, 200)}`));
  });
  // Destroying the stream (skip/stop/disconnect) always kills the process.
  const kill = () => {
    if (proc.exitCode == null && !proc.killed) proc.kill('SIGKILL');
  };
  out.once('close', kill);
  out.once('error', kill);
  out.process = proc;
  return out;
}

// ------------------------------------------------------------------ built-in decoding

/** Detect the container/codec from the first bytes (and Content-Type as a hint). */
export function sniffFormat(head, contentType = '') {
  const b = head;
  const ascii = (o, n) => b.subarray(o, o + n).toString('latin1');
  if (b.length >= 4 && ascii(0, 4) === 'OggS') return b.includes(Buffer.from('OpusHead')) ? 'ogg-opus' : 'ogg-other';
  if (b.length >= 4 && b.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  if (b.length >= 4 && ascii(0, 4) === 'fLaC') return 'flac';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'wav';
  if (b.length >= 8 && ascii(4, 4) === 'ftyp') return 'mp4';
  if (b.length >= 3 && ascii(0, 3) === 'ID3') return 'mp3';
  if (b.length >= 2 && b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return (b[1] & 0x06) === 0 ? 'aac' : 'mp3';
  if (/audio\/(mpeg|mp3)/i.test(contentType)) return 'mp3';
  if (/opus/i.test(contentType)) return 'ogg-opus';
  if (/aac|mp4|m4a/i.test(contentType)) return 'aac';
  return 'unknown';
}

/**
 * Streaming resampler (4-point Hermite) from any rate to 48 kHz, interleaved
 * stereo s16le output. Keeps state across chunks.
 */
export class Resampler {
  constructor(inRate, outRate = 48000) {
    this.step = inRate / outRate;
    this.pos = 0; // fractional read position relative to the history window
    this.hist = [new Float32Array(0), new Float32Array(0)];
  }

  /** @param {Float32Array[]} channels 1 or 2 channels at the input rate */
  process(channels) {
    const left = channels[0];
    const right = channels[1] ?? channels[0];
    const L = concat(this.hist[0], left);
    const R = concat(this.hist[1], right);
    const n = L.length;
    const out = [];
    // Need samples i-1 .. i+2 around each output position.
    while (this.pos + 2 < n) {
      const i = Math.floor(this.pos);
      const t = this.pos - i;
      out.push(hermite(L, i, t), hermite(R, i, t));
      this.pos += this.step;
    }
    // Keep the last few samples as history for the next chunk.
    const keepFrom = Math.max(0, Math.floor(this.pos) - 1);
    this.hist = [L.subarray(keepFrom), R.subarray(keepFrom)];
    this.pos -= keepFrom;
    const buf = Buffer.alloc(out.length * 2);
    for (let k = 0; k < out.length; k++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[k] * 32767))), k * 2);
    return buf;
  }
}

function concat(a, b) {
  if (!a.length) return b;
  const c = new Float32Array(a.length + b.length);
  c.set(a);
  c.set(b, a.length);
  return c;
}

function hermite(x, i, t) {
  const xm1 = x[i - 1] ?? x[i];
  const x0 = x[i];
  const x1 = x[i + 1];
  const x2 = x[i + 2];
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const bNeg = w + a;
  return ((a * t - bNeg) * t + c) * t + x0;
}

/** MP3 → 48 kHz stereo s16le PCM, decoded in WebAssembly (no FFmpeg). */
export class Mp3ToPcm extends Transform {
  constructor() {
    super();
    this.decoder = new MPEGDecoder();
    this.resampler = null;
    this.decodedSamples = 0;
  }

  _transform(chunk, _enc, cb) {
    const decoder = this.decoder;
    if (!decoder) return cb();
    decoder.ready
      .then(() => {
        const r = decoder.decode(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
        if (r.samplesDecoded) {
          this.decodedSamples += r.samplesDecoded;
          if (!this.resampler || this.resampler.inRate !== r.sampleRate) {
            this.resampler = new Resampler(r.sampleRate);
            this.resampler.inRate = r.sampleRate;
          }
          const pcm = this.resampler.process(r.channelData);
          if (pcm.length) this.push(pcm);
        }
        cb();
      })
      .catch((err) => cb(new MusicError('unavailable', `Could not decode this MP3 stream (${err.message}).`)));
  }

  _flush(cb) {
    this.release();
    cb();
  }

  _destroy(err, cb) {
    this.release();
    cb(err);
  }

  release() {
    const d = this.decoder;
    if (!d) return;
    this.decoder = null;
    d.ready.then(() => d.free()).catch(() => null);
  }
}

/** Read the first `bytes` of a stream without losing them. */
export function peek(stream, bytes = 64) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    const done = () => {
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('error', onErr);
      stream.pause();
      const head = Buffer.concat(chunks);
      if (head.length) stream.unshift(head);
      resolve(head);
    };
    const onData = (c) => {
      chunks.push(c);
      n += c.length;
      if (n >= bytes) done();
    };
    const onEnd = () => done();
    const onErr = (e) => reject(e);
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('error', onErr);
  });
}

/** Open a remote (https) or local input as a Node stream. */
export async function openInput(input, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!/^https?:\/\//i.test(input)) {
    if (!fs.existsSync(input)) throw new MusicError('not_found', 'That audio file is no longer available.');
    return { stream: fs.createReadStream(input, { highWaterMark: 64 * 1024 }), contentType: '' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(input, { headers: { 'User-Agent': UA, Accept: 'audio/*,*/*;q=0.5' }, redirect: 'follow', signal: controller.signal });
  } catch (err) {
    throw new MusicError('outage', `The audio stream could not be opened (${err.name === 'AbortError' ? 'timeout' : 'network error'}).`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 403 || res.status === 401) throw new MusicError('restricted', 'The provider refused to stream this track (private or restricted).');
  if (res.status === 404) throw new MusicError('not_found', 'The provider no longer has this track.');
  if (res.status === 429) throw new MusicError('rate_limited', 'The provider is rate limiting streams; try again shortly.');
  if (!res.ok || !res.body) throw new MusicError('outage', `The audio stream failed to open (HTTP ${res.status}).`);
  const stream = Readable.fromWeb(res.body, { highWaterMark: 64 * 1024 });
  return { stream, contentType: res.headers.get('content-type') ?? '' };
}

const FORMAT_NAMES = { aac: 'AAC/M4A', mp4: 'AAC/M4A', 'ogg-other': 'Ogg Vorbis', flac: 'FLAC', wav: 'WAV', unknown: 'an unrecognised format' };

/**
 * Build a playable stream for a resolved input.
 * @returns {Promise<{stream:import('node:stream').Readable, inputType:string, engine:'ffmpeg'|'builtin', format:string}>}
 */
export async function createPlayableStream(input, { ffmpeg = detectFfmpeg(), fetchImpl } = {}) {
  if (ffmpeg.available) {
    return { stream: spawnFfmpeg(ffmpeg.command, input, { remote: /^https?:\/\//i.test(input) }), inputType: StreamType.Raw, engine: 'ffmpeg', format: 'any' };
  }
  const { stream, contentType } = await openInput(input, { fetchImpl });
  let head;
  try {
    head = await peek(stream, 64);
  } catch (err) {
    stream.destroy();
    throw new MusicError('outage', `The audio stream broke while starting (${err.message}).`);
  }
  const format = sniffFormat(head, contentType);
  if (format === 'ogg-opus') return { stream, inputType: StreamType.OggOpus, engine: 'builtin', format };
  if (format === 'webm') return { stream, inputType: StreamType.WebmOpus, engine: 'builtin', format };
  if (format === 'mp3') {
    const pcm = new Mp3ToPcm();
    stream.on('error', (err) => pcm.destroy(err));
    pcm.once('close', () => stream.destroy());
    stream.pipe(pcm);
    return { stream: pcm, inputType: StreamType.Raw, engine: 'builtin', format };
  }
  stream.destroy();
  throw new MusicError('unsupported', `This stream is ${FORMAT_NAMES[format] ?? format}, which needs FFmpeg — not installed on this host. MP3 and Opus sources (Audius, Jamendo, most radio) still play.`);
}
