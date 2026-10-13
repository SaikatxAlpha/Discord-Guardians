import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWakeWord, VoicePipeline } from '../features/voice/pipeline.js';
import { MockSTT, GroqSTT, confidenceFromSegments, createSTT } from '../features/voice/stt.js';
import { pcmToWav, downsampleTo16kMono, rmsLevel, durationMsOf16kMono } from '../features/voice/audio.js';
import { VoiceModerationPipeline } from '../features/voice/voiceModeration.js';
import { cleanForSpeech } from '../features/voice/tts.js';
import { setGuildSetting } from '../core/settings.js';
import { testConfig, memDb } from './helpers.js';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const wav = pcmToWav(Buffer.alloc(32000));

function pipeline(script, handled = []) {
  const stt = new MockSTT(script); // MOCK: scripted transcripts, not real recognition
  const p = new VoicePipeline({
    stt,
    config: testConfig({ ownerId: OWNER }),
    handleCommand: async (req) => {
      handled.push(req);
      return { status: 'executed', results: [] };
    },
  });
  return { p, stt, handled };
}
const utt = (userId, o = {}) => ({ guildId: 'g', channelId: 'c', userId, wav, durationMs: 1500, rms: 0.1, ...o });

test('wake word detection', () => {
  assert.deepEqual(detectWakeWord('Alpha, play Blinding Lights.'), { activated: true, command: 'play Blinding Lights.' });
  assert.deepEqual(detectWakeWord('alfa skip'), { activated: true, command: 'skip' });
  assert.deepEqual(detectWakeWord('Um, alpha stop listening'), { activated: true, command: 'stop listening' });
  assert.equal(detectWakeWord('the alphabet song').activated, false);
  assert.equal(detectWakeWord('I said we should play alpha later').activated, false);
  assert.deepEqual(detectWakeWord('Alpha.'), { activated: true, command: '' });
});

test('the wake word is not authentication: other speakers are ignored before any transcription', async () => {
  const { p, stt, handled } = pipeline(['ALPHA, ban everyone']);
  const r = await p.handleUtterance(utt(STRANGER));
  assert.equal(r.reason, 'not_authorised_speaker');
  assert.equal(stt.calls, 0, 'stranger audio is never sent to STT');
  assert.equal(handled.length, 0);
});

test('owner command with the wake word reaches the coordinator with the real Discord identity', async () => {
  const { p, handled } = pipeline(['Alpha, create a gaming channel']);
  const r = await p.handleUtterance(utt(OWNER));
  assert.equal(r.status, 'handled');
  assert.equal(handled[0].userId, OWNER);
  assert.equal(handled[0].source, 'voice');
  assert.equal(handled[0].text, 'create a gaming channel');
});

test('owner speech without the wake word is ignored; a bare "ALPHA" arms the next utterance', async () => {
  const { p, handled } = pipeline(['so what are we playing tonight', 'Alpha.', 'skip this song', 'and another thing']);
  assert.equal((await p.handleUtterance(utt(OWNER))).reason, 'no_wake_word');
  assert.equal((await p.handleUtterance(utt(OWNER))).status, 'armed');
  assert.equal((await p.handleUtterance(utt(OWNER))).status, 'handled');
  assert.equal(handled[0].text, 'skip this song');
  assert.equal((await p.handleUtterance(utt(OWNER))).reason, 'no_wake_word', 'arming is consumed');
});

test('noise, very short or long clips are skipped; STT failures are reported', async () => {
  const events = [];
  const { p } = pipeline([new Error('Groq HTTP 429')]);
  p.onEvent = (e) => events.push(e.type);
  assert.equal((await p.handleUtterance(utt(OWNER, { durationMs: 100 }))).reason, 'too_short');
  assert.equal((await p.handleUtterance(utt(OWNER, { durationMs: 60000 }))).reason, 'too_long');
  assert.equal((await p.handleUtterance(utt(OWNER, { rms: 0.0001 }))).reason, 'silence');
  const r = await p.handleUtterance(utt(OWNER));
  assert.equal(r.reason, 'stt_failed');
  assert.deepEqual(events, ['stt_error']);
});

test('audio utilities produce valid 16 kHz mono WAV in memory', () => {
  const stereo48k = Buffer.alloc(48000 * 4); // 1 second
  for (let i = 0; i < 48000; i++) {
    const v = Math.round(Math.sin(i / 10) * 10000);
    stereo48k.writeInt16LE(v, i * 4);
    stereo48k.writeInt16LE(v, i * 4 + 2);
  }
  const mono = downsampleTo16kMono(stereo48k);
  assert.equal(mono.length, 16000 * 2);
  assert.equal(durationMsOf16kMono(mono), 1000);
  assert.ok(rmsLevel(mono) > 0.1);
  const w = pcmToWav(mono);
  assert.equal(w.subarray(0, 4).toString(), 'RIFF');
  assert.equal(w.readUInt32LE(24), 16000);
  assert.equal(w.readUInt16LE(22), 1);
});

test('Groq STT adapter: request format, confidence, daily cap and circuit breaker (mocked HTTP)', async () => {
  const db = memDb();
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ text: ' Alpha, skip. ', segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01 }] }) };
  };
  const config = testConfig({ stt: { provider: 'groq', apiKey: 'gsk_test', model: 'whisper-large-v3-turbo', language: 'en', dailyLimit: 2, timeoutMs: 1000 } });
  const stt = new GroqSTT({ config, db, fetchImpl });
  const r = await stt.transcribe(wav, { durationMs: 1000 });
  assert.equal(r.text, 'Alpha, skip.');
  assert.ok(r.confidence > 0.85);
  assert.match(calls[0].url, /audio\/transcriptions$/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer gsk_test');
  assert.equal(calls[0].init.body.get('model'), 'whisper-large-v3-turbo');
  await stt.transcribe(wav, { durationMs: 1000 });
  await assert.rejects(() => stt.transcribe(wav, { durationMs: 1000 }), /Daily speech-to-text limit/);
  const failing = new GroqSTT({ config: { ...config, stt: { ...config.stt, dailyLimit: 100 } }, db: memDb(), fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '30' }, text: async () => 'rate limited' }) });
  await assert.rejects(() => failing.transcribe(wav, {}), /429/);
  assert.equal(failing.available(), false, 'circuit opens on 429 and voice degrades gracefully');
  assert.ok(confidenceFromSegments([{ start: 0, end: 1, avg_logprob: -1.5, no_speech_prob: 0.6 }]) < 0.2);
  assert.equal(createSTT({ config: testConfig(), db }).available(), false, 'no provider configured → voice disabled, not faked');
});

test('voice moderation: uncertain transcripts go to review; confident ones are capped at warn', async () => {
  const db = memDb();
  const enforced = [];
  const enforce = async (o) => {
    enforced.push(o);
    return { ok: true };
  };
  let now = 1_000_000;
  const vm = new VoiceModerationPipeline({ db, enforce, now: () => now });
  const base = { guildId: 'g', channelId: 'vc', userId: 'u', member: { id: 'u' }, guild: {} };
  assert.equal((await vm.handleTranscript({ ...base, text: 'good game everyone', confidence: 0.99 })).decision, 'clean');
  assert.equal((await vm.handleTranscript({ ...base, text: 'what the fuck', confidence: 0.4 })).decision, 'review');
  assert.equal(db.get('SELECT COUNT(*) AS n FROM voice_reviews').n, 1);
  // Even with points high enough for a kick, voice is capped at warn.
  db.run(`INSERT INTO mod_cases (guild_id, user_id, bot, action, points, result, created_at) VALUES ('g', 'u', 'knight', 'warn', 9, 'success', ?)`, now);
  const r = await vm.handleTranscript({ ...base, text: 'fuck this', confidence: 0.95 });
  assert.equal(r.decision, 'enforced');
  assert.equal(enforced[0].action, 'warn');
  assert.equal(enforced[0].automatic, true);
  assert.equal((await vm.handleTranscript({ ...base, text: 'shit', confidence: 0.95 })).decision, 'debounced');
  now += 61000;
  setGuildSetting(db, 'g', 'moderation.voice.maxAutoAction', 'timeout');
  await vm.handleTranscript({ ...base, text: 'shit', confidence: 0.95 });
  assert.ok(['warn', 'timeout'].includes(enforced[1].action));
  assert.notEqual(enforced[1].action, 'kick');
});

test('spoken responses strip mentions, links and markdown', () => {
  assert.equal(cleanForSpeech('**Done** <#123456789012345678> see https://x.y/z <t:1:R>'), 'Done see link');
});
