// Discord audio capture. Subscribes only to the speakers a caller allows,
// decodes Opus to PCM in memory, and emits utterances. Raw audio is never
// written to disk.
import { EndBehaviorType } from '@discordjs/voice';
import prism from 'prism-media';
import { downsampleTo16kMono, pcmToWav, rmsLevel, durationMsOf16kMono } from './audio.js';

const MAX_BYTES = 48000 * 4 * 16; // ~16 s of 48 kHz stereo s16le

export class UtteranceCapture {
  /**
   * @param {object} o
   * @param {any} o.connection VoiceConnection
   * @param {(userId:string)=>boolean} o.allow which speakers may be captured
   * @param {(u:{userId:string, wav:Buffer, durationMs:number, rms:number})=>void} o.onUtterance
   */
  constructor({ connection, allow, onUtterance, logger, silenceMs = 900 }) {
    Object.assign(this, { connection, allow, onUtterance, logger, silenceMs });
    this.active = new Set();
    this.onStart = (userId) => this.capture(userId);
    connection.receiver.speaking.on('start', this.onStart);
  }

  capture(userId) {
    if (!this.allow(userId) || this.active.has(userId)) return;
    this.active.add(userId);
    const opus = this.connection.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs } });
    const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 });
    let chunks = [];
    let bytes = 0;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      this.active.delete(userId);
      const pcm = Buffer.concat(chunks);
      chunks = null; // release audio immediately
      if (!pcm.length) return;
      const mono = downsampleTo16kMono(pcm);
      const wav = pcmToWav(mono);
      try {
        this.onUtterance({ userId, wav, durationMs: durationMsOf16kMono(mono), rms: rmsLevel(mono) });
      } catch (err) {
        this.logger?.error('utterance handler failed', { err });
      }
    };
    const fail = (err) => {
      this.logger?.warn('audio receive error', { userId, err: err.message });
      chunks = [];
      finish();
    };
    opus.on('error', fail);
    decoder.on('error', fail);
    decoder.on('data', (c) => {
      if (chunks && bytes < MAX_BYTES) {
        chunks.push(c);
        bytes += c.length;
      }
    });
    decoder.on('end', finish);
    opus.on('end', () => decoder.end());
    opus.pipe(decoder);
  }

  stop() {
    this.connection.receiver.speaking.off('start', this.onStart);
    for (const userId of this.active) this.connection.receiver.subscriptions.get(userId)?.destroy();
    this.active.clear();
  }
}
