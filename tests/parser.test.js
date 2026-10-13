import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseWhen, stripWakeWord, normaliseNumbers } from '../core/intents/parser.js';
import { dayKey, nextOccurrence, parseDuration, zonedParts } from '../core/time.js';

const TZ = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-13T10:00:00Z'); // 15:30 IST, Tuesday
const p = (t) => parseCommand(t, { now: NOW, tz: TZ });
const one = (t) => {
  const r = p(t);
  assert.equal(r.steps.length, 1, `${t} → ${JSON.stringify(r)}`);
  return r.steps[0];
};

test('all example commands from the brief parse to the right structured actions', () => {
  assert.deepEqual(one("ALPHA, find today's AI news and post a summary in research."), { action: 'research.run', params: { query: 'AI news', timeframe: 'today', channel: 'research' } });
  assert.deepEqual(one('ALPHA, create a gaming channel.'), { action: 'channel.create', params: { name: 'gaming', type: 'text', template: 'public' } });
  assert.deepEqual(one('ALPHA, give the Gaming role access to that channel.'), { action: 'channel.permit', params: { target: 'Gaming', channel: '$last_channel', template: 'access' } });
  assert.deepEqual(one('ALPHA, play Blinding Lights.'), { action: 'music.play', params: { query: 'Blinding Lights' } });
  assert.deepEqual(one('ALPHA, timeout that member for five minutes.'), { action: 'mod.timeout', params: { member: '$last_member', durationMs: 300000 } });
  assert.deepEqual(one("ALPHA, give me today's server activity report."), { action: 'report.activity', params: { period: 'today' } });
  assert.deepEqual(one('ALPHA, stop listening.'), { action: 'voice.stop_listening', params: {} });
  for (const [t, a] of [['ALPHA, skip.', 'music.skip'], ['ALPHA, pause.', 'music.pause'], ['ALPHA, resume.', 'music.resume'], ['ALPHA, show the queue.', 'music.queue'], ['ALPHA, stop music.', 'music.stop']]) {
    assert.equal(one(t).action, a);
  }
});

test('channel, role and permission phrasing', () => {
  assert.deepEqual(one('deny the everyone role access to the private staff channel').params, { target: '@everyone', channel: 'staff', template: 'deny' });
  assert.deepEqual(one('create a Research role').params, { name: 'Research', template: 'none' });
  assert.deepEqual(one('assign the Research role to John').params, { role: 'Research', member: 'John' });
  assert.deepEqual(one('give John the Research role').params, { role: 'Research', member: 'John' });
  assert.deepEqual(one('create a read-only announcement channel').params, { name: 'announcements', type: 'text', template: 'readonly' });
  assert.deepEqual(one('create an event channel').params, { name: 'event', type: 'text', template: 'public' });
  assert.deepEqual(one('create a voice channel called Chill Lounge').params, { name: 'Chill Lounge', type: 'voice', template: 'public' });
  assert.deepEqual(one('create a private staff channel').params.template, 'private');
  assert.equal(one('give everyone with the Gamers role the Gaming role').action, 'role.assign'); // not bulk without "role to everyone"
  assert.equal(one('give the Gaming role to everyone with the Members role').action, 'role.bulk_assign');
  assert.deepEqual(one('make staff private').params, { channel: 'staff', target: '@everyone', template: 'deny' });
  assert.equal(one('delete the Research role').action, 'role.delete');
  assert.equal(one('delete the gaming channel').action, 'channel.delete');
});

test('moderation phrasing with durations and reasons', () => {
  assert.deepEqual(one('mute Tom for 1 hour').params, { member: 'Tom', durationMs: 3600000 });
  assert.deepEqual(one('timeout <@123456789012345678> for 10m because spam').params, { member: '<@123456789012345678>', durationMs: 600000, reason: 'spam' });
  assert.deepEqual(one('warn Bob for spamming links').params, { member: 'Bob', reason: 'spamming links' });
  assert.deepEqual(one('ban @spammer for raiding').params, { member: 'spammer', reason: 'raiding' });
  assert.equal(one('unban 123456789012345678').action, 'mod.unban');
  assert.deepEqual(one('lock general').params, { channel: 'general', enable: true });
  assert.deepEqual(one('unlock general').params, { channel: 'general', enable: false });
});

test('compound commands require every part to parse', () => {
  const r = p('create a gaming channel and give the Gaming role access to it');
  assert.deepEqual(r.steps.map((s) => s.action), ['channel.create', 'channel.permit']);
  const bad = p('create a gaming channel and do a barrel roll');
  assert.equal(bad.steps.length, 0);
  assert.match(bad.error, /barrel roll/);
  assert.deepEqual(p('create an Analysts role and give John the Analysts role').steps.map((s) => s.action), ['role.create', 'role.assign']);
  assert.deepEqual(p('create a gaming channel and give the Gaming role access to that channel').steps.map((s) => s.action), ['channel.create', 'channel.permit']);
  assert.deepEqual(p('warn Bob and kick Steve').steps.map((s) => [s.action, s.params.member]), [['mod.warn', 'Bob'], ['mod.kick', 'Steve']]);
  // Names containing "and" are not split.
  assert.deepEqual(one('play Rock and Roll').params, { query: 'Rock and Roll' });
  assert.equal(one('create a role called Black and White').params.name, 'Black and White');
  assert.equal(one('remind me to buy milk and eggs in 10 minutes').params.message, 'buy milk and eggs');
  assert.equal(one("find today's AI news and post a summary in research").action, 'research.run');
});

test('scheduling and time expressions', () => {
  const s = one('schedule an announcement in general saying Tournament starts soon tomorrow at 6pm');
  assert.equal(s.action, 'schedule.message');
  assert.equal(s.params.message, 'Tournament starts soon');
  const z = zonedParts(s.params.at, TZ);
  assert.deepEqual([z.day, z.hour, z.minute], [14, 18, 0]);
  assert.equal(one('remind me to stretch in 20 minutes').params.at, NOW + 20 * 60000);
  const ev = one('create an event called Valorant night tomorrow at 9pm');
  assert.equal(ev.params.name, 'Valorant night');
  assert.equal(zonedParts(ev.params.startsAt, TZ).hour, 21);
  assert.deepEqual(parseWhen('every day at 9am', NOW, TZ), { dailyTime: '09:00' });
  const sat = parseWhen('on saturday at 8pm', NOW, TZ);
  assert.equal(zonedParts(sat.at, TZ).weekday, 6);
  const at = parseWhen('at 14:00', NOW, TZ); // already passed today → tomorrow
  assert.equal(dayKey(at.at, TZ), '2026-10-14');
});

test('wake word handling and number words', () => {
  assert.deepEqual(stripWakeWord('Alpha, play music'), { matched: true, rest: 'play music' });
  assert.deepEqual(stripWakeWord('hey alfa skip'), { matched: true, rest: 'skip' });
  assert.equal(stripWakeWord('alphabet soup').matched, false);
  assert.equal(normaliseNumbers('for twenty five minutes'), 'for 25 minutes');
  assert.equal(normaliseNumbers('half an hour'), '30 minutes');
  assert.equal(parseDuration('1h30m'), 5400000);
});

test('unknown or unsafe instructions are not guessed', () => {
  for (const t of ['do a barrel roll', 'run rm -rf /', 'execute this javascript', 'get rid of the staff room']) {
    assert.equal(p(t).steps.length, 0, t);
  }
});

test('daily schedule next occurrence respects the time zone', () => {
  const next = nextOccurrence({ kind: 'daily', time: '21:00' }, NOW, TZ);
  assert.equal(new Date(next).toISOString(), '2026-10-13T15:30:00.000Z');
  const weekly = nextOccurrence({ kind: 'weekly', weekday: 0, time: '20:00' }, NOW, TZ);
  assert.equal(zonedParts(weekly, TZ).weekday, 0);
});
