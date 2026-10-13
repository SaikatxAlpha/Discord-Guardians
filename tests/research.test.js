import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch, researchEmbed, dedupeAndRank, saveReport } from '../features/intelligence/research.js';
import { activityStats, recordMessageActivity } from '../features/intelligence/analytics.js';
import { GroqAI, NoAI } from '../ai/index.js';
import { memDb, testConfig } from './helpers.js';

const NOW = Date.parse('2026-10-13T10:00:00Z');

// MOCK HTTP responses for the free public endpoints.
function fakeFetch(failing = new Set()) {
  return async (url) => {
    const host = new URL(url).hostname;
    if (failing.has(host)) return { ok: false, status: 503, text: async () => 'down' };
    let body;
    if (host === 'hn.algolia.com') {
      body = { hits: [
        { objectID: '1', title: 'OpenModel releases new AI reasoning model', url: 'https://news.example.com/ai-model', created_at_i: (NOW - 3600000) / 1000, points: 320 },
        { objectID: '2', title: 'Ask HN: favourite AI tools?', url: null, created_at_i: (NOW - 7200000) / 1000, points: 12 },
        { objectID: '3', title: 'Old AI story', url: 'https://old.example.com', created_at_i: (NOW - 30 * 86400000) / 1000, points: 999 },
      ] };
    } else if (host === 'api.gdeltproject.org') {
      body = { articles: [{ url: 'https://wire.example.org/story', title: 'OpenModel releases a new AI reasoning model today', domain: 'wire.example.org', seendate: '20261013T081500Z' }] };
    } else if (host === 'en.wikipedia.org') {
      body = url.includes('/rest_v1/') ? { extract: 'Artificial intelligence is...', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Artificial_intelligence' } } } : { query: { search: [{ title: 'Artificial intelligence', snippet: 'AI' }] } };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
  };
}

test('research keeps original URLs, sources and timestamps; merges corroborating coverage', async () => {
  const r = await runResearch({ query: 'AI', timeframe: 'today', config: testConfig(), fetchImpl: fakeFetch(), now: NOW });
  assert.deepEqual(r.errors, []);
  const top = r.items[0];
  assert.equal(top.url, 'https://news.example.com/ai-model');
  assert.equal(top.publishedAt, NOW - 3600000);
  assert.equal(top.also[0].url, 'https://wire.example.org/story', 'GDELT duplicate merged as corroboration');
  assert.ok(!r.items.some((i) => i.title === 'Old AI story'), 'outside timeframe');
  assert.equal(r.items.find((i) => i.title.startsWith('Ask HN')).url, 'https://news.ycombinator.com/item?id=2');
  assert.equal(r.background.url, 'https://en.wikipedia.org/wiki/Artificial_intelligence');
  assert.equal(r.aiSummary, null, 'no AI configured → no synthesis');
});

test('unavailable sources are reported, never silently invented', async () => {
  const r = await runResearch({ query: 'AI', timeframe: 'today', config: testConfig(), fetchImpl: fakeFetch(new Set(['api.gdeltproject.org', 'hn.algolia.com'])), now: NOW });
  assert.deepEqual(r.errors.map((e) => e.source).sort(), ['GDELT', 'Hacker News']);
  assert.equal(r.items.length, 0);
  const e = researchEmbed(r);
  assert.match(e.description, /No matching items/);
  assert.match(e.fields.find((f) => f.name === 'Unavailable sources').value, /HTTP 503/);
});

test('embed links every item and labels AI synthesis as inference', async () => {
  const fakeAI = { available: () => true, summarize: async () => ['OpenModel shipped a reasoning model [1]'] };
  const r = await runResearch({ query: 'AI', timeframe: 'today', config: testConfig(), fetchImpl: fakeFetch(), now: NOW, ai: fakeAI });
  const e = researchEmbed(r);
  for (const it of r.items) assert.ok(e.description.includes(it.url));
  assert.match(e.fields[0].name, /inference/);
  assert.match(e.footer.text, /Retrieved 20\d\d-/);
  const db = memDb();
  saveReport(db, 'g', r);
  const row = db.get('SELECT * FROM research_reports');
  assert.equal(JSON.parse(row.sources)[0].url, r.items[0].url);
  assert.equal(row.ai_used, 1);
});

test('dedupe ignores invalid URLs', () => {
  const out = dedupeAndRank([{ title: 'x', url: 'javascript:alert(1)' }, { title: 'y', url: 'https://ok.example' }], { query: 'y', now: NOW, timeframe: 'any' });
  assert.deepEqual(out.map((i) => i.url), ['https://ok.example']);
});

test('activity analytics count messages without storing content', () => {
  const db = memDb();
  for (let i = 0; i < 5; i++) recordMessageActivity(db, { guildId: 'g', channelId: 'c1', userId: i % 2 ? 'a' : 'b', now: NOW, tz: 'Asia/Kolkata' });
  const s = activityStats(db, 'g', 'today', 'Asia/Kolkata', NOW);
  assert.equal(s.totals.messages, 5);
  assert.equal(s.totals.active, 2);
  assert.equal(s.topChannels[0].messages, 5);
  const cols = db.all(`PRAGMA table_info(activity)`).map((c) => c.name);
  assert.ok(!cols.includes('content'));
});

test('hosted AI: disabled gracefully, daily cap enforced, circuit breaker on 429', async () => {
  assert.equal(new NoAI().available(), false);
  const db = memDb();
  let calls = 0;
  const config = testConfig({ ai: { provider: 'groq', apiKey: 'gsk_x', model: 'llama-3.1-8b-instant', dailyLimit: 1, timeoutMs: 1000 } });
  const ok = new GroqAI({ config, db, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({ choices: [{ message: { content: '{"steps":[{"action":"music.skip","params":{}}]}' } }] }) }; } });
  assert.deepEqual(await ok.planCommand('skip it'), { steps: [{ action: 'music.skip', params: {} }] });
  assert.equal(await ok.planCommand('again'), null, 'daily limit reached → null, no paid fallback');
  assert.equal(calls, 1);
  const limited = new GroqAI({ config: { ...config, ai: { ...config.ai, dailyLimit: 50 } }, db: memDb(), fetchImpl: async () => ({ ok: false, status: 429, headers: { get: () => '60' }, text: async () => '' }) });
  assert.equal(await limited.planCommand('x'), null);
  assert.equal(limited.available(), false);
  const evil = new GroqAI({ config: { ...config, ai: { ...config.ai, dailyLimit: 50 } }, db: memDb(), fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"steps":[{"action":"system.exec","params":{"cmd":"format c:"}}]}' } }] }) }) });
  assert.equal(await evil.planCommand('x'), null, 'unknown actions rejected');
});
