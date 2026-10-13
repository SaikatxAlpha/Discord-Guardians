// Public-web research using free, key-less endpoints. Every item keeps its
// original URL, source and timestamp; nothing is invented. A deterministic
// digest is always produced; an AI synthesis (if enabled) is labelled as
// inference over the linked items.
import crypto from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });

const TIMEFRAME_MS = { today: 36 * 3600000, week: 7 * 86400000, any: 365 * 86400000 };

let lastGdelt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, { fetchImpl, userAgent, timeoutMs = 12000 }) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 80)}`);
  }
}

async function getText(url, { fetchImpl, userAgent, timeoutMs = 12000 }) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const stripHtml = (s) => String(s ?? '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
const domainOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
};

export const SOURCES = {
  async hackernews(query, { timeframe, now, ...http }) {
    const since = Math.floor((now - TIMEFRAME_MS[timeframe]) / 1000);
    const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=15&numericFilters=created_at_i>${since}`;
    const data = await getJson(url, http);
    return (data.hits ?? [])
      .filter((h) => h.title)
      .map((h) => ({
        title: stripHtml(h.title),
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
        source: h.url ? domainOf(h.url) : 'news.ycombinator.com',
        via: 'Hacker News',
        publishedAt: h.created_at_i * 1000,
        score: h.points ?? 0,
      }));
  },

  async gdelt(query, { timeframe, ...http }) {
    // GDELT asks for at most one request every 5 seconds.
    const wait = lastGdelt + 5200 - Date.now();
    if (wait > 0) await sleep(wait);
    lastGdelt = Date.now();
    const span = { today: '24h', week: '7d', any: '3months' }[timeframe];
    const q = /\s/.test(query) ? `"${query}"` : query;
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`${q} sourcelang:english`)}&mode=artlist&format=json&maxrecords=15&sort=hybridrel&timespan=${span}`;
    const data = await getJson(url, http);
    return (data.articles ?? []).map((a) => {
      const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(a.seendate ?? '');
      return {
        title: stripHtml(a.title),
        url: a.url,
        source: a.domain || domainOf(a.url),
        via: 'GDELT',
        publishedAt: m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null,
        score: 0,
      };
    });
  },

  async wikipedia(query, http) {
    const s = await getJson(`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1`, http);
    const hit = s.query?.search?.[0];
    if (!hit) return [];
    const sum = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`, http).catch(() => null);
    return [
      {
        title: hit.title,
        url: sum?.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
        source: 'en.wikipedia.org',
        via: 'Wikipedia',
        publishedAt: sum?.timestamp ? Date.parse(sum.timestamp) : null,
        snippet: (sum?.extract ?? stripHtml(hit.snippet)).slice(0, 500),
        background: true,
      },
    ];
  },

  async rss(query, { feedUrl, ...http }) {
    const doc = xml.parse(await getText(feedUrl, http));
    const items = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? [];
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    return (Array.isArray(items) ? items : [items])
      .map((it) => {
        const link = typeof it.link === 'string' ? it.link : it.link?.href ?? (Array.isArray(it.link) ? it.link[0]?.href : null);
        const title = stripHtml(typeof it.title === 'object' ? it.title['#text'] : it.title);
        return {
          title,
          url: link,
          source: typeof it.source === 'object' ? it.source['#text'] ?? domainOf(link) : domainOf(link),
          via: domainOf(feedUrl),
          publishedAt: Date.parse(it.pubDate ?? it.published ?? it.updated ?? '') || null,
          snippet: stripHtml(it.description ?? it.summary ?? '').slice(0, 300),
          score: 0,
        };
      })
      .filter((it) => it.title && it.url && terms.every((t) => `${it.title} ${it.snippet}`.toLowerCase().includes(t)));
  },
};

const words = (t) => new Set(t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
function similar(a, b) {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return false;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.7;
}

/** Merge near-duplicate headlines (corroboration across sources raises rank). */
export function dedupeAndRank(items, { query, now, timeframe }) {
  const cutoff = now - TIMEFRAME_MS[timeframe];
  const terms = [...words(query)];
  const groups = [];
  for (const it of items) {
    if (!it.title || !it.url || !/^https?:\/\//.test(it.url)) continue;
    if (it.publishedAt && it.publishedAt < cutoff) continue;
    const g = groups.find((x) => x.url === it.url || similar(x.title, it.title));
    if (g) {
      g.also.push({ source: it.source, url: it.url });
      g.score += 1;
    } else groups.push({ ...it, also: [] });
  }
  for (const g of groups) {
    const t = g.title.toLowerCase();
    const relevance = terms.filter((w) => t.includes(w)).length / Math.max(1, terms.length);
    const ageH = g.publishedAt ? (now - g.publishedAt) / 3600000 : 48;
    g.rank = relevance * 3 + g.also.length * 1.5 + Math.log10(1 + (g.score || 0)) - ageH / 48;
  }
  return groups.sort((a, b) => b.rank - a.rank);
}

/**
 * @returns {Promise<{id:string, query:string, timeframe:string, retrievedAt:number, items:object[], background:object|null, aiSummary:string[]|null, errors:{source:string,error:string}[]}>}
 */
export async function runResearch({ query, timeframe = 'today', maxItems = 6, config, ai = null, fetchImpl = fetch, now = Date.now(), sources }) {
  const http = { fetchImpl, userAgent: config.research.userAgent };
  const jobs = sources ?? [
    ['Hacker News', () => SOURCES.hackernews(query, { timeframe, now, ...http })],
    ['GDELT', () => SOURCES.gdelt(query, { timeframe, ...http })],
    ['Wikipedia', () => SOURCES.wikipedia(query, http)],
    ...config.research.rssFeeds.map((feedUrl) => [domainOf(feedUrl) ?? feedUrl, () => SOURCES.rss(query, { feedUrl, ...http })]),
    ...(config.research.enableGoogleNews
      ? [['Google News', () => SOURCES.rss(query, { feedUrl: `https://news.google.com/rss/search?q=${encodeURIComponent(query)}${timeframe === 'today' ? '+when:1d' : timeframe === 'week' ? '+when:7d' : ''}&hl=en-IN&gl=IN&ceid=IN:en`, ...http })]]
      : []),
  ];
  const settled = await Promise.allSettled(jobs.map(([, fn]) => fn()));
  const errors = [];
  const all = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') all.push(...r.value);
    else errors.push({ source: jobs[i][0], error: String(r.reason?.message ?? r.reason).slice(0, 160) });
  });
  const background = all.find((x) => x.background) ?? null;
  const items = dedupeAndRank(all.filter((x) => !x.background), { query, now, timeframe }).slice(0, maxItems);
  let aiSummary = null;
  if (ai?.available?.() && items.length >= 2) aiSummary = await ai.summarize(query, items).catch(() => null);
  return { id: crypto.randomUUID(), query, timeframe, retrievedAt: Date.now(), items, background, aiSummary, errors };
}

export function saveReport(db, guildId, report, { channelId = null, messageId = null } = {}) {
  db.run(
    `INSERT INTO research_reports (id, guild_id, query, summary, sources, ai_used, retrieved_at, channel_id, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    report.id,
    guildId,
    report.query,
    JSON.stringify(report.aiSummary ?? report.items.map((i) => i.title)),
    JSON.stringify(report.items.map((i) => ({ title: i.title, url: i.url, source: i.source, publishedAt: i.publishedAt }))),
    report.aiSummary ? 1 : 0,
    report.retrievedAt,
    channelId,
    messageId,
  );
}

/** Embed JSON for a research report (plain object so it can cross processes). */
export function researchEmbed(report, theme = { color: 0x22d3ee }) {
  const ts = (ms) => (ms ? `<t:${Math.floor(ms / 1000)}:R>` : 'date unknown');
  const lines = report.items.map((it, i) => {
    const also = it.also.length ? ` · also: ${[...new Set(it.also.map((a) => a.source))].slice(0, 3).join(', ')}` : '';
    return `**${i + 1}.** [${it.title.replace(/[[\]]/g, '').slice(0, 180)}](${it.url})\n   ${it.source ?? 'unknown'} via ${it.via} · ${ts(it.publishedAt)}${also}`;
  });
  const fields = [];
  if (report.aiSummary?.length) {
    fields.push({ name: '🧠 AI synthesis — inference from the items above; verify before relying on it', value: report.aiSummary.map((b) => `• ${b}`).join('\n').slice(0, 1024) });
  }
  if (report.background) {
    fields.push({ name: `📚 Background: ${report.background.title}`, value: `${report.background.snippet?.slice(0, 300) ?? ''}\n${report.background.url}`.slice(0, 1024) });
  }
  if (report.errors.length) fields.push({ name: 'Unavailable sources', value: report.errors.map((e) => `${e.source}: ${e.error}`).join('\n').slice(0, 1024) });
  return {
    title: `🛡️ Research: ${report.query}`.slice(0, 256),
    color: theme.color,
    description: (lines.length ? lines.join('\n') : 'No matching items were found for this timeframe.').slice(0, 4000),
    fields,
    footer: { text: `AEGIS • Retrieved ${new Date(report.retrievedAt).toISOString()} • ${report.items.length} sourced item(s) • timeframe: ${report.timeframe}` },
    timestamp: new Date(report.retrievedAt).toISOString(),
  };
}
