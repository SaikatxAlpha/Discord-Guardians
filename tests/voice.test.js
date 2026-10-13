import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectWakeWord, VoicePipeline } from '../features/voice/pipeline.js';
import { buildWakeMatcher, normaliseTranscript, fixCommonMishearings } from '../features/voice/wakeword.js';
import { MockSTT, GroqSTT, assessTranscript, buildSttPrompt, createSTT, SttError } from '../features/voice/stt.js';
import { pcmToWav, downsampleTo16kMono, rmsLevel, durationMsOf16kMono, assembleWithGaps, speechMs, padSilence, normaliseLevel, prepareForStt } from '../features/voice/audio.js';
import { VoiceModerationPipeline } from '../features/voice/voiceModeration.js';
import { cleanForSpeech } from '../features/voice/tts.js';
import { setGuildSetting } from '../core/settings.js';
import { buildMockGuild } from './mocks/discord.js';
import { testConfig, memDb, coordinatorFor, rid } from './helpers.js';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';
const wav = pcmToWav(Buffer.alloc(32000));

function pipeline(script, { handled = [], authorize, guildOptions, config } = {}) {
  const stt = new MockSTT(script); // MOCK: scripted transcripts, not real recognition
  const events = [];
  const p = new VoicePipeline({
    stt,
    config: config ?? testConfig({ ownerId: OWNER, operatorGlobalAccess: true }),
    authorize,
    guildOptions,
    onEvent: (e) => events.push(e),
    handleCommand: async (req) => {
      handled.push(req);
      return { status: 'executed', results: [] };
    },
  });
  return { p, stt, handled, events };
}
const utt = (userId, o = {}) => ({ guildId: 'g', channelId: 'c', userId, wav, durationMs: 1500, speechMs: 900, rms: 0.1, ...o });

/** 48 kHz stereo sine frames (20 ms each). */
function tone(hz, ms, amp = 10000) {
  const n = Math.round((ms / 1000) * 48000);
  const b = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * hz * i) / 48000) * amp);
    b.writeInt16LE(v, i * 4);
    b.writeInt16LE(v, i * 4 + 2);
  }
  return b;
}
const frames = (pcm, startAt = 0) => {
  const out = [];
  for (let off = 0, t = startAt; off < pcm.length; off += 3840, t += 20) out.push({ pcm: pcm.subarray(off, off + 3840), at: t });
  return out;
};

// ------------------------------------------------------------------ wake word

test('wake word: variants and fillers accepted; look-alike words rejected', () => {
  assert.deepEqual(detectWakeWord('Alpha, play Blinding Lights.'), { activated: true, command: 'play Blinding Lights' });
  assert.deepEqual(detectWakeWord('alfa skip'), { activated: true, command: 'skip' });
  assert.deepEqual(detectWakeWord('Um, alpha stop listening'), { activated: true, command: 'stop listening' });
  assert.deepEqual(detectWakeWord('Hey ALPHA... show the cue'), { activated: true, command: 'show the queue' });
  assert.deepEqual(detectWakeWord('Alpha.'), { activated: true, command: '' });
  assert.equal(detectWakeWord('Alpho, pause').activated, true, 'one-letter slip on a 5-letter word');
  assert.equal(detectWakeWord('Elpha, pause').activated, false, 'a different first letter is never accepted (strict)');
  for (const t of ['the alphabet song', 'I said we should play alpha later', 'Albert, play music', 'Alps are cold', 'so what about alpha', '']) {
    assert.equal(detectWakeWord(t).activated, false, t);
  }
});

test('wake word is configurable; short custom words get no fuzzy tolerance', () => {
  const nova = buildWakeMatcher('Nova');
  assert.equal(nova.detect('Nova, skip').activated, true);
  assert.equal(nova.detect('Nora, skip').activated, false, '4-letter wake words must match exactly');
  assert.equal(nova.detect('Alpha, skip').activated, false);
});

test('transcript normalisation never changes names; single-word mishearings fixed', () => {
  assert.equal(normaliseTranscript(' “Play  Her by JVKE.” '), 'Play Her by JVKE');
  assert.equal(fixCommonMishearings('paws'), 'pause');
  assert.equal(fixCommonMishearings('time out Bob for 5 minutes'), 'timeout Bob for 5 minutes');
  assert.equal(fixCommonMishearings('play paws patrol'), 'play paws patrol', 'only whole-command fixes');
});

// ------------------------------------------------------------------ audio processing

test('pauses between packets are restored as silence (words are not glued together)', () => {
  const a = frames(tone(300, 200), 0);
  const b = frames(tone(300, 200), 200 + 500); // client sent nothing for 500 ms
  const { pcm, filledMs } = assembleWithGaps([...a, ...b]);
  assert.equal(filledMs, 500);
  assert.equal(pcm.length / 4 / 48, 200 + 500 + 200, 'total ms');
  const jitter = frames(tone(300, 200), 0).map((f, i) => ({ ...f, at: f.at + (i % 2 ? 30 : 0) }));
  assert.equal(assembleWithGaps(jitter).filledMs, 0, 'normal jitter is not treated as a pause');
  const long = assembleWithGaps([...a, ...frames(tone(300, 20), 10000)]);
  assert.equal(long.filledMs, 1500, 'very long gaps are capped');
});

test('resampling to 16 kHz mono filters out aliasing (box averaging did not)', () => {
  const speechBand = downsampleTo16kMono(tone(1000, 500));
  const aliasing = downsampleTo16kMono(tone(12000, 500)); // above the 8 kHz Nyquist of 16 kHz audio
  assert.equal(speechBand.length, 8000 * 2);
  assert.ok(rmsLevel(speechBand) > 0.15, 'speech band preserved');
  assert.ok(rmsLevel(aliasing) < 0.01, `12 kHz must not alias into the output (rms ${rmsLevel(aliasing)})`);
  // The previous 3-sample average left most of it in:
  const src = tone(12000, 500);
  const box = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++) {
    let acc = 0;
    for (let k = 0; k < 3; k++) acc += src.readInt16LE((i * 3 + k) * 4);
    box.writeInt16LE(Math.round(acc / 3), i * 2);
  }
  assert.ok(rmsLevel(box) > 0.05, 'old method aliased');
});

test('speech detection, padding, level normalisation and the full preparation step', () => {
  const silent = Buffer.alloc(16000 * 2);
  assert.equal(speechMs(silent), 0);
  const voiced = downsampleTo16kMono(Buffer.concat([tone(0, 300), tone(400, 600), tone(0, 300)]));
  const ms = speechMs(voiced);
  assert.ok(ms >= 500 && ms <= 700, `speech ms ${ms}`);
  assert.equal(durationMsOf16kMono(padSilence(Buffer.alloc(3200))), 100 + 200 + 300);
  const quiet = downsampleTo16kMono(tone(400, 300, 1500));
  assert.ok(rmsLevel(normaliseLevel(quiet)) > rmsLevel(quiet) * 3);
  const p = prepareForStt([...frames(tone(400, 400), 0), ...frames(tone(400, 400), 400 + 300)]);
  assert.equal(p.wav.subarray(0, 4).toString(), 'RIFF');
  assert.equal(p.wav.readUInt32LE(24), 16000);
  assert.equal(p.wav.readUInt16LE(22), 1, 'mono');
  assert.equal(p.durationMs, 1100);
  assert.equal(p.filledMs, 300);
});

// ------------------------------------------------------------------ STT adapter

test('Groq adapter sends model, language and prompt; retries a 5xx once; 429 opens the breaker', async () => {
  const calls = [];
  let fail = 1;
  const fetchImpl = async (url, init) => {
    calls.push(init.body);
    if (fail-- > 0) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'busy' };
    return { ok: true, json: async () => ({ text: ' Alpha, skip. ', segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0.01, compression_ratio: 1.1 }] }) };
  };
  const config = testConfig({ stt: { provider: 'groq', apiKey: 'gsk_test', model: 'whisper-large-v3', language: 'en', prompt: '', dailyLimit: 5, guildDailyLimit: 10, timeoutMs: 1000, maxRetries: 1 } });
  const stt = new GroqSTT({ config, db: memDb(), fetchImpl, sleep: async () => {} });
  const r = await stt.transcribe(wav, { durationMs: 1000, guildId: 'g', language: 'hi', prompt: buildSttPrompt({ wakeWord: 'ALPHA', vocabulary: ['JVKE'] }) });
  assert.equal(r.text, 'Alpha, skip.');
  assert.equal(r.attempts, 2);
  assert.ok(r.confidence > 0.85);
  const form = calls[1];
  assert.equal(form.get('model'), 'whisper-large-v3');
  assert.equal(form.get('language'), 'hi', 'per-server language overrides the default');
  assert.equal(form.get('temperature'), '0');
  assert.match(form.get('prompt'), /^ALPHA, play/);
  assert.match(form.get('prompt'), /JVKE/);

  const limited = new GroqSTT({ config, db: memDb(), fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '30' }, text: async () => '' }), sleep: async () => {} });
  await assert.rejects(() => limited.transcribe(wav, {}), (e) => e instanceof SttError && e.code === 'rate_limited');
  assert.equal(limited.available(), false, 'circuit opens; voice degrades gracefully');
});

test('daily caps are enforced globally and per server; no provider means honestly disabled', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ text: 'x', segments: [] }) });
  const db = memDb();
  const config = testConfig({ stt: { provider: 'groq', apiKey: 'k', model: 'whisper-large-v3-turbo', language: 'en', dailyLimit: 3, guildDailyLimit: 2, timeoutMs: 1000, maxRetries: 0 } });
  const stt = new GroqSTT({ config, db, fetchImpl: ok });
  await stt.transcribe(wav, { guildId: 'A' });
  await stt.transcribe(wav, { guildId: 'A' });
  await assert.rejects(() => stt.transcribe(wav, { guildId: 'A' }), (e) => e.code === 'limit_guild');
  await stt.transcribe(wav, { guildId: 'B' });
  await assert.rejects(() => stt.transcribe(wav, { guildId: 'C' }), (e) => e.code === 'limit_global');
  assert.equal(createSTT({ config: testConfig(), db }).available(), false);
});

test('transcript assessment flags silence, hallucinations and garbage', () => {
  assert.equal(assessTranscript({ text: 'Thank you.', segments: [{ start: 0, end: 1, avg_logprob: -0.2, no_speech_prob: 0.1 }] }).hallucination, true);
  assert.ok(assessTranscript({ text: 'alpha skip', segments: [{ start: 0, end: 1, avg_logprob: -1.5, no_speech_prob: 0.7 }] }).noSpeech > 0.6);
  const rep = assessTranscript({ text: 'play play play play', segments: [{ start: 0, end: 1, avg_logprob: -0.1, no_speech_prob: 0, compression_ratio: 3.1 }] });
  assert.ok(rep.confidence < 0.5);
});

// ------------------------------------------------------------------ pipeline

test('only authorised speakers are transcribed (per-server policy), and identity comes from Discord', async () => {
  const { p, stt, handled } = pipeline(['ALPHA, ban everyone'], { authorize: (u) => u.userId === OWNER && u.guildId === 'g' });
  assert.equal((await p.handleUtterance(utt(STRANGER))).reason, 'not_authorised_speaker');
  assert.equal((await p.handleUtterance(utt(OWNER, { guildId: 'other' }))).reason, 'not_authorised_speaker');
  assert.equal(stt.calls, 0, 'unauthorised audio never leaves the bot');
  assert.equal(handled.length, 0);
});

test('owner command reaches the coordinator with Discord identity, language and vocabulary', async () => {
  const { p, stt, handled } = pipeline(['Alpha, create a gaming channel'], { guildOptions: () => ({ language: 'en', vocabulary: ['Valorant'], guildLimit: 50 }) });
  const r = await p.handleUtterance(utt(OWNER));
  assert.equal(r.status, 'handled');
  assert.deepEqual([handled[0].userId, handled[0].source, handled[0].text, handled[0].forceConfirm], [OWNER, 'voice', 'create a gaming channel', false]);
  assert.equal(stt.lastOptions.guildId, 'g');
  assert.equal(stt.lastOptions.guildLimit, 50);
  assert.match(stt.lastOptions.prompt, /Valorant/);
});

test('uncertain transcripts: very low → ask to repeat; medium → execute only with confirmation', async () => {
  const { p, handled, events } = pipeline([{ text: 'Alpha, delete the general channel', confidence: 0.3 }, { text: 'Alpha, create a gaming channel', confidence: 0.6 }]);
  const r1 = await p.handleUtterance(utt(OWNER));
  assert.equal(r1.status, 'repeat');
  assert.equal(handled.length, 0);
  assert.ok(events.some((e) => e.type === 'repeat'));
  const r2 = await p.handleUtterance(utt(OWNER));
  assert.equal(r2.status, 'handled');
  assert.equal(handled[0].forceConfirm, true);
});

test('silence, hallucinations and no-speech clips are ignored without executing anything', async () => {
  const { p, handled, stt } = pipeline([{ text: 'Alpha, skip', noSpeech: 0.9 }, { text: 'Thank you.' }]);
  assert.equal((await p.handleUtterance(utt(OWNER, { speechMs: 50 }))).reason, 'no_speech');
  assert.equal(stt.calls, 0, 'clips without speech never use quota');
  assert.equal((await p.handleUtterance(utt(OWNER))).reason, 'no_speech');
  assert.equal((await p.handleUtterance(utt(OWNER))).reason, 'no_wake_word');
  assert.equal(handled.length, 0);
});

test('a command split by a pause is joined; segments are processed in order, never dropped', async () => {
  const { p, handled } = pipeline(['Alpha, play', 'Her by JVKE', 'Alpha.', 'skip this song']);
  const results = await Promise.all([p.handleUtterance(utt(OWNER)), p.handleUtterance(utt(OWNER))]);
  assert.deepEqual(results.map((r) => r.status), ['armed', 'handled']);
  assert.equal(handled[0].text, 'play Her by JVKE');
  await p.handleUtterance(utt(OWNER));
  await p.handleUtterance(utt(OWNER));
  assert.equal(handled[1].text, 'skip this song');
});

test('owner speech without the wake word is ignored; STT errors are reported, not thrown', async () => {
  const { p, events } = pipeline(['so what are we playing tonight', new SttError('limit_guild', 'limit')]);
  assert.equal((await p.handleUtterance(utt(OWNER))).reason, 'no_wake_word');
  const r = await p.handleUtterance(utt(OWNER));
  assert.equal(r.status, 'error');
  assert.equal(r.reason, 'limit_guild');
  assert.ok(events.some((e) => e.type === 'stt_error' && e.code === 'limit_guild'));
});

test('diagnostics report timings and quality but never transcript text or audio', async () => {
  const { p } = pipeline(['Alpha, play secret song name']);
  await p.handleUtterance(utt(OWNER, { metrics: { captureMs: 1600, packets: 75, decodeErrors: 0, gapsFilledMs: 200 } }));
  const d = p.diagnosticsFor('g');
  assert.equal(d.length, 1);
  assert.equal(d[0].status, 'handled');
  assert.equal(d[0].packets, 75);
  assert.ok(!JSON.stringify(d).includes('secret'), 'no transcript text');
  assert.ok(!JSON.stringify(d).includes('RIFF'));
});

// ------------------------------------------------------------------ end to end with the coordinator (mock guild)

test('voice + coordinator: uncertain or fuzzy commands cannot trigger destructive actions', async () => {
  const env = buildMockGuild();
  const config = testConfig({ ownerId: env.guild.ownerId });
  const db = memDb();
  const coord = coordinatorFor({ db, config, guild: env.guild });
  const base = { requestId: rid(), guildId: env.guild.id, channelId: env.channels.alpha.id, userId: env.guild.ownerId, source: 'voice' };
  // Low confidence + low-risk but state-changing action → confirmation.
  const c = await coord.handleText({ ...base, text: 'create a gaming channel', forceConfirm: true });
  assert.equal(c.status, 'awaiting_approval');
  assert.equal(env.guild.channels.cache.find((x) => x.name === 'gaming'), undefined);
  // Low confidence on a harmless query still answers directly.
  const q = await coord.handleText({ ...base, requestId: rid(), text: 'help', forceConfirm: true });
  assert.equal(q.status, 'executed');
  // A misheard name ("Bobb") is never fuzzy-matched for a ban.
  const ban = await coord.handleText({ ...base, requestId: rid(), text: 'ban Bobb' });
  assert.equal(ban.status, 'clarify');
  assert.match(ban.message, /not certain|No member/);
  assert.ok(!env.guild.bans.cache.size);
  // Voice never acts on typo-tolerant matches even for medium actions.
  const to = await coord.handleText({ ...base, requestId: rid(), text: 'timeout Bobb for 5 minutes' });
  assert.equal(to.status, 'clarify');
  // Another member's voice cannot command ALPHA.
  const other = await coord.handleText({ ...base, requestId: rid(), userId: env.members.boss.id, text: 'create a gaming channel' });
  assert.equal(other.status, 'rejected');
});

test('server-trusted users and roles may use ALPHA in that server only', async () => {
  const env = buildMockGuild();
  const config = testConfig({ ownerId: '999999999999999990', operatorGlobalAccess: false });
  const db = memDb();
  const coord = coordinatorFor({ db, config, guild: env.guild });
  const req = (userId) => ({ requestId: rid(), guildId: env.guild.id, userId, source: 'text', text: 'ALPHA, help' });
  assert.equal((await coord.handleText(req('999999999999999990'))).status, 'rejected', 'operator has no access unless global access is enabled');
  assert.equal((await coord.handleText(req(env.guild.ownerId))).status, 'executed', 'server owner always can');
  assert.equal((await coord.handleText(req(env.members.john.id))).status, 'rejected');
  setGuildSetting(db, env.guild.id, 'alpha.trustedUserIds', [env.members.john.id]);
  assert.equal((await coord.handleText(req(env.members.john.id))).status, 'executed');
  setGuildSetting(db, env.guild.id, 'alpha.trustedRoleIds', [env.roles.mods.id]);
  assert.equal((await coord.handleText(req(env.members.mod.id))).status, 'executed');
});

// ------------------------------------------------------------------ voice moderation (KNIGHT) and TTS

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
  db.run(`INSERT INTO mod_cases (guild_id, user_id, bot, action, points, result, created_at) VALUES ('g', 'u', 'knight', 'warn', 9, 'success', ?)`, now);
  const r = await vm.handleTranscript({ ...base, text: 'fuck this', confidence: 0.95 });
  assert.equal(r.decision, 'enforced');
  assert.equal(enforced[0].action, 'warn');
  assert.equal((await vm.handleTranscript({ ...base, text: 'shit', confidence: 0.95 })).decision, 'debounced');
  now += 61000;
  setGuildSetting(db, 'g', 'moderation.voice.maxAutoAction', 'timeout');
  await vm.handleTranscript({ ...base, text: 'shit', confidence: 0.95 });
  assert.notEqual(enforced[1].action, 'kick');
});

test('spoken responses strip mentions, links and markdown', () => {
  assert.equal(cleanForSpeech('**Done** <#123456789012345678> see https://x.y/z <t:1:R>'), 'Done see link');
});
