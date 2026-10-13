// Discord audio capture. Subscribes only to the speakers a caller allows
// (Discord delivers one stream per user, so audio is never mixed), decodes
// each Opus packet in memory, keeps the real pauses between packets, and
// emits one utterance per speech segment. Raw audio is never written to disk.
import { EndBehaviorType } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { prepareForStt } from './audio.js';

export class UtteranceCapture {
  /**
   * @param {object} o
   * @param {any} o.connection VoiceConnection
   * @param {(userId:string)=>boolean} o.allow which speakers may be captured
   * @param {(u:{userId:string, wav:Buffer, durationMs:number, speechMs:number, rms:number, metrics:object})=>void} o.onUtterance
   * @param {number} [o.silenceMs] end an utterance after this much silence
   * @param {number} [o.maxUtteranceMs] hard cap per utterance
   */
  constructor({ connection, allow, onUtterance, logger, silenceMs = 1100, maxUtteranceMs = 15000 }) {
    Object.assign(this, { connection, allow, onUtterance, logger, silenceMs, maxUtteranceMs });
    this.active = new Map(); // userId -> capture state
    this.stopped = false;
    this.onStart = (userId) => this.capture(userId);
    connection.receiver.speaking.on('start', this.onStart);
  }

  capture(userId) {
    if (this.stopped || this.active.has(userId) || !this.allow(userId)) return;
    const receiver = this.connection.receiver;
    // A previous stream that has ended but not yet closed would be returned
    // by subscribe() and silently drop this utterance: discard it first.
    const stale = receiver.subscriptions.get(userId);
    if (stale && (stale.readableEnded || stale.destroyed)) {
      stale.destroy();
      receiver.subscriptions.delete(userId);
    }
    const stream = receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: this.silenceMs } });
    const decoder = new OpusScript(48000, 2, OpusScript.Application.VOIP);
    const state = { frames: [], startedAt: Date.now(), decodeErrors: 0, packets: 0, finished: false };
    this.active.set(userId, state);
    const maxFrames = Math.ceil(this.maxUtteranceMs / 20);

    const finish = (reason) => {
      if (state.finished) return;
      state.finished = true;
      this.active.delete(userId);
      try {
        decoder.delete();
      } catch {
        /* already freed */
      }
      stream.removeAllListeners('data');
      if (!stream.destroyed) stream.destroy();
      const frames = state.frames;
      state.frames = null; // release audio immediately
      if (!frames.length || this.stopped) return;
      const t0 = Date.now();
      const prepared = prepareForStt(frames);
      try {
        this.onUtterance({
          userId,
          ...prepared,
          metrics: {
            captureMs: Date.now() - state.startedAt,
            packets: state.packets,
            decodeErrors: state.decodeErrors,
            gapsFilledMs: prepared.filledMs,
            preprocessMs: Date.now() - t0,
            endReason: reason,
          },
        });
      } catch (err) {
        this.logger?.error('utterance handler failed', { err });
      }
    };

    stream.on('data', (packet) => {
      if (state.finished) return;
      state.packets++;
      try {
        const pcm = Buffer.from(decoder.decode(packet));
        if (pcm.length) state.frames.push({ pcm, at: Date.now() });
      } catch {
        state.decodeErrors++; // corrupt/lost packet: skip it, keep the utterance
      }
      if (state.frames.length >= maxFrames) finish('max_length');
    });
    stream.once('end', () => finish('silence'));
    stream.once('error', (err) => {
      this.logger?.warn('audio receive error', { err: err.message });
      finish('error');
    });
  }

  stop() {
    this.stopped = true;
    this.connection.receiver.speaking.off('start', this.onStart);
    for (const userId of this.active.keys()) this.connection.receiver.subscriptions.get(userId)?.destroy();
    this.active.clear();
  }
}
