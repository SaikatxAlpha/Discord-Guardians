// Lawful music sources.
//
// - local:   audio files in MUSIC_DIR supplied by the owner (who is responsible
//            for having the rights to play them to the server).
// - archive: Internet Archive recordings that carry an explicit license URL
//            (Creative Commons / Public Domain Mark).
// - radio:   internet radio stations listed by radio-browser.info (opt-in,
//            MUSIC_ENABLE_RADIO=true; station terms apply).
// - url:     a direct https audio URL supplied by an admin.
//
// YouTube is deliberately NOT supported: its Terms of Service prohibit
// downloading or re-streaming audio outside YouTube's own player, and there
// is no free official API that permits it.
import fs from 'node:fs';
import path from 'node:path';
import { fuzzyFind, normName } from '../../core/discord/resolve.js';

const AUDIO_EXT = new Set(['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.webm', '.aac']);

let libraryCache = { dir: null, at: 0, tracks: [] };

export function scanLibrary(dir, { maxFiles = 5000 } = {}) {
  if (libraryCache.dir === dir && Date.now() - libraryCache.at < 60000) return libraryCache.tracks;
  const tracks = [];
  const walk = (d, depth) => {
    if (depth > 4 || tracks.length >= maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (AUDIO_EXT.has(path.extname(e.name).toLowerCase())) {
        const base = path.basename(e.name, path.extname(e.name));
        const [artist, title] = base.includes(' - ') ? base.split(' - ', 2) : [null, base];
        tracks.push({ source: 'local', title: title.trim(), artist: artist?.trim() ?? null, input: p, license: 'Owner-provided local file' });
      }
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir, 0);
  libraryCache = { dir, at: Date.now(), tracks };
  return tracks;
}

export async function searchLocal(query, { dir }) {
  const lib = scanLibrary(dir);
  const r = fuzzyFind(lib, query, (t) => [t.title, t.artist ? `${t.artist} ${t.title}` : t.title, t.artist ? `${t.title} ${t.artist}` : t.title]);
  return (r.candidates ?? []).slice(0, 5).map((t, i) => ({ ...t, score: i === 0 && r.match ? r.score : 50 - i }));
}

async function getJson(url, fetchImpl, timeoutMs = 10000) {
  const res = await fetchImpl(url, { headers: { 'User-Agent': 'SoulSocietyBot/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function searchArchive(query, { fetchImpl = fetch } = {}) {
  const q = `(title:(${query.replace(/[():"]/g, ' ')}) OR creator:(${query.replace(/[():"]/g, ' ')})) AND mediatype:audio AND licenseurl:*`;
  const url = `https://archive.org/advancedsearch.php?q=${encodeURIComponent(q)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=6&output=json&sort[]=downloads+desc`;
  const data = await getJson(url, fetchImpl);
  const qn = normName(query);
  return (data.response?.docs ?? [])
    .filter((d) => /creativecommons\.org|publicdomain/i.test(d.licenseurl ?? ''))
    .map((d) => {
      const title = Array.isArray(d.title) ? d.title[0] : d.title;
      const artist = Array.isArray(d.creator) ? d.creator[0] : d.creator;
      const tn = normName(title);
      return {
        source: 'archive',
        title,
        artist: artist ?? null,
        identifier: d.identifier,
        page: `https://archive.org/details/${d.identifier}`,
        license: d.licenseurl,
        score: tn === qn ? 90 : tn.includes(qn) ? 70 : 40,
      };
    });
}

/** Resolve an Internet Archive item to a playable file URL. */
export async function resolveArchiveStream(track, { fetchImpl = fetch } = {}) {
  const meta = await getJson(`https://archive.org/metadata/${encodeURIComponent(track.identifier)}`, fetchImpl);
  const files = meta.files ?? [];
  const pick = files.find((f) => /VBR MP3|128Kbps MP3|MP3/i.test(f.format ?? '')) ?? files.find((f) => /Ogg Vorbis/i.test(f.format ?? ''));
  if (!pick) throw new Error('No playable audio file in that Internet Archive item.');
  return `https://archive.org/download/${encodeURIComponent(track.identifier)}/${pick.name.split('/').map(encodeURIComponent).join('/')}`;
}

export async function searchRadio(query, { fetchImpl = fetch } = {}) {
  const url = `https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(query)}&limit=5&hidebroken=true&order=votes&reverse=true`;
  const data = await getJson(url, fetchImpl);
  return data
    .filter((s) => /^https:\/\//.test(s.url_resolved || s.url))
    .map((s, i) => ({ source: 'radio', title: s.name.trim(), artist: 'Live radio', input: s.url_resolved || s.url, page: s.homepage, live: true, license: 'Station stream (station terms apply)', score: 45 - i }));
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[?::1\]?|\[?f[cd])/i;

export function validateDirectUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https audio URLs are allowed.' };
  if (PRIVATE_HOST.test(u.hostname)) return { ok: false, error: 'Local/private network addresses are not allowed.' };
  if (/(^|\.)(youtube\.com|youtu\.be|music\.youtube\.com|spotify\.com)$/i.test(u.hostname)) {
    return { ok: false, error: 'YouTube/Spotify links cannot be streamed lawfully by this bot. Use a direct audio file you have rights to.' };
  }
  return { ok: true, url: u.toString() };
}

/**
 * Search all enabled sources. Returns ranked candidates and whether the top
 * result is ambiguous (needs the user to pick).
 */
export async function searchTracks(query, { config, fetchImpl = fetch, logger } = {}) {
  const tasks = [searchLocal(query, { dir: config.music.localDir })];
  if (config.music.enableArchive) tasks.push(searchArchive(query, { fetchImpl }));
  if (config.music.enableRadio) tasks.push(searchRadio(query, { fetchImpl }));
  const settled = await Promise.allSettled(tasks);
  const results = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') results.push(...s.value);
    else logger?.warn('music source failed', { err: s.reason?.message });
  }
  // Prefer the owner's own library on ties.
  const weight = { local: 5, archive: 0, radio: -5 };
  results.sort((a, b) => b.score + weight[b.source] - (a.score + weight[a.source]));
  const top = results[0];
  const ambiguous = Boolean(top && results[1] && top.score < 90 && results[1].score >= top.score - 10);
  return { results: results.slice(0, 5), ambiguous };
}

export function describeTrack(t) {
  const label = `${t.title}${t.artist ? ` — ${t.artist}` : ''}`;
  const src = { local: 'local library', archive: 'Internet Archive', radio: 'internet radio', url: 'direct URL' }[t.source] ?? t.source;
  return `${label} · ${src}${t.live ? ' (live)' : ''}`;
}
