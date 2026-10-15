// Online music providers behind one interface (search / resolve link /
// stream input / metadata). Only sources whose terms permit this use are
// streamed; nothing is downloaded or stored on the host — ffmpeg reads the
// provider's stream directly into the voice connection.
//
//   audius   Audius public API (no key). Tracks are licensed to third-party
//            apps under the Audius Open Music License (public performance and
//            streaming); artists can opt out, and gated tracks are skipped.
//   jamendo  Jamendo API (free client_id, non-commercial). Creative Commons.
//   openverse Openverse API (no key; optional free credentials). Openly licensed
//            full tracks from Jamendo, Wikimedia Commons and ccMixter.
//   archive  Internet Archive recordings with an explicit CC / public-domain licence.
//   radio    radio-browser.info stations (opt-in; station terms apply).
//   url      direct https audio files and .m3u/.pls playlists supplied by admins.
//   local    optional folder on the host (never required).
//
// Apple's iTunes Search API identifies songs (METADATA ONLY, never played).
//
// YouTube / Spotify / SoundCloud links are accepted for METADATA ONLY: the
// title is looked up through their public oEmbed endpoints and then searched
// on the lawful providers above. Their audio is never extracted: YouTube's
// developer policies forbid separating audio from video or background play,
// and Spotify/SoundCloud do not license rebroadcasting.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import { fuzzyFind, normName } from '../../core/discord/resolve.js';

export class MusicError extends Error {
  /** @param {'not_found'|'unavailable'|'restricted'|'invalid_link'|'unsupported'|'rate_limited'|'outage'|'busy'|'config'} code */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const UA = 'SoulSocietyGuardians/1.0 (Discord bot)';
const AUDIUS = 'https://api.audius.co/v1';
const JAMENDO = 'https://api.jamendo.com/v3.0';
const AUDIO_EXT = new Set(['.mp3', '.ogg', '.opus', '.flac', '.wav', '.m4a', '.webm', '.aac']);
const MAX_PLAYLIST = 100;

async function http(url, { fetchImpl = fetch, timeoutMs = 8000, json = true, method = 'GET', maxBytes = 2 * 1024 * 1024 } = {}) {
  let res;
  try {
    res = await fetchImpl(url, { method, headers: { 'User-Agent': UA, Accept: json ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  } catch (err) {
    throw new MusicError('outage', `The music provider did not respond (${err.name === 'TimeoutError' ? 'timeout' : 'network error'}).`);
  }
  if (res.status === 429) throw new MusicError('rate_limited', 'The music provider is rate limiting requests; try again in a minute.');
  if (res.status === 404) throw new MusicError('not_found', 'That track or playlist was not found.');
  if (res.status === 401 || res.status === 403) throw new MusicError('restricted', 'That content is private or restricted.');
  if (res.status >= 500) throw new MusicError('outage', `The music provider is having problems (HTTP ${res.status}).`);
  if (!res.ok) throw new MusicError('unavailable', `The music provider refused the request (HTTP ${res.status}).`);
  if (method === 'HEAD') return res;
  if (!json) {
    const text = await res.text();
    if (text.length > maxBytes) throw new MusicError('invalid_link', 'That playlist file is too large.');
    return text;
  }
  return res.json();
}

const words = (s) => new Set(normWords(s));
function normWords(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** 0..100 match of a query against "title artist". */
export function matchScore(query, track) {
  const q = words(query);
  if (!q.size) return 0;
  const hay = words(`${track.title} ${track.artist ?? ''}`);
  let hit = 0;
  for (const w of q) if (hay.has(w)) hit++;
  let score = (hit / q.size) * 80;
  if (normName(track.title) === normName(query)) score += 20;
  else if (normName(`${track.title}${track.artist ?? ''}`).includes(normName(query))) score += 10;
  return Math.min(100, Math.round(score));
}

// ------------------------------------------------------------------ "same recording" matching for /play

// Words that carry no identity ("Slow Motion from Bharat", "Her by JVKE").
const FILLER = new Set(['the', 'a', 'an', 'of', 'from', 'by', 'feat', 'ft', 'featuring', 'and', 'with', 'x', 'song', 'track', 'music', 'official', 'audio', 'video', 'lyrics', 'lyric', 'full', 'hd', 'movie', 'film']);
// Versions that are a different recording unless the user asked for them.
const DERIVATIVE = /\b(cover|covers|covered|remix|rmx|remixed|slowed|reverb|sped\s*up|nightcore|8d|karaoke|instrumental|mashup|bootleg|tribute|parody|type\s*beat|lo-?fi\s*(?:version|flip|remix)|acoustic|unplugged|live\s+(?:at|from|in|version|session))\b|([([](?:lo-?fi|live)[)\]])/i;
const significant = (s) => normWords(s).filter((w) => !FILLER.has(w));

function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * How well a track is the recording the user asked for.
 * - every meaningful query word must appear in the title/artist (typos of
 *   one letter and joined spellings like "lofi"/"lo-fi" are tolerated);
 * - most of the title (without bracketed parts) must be accounted for by the
 *   query or the artist name, so "Slow Motion Dreams in Paris" ≠ "Slow Motion";
 * - covers/remixes/slowed/live versions only match when the query asks for them.
 * @returns {{suitable:boolean, coverage:number, titleCoverage:number, derivative:boolean}}
 */
export function matchQuality(query, track) {
  const q = [...new Set(significant(query))];
  if (!q.length) return { suitable: false, coverage: 0, titleCoverage: 0, derivative: false };
  const title = String(track.title ?? '');
  const artist = String(track.artist ?? '');
  const list = normWords(`${title} ${artist}`);
  const hay = new Set(list);
  // Joined spellings at word boundaries only ("lo-fi" = "lofi"), never inside a word ("her" ≠ "Herdem").
  for (let i = 0; i < list.length - 1; i++) {
    hay.add(list[i] + list[i + 1]);
    if (i < list.length - 2) hay.add(list[i] + list[i + 1] + list[i + 2]);
  }
  const found = (w) => hay.has(w) || (w.length >= 5 && [...hay].some((h) => h.length >= 4 && editDistanceAtMost1(w, h)));
  const coverage = q.filter(found).length / q.length;
  const core = significant(title.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\b(?:feat|ft)\.?\s.*$/i, ' '));
  const known = new Set([...q, ...normWords(artist)]);
  const titleCoverage = core.length ? core.filter((w) => known.has(w) || [...known].some((k) => k.length >= 5 && editDistanceAtMost1(w, k))).length / core.length : 0;
  const m = DERIVATIVE.exec(title);
  const derivative = Boolean(m) && !normName(query).includes(normName((m[1] ?? m[2]).split(/\s+/)[0]));
  return { suitable: coverage === 1 && titleCoverage >= 0.5 && !derivative, coverage, titleCoverage, derivative };
}

/**
 * Split search results into tracks that are the requested recording (best
 * first) and other playable results that are only alternatives.
 */
export function rankForPlay(query, results) {
  const suitable = [];
  const alternatives = [];
  const qName = normName(significant(query).join(' '));
  for (const t of results) {
    const mq = matchQuality(query, t);
    if (mq.suitable) {
      const core = normName(significant(String(t.title).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')).join(' '));
      const exactTitle = core && (core === qName || qName.startsWith(core) || qName.endsWith(core));
      suitable.push({ t, rank: (t.score ?? 0) + mq.titleCoverage * 20 + (exactTitle ? 15 : 0) });
    } else if (mq.coverage >= 0.5) alternatives.push(t);
  }
  suitable.sort((a, b) => b.rank - a.rank);
  return { suitable: suitable.map((s) => s.t), alternatives };
}

// ------------------------------------------------------------------ Audius

const audiusTrack = (t, appName) => ({
  provider: 'audius',
  id: t.id,
  title: t.title,
  artist: t.user?.name ?? null,
  durationMs: (t.duration ?? 0) * 1000,
  page: t.permalink ? `https://audius.co${t.permalink}` : null,
  artwork: t.artwork?.['480x480'] ?? null,
  license: 'Audius Open Music License',
  plays: t.play_count ?? 0,
  input: `${AUDIUS}/tracks/${encodeURIComponent(t.id)}/stream?app_name=${encodeURIComponent(appName)}`,
});
// Uploads named after YouTube-ripping tools are almost certainly re-uploads of
// someone else's recording; never offer them as playable.
const RIPPED_UPLOAD = /\b(y2mate|yt1s|ytmp3|savefrom|ssyoutube|flvto|mp3juices|onlymp3|youtube\s*to\s*mp3)\b/i;
export const looksRipped = (t) => RIPPED_UPLOAD.test(`${t.title ?? ''} ${t.description ?? ''}`);
const audiusPlayable = (t) => Boolean(t) && !looksRipped(t) && !t.is_delete && t.is_available !== false && t.is_streamable !== false && !t.is_stream_gated && t.access?.stream !== false && !t.stream_conditions;

export const audius = {
  id: 'audius',
  name: 'Audius',
  enabled: (config) => config.music.providers.includes('audius'),
  async search(query, { config, fetchImpl, limit = 6 }) {
    const app = config.music.audiusAppName;
    const data = await http(`${AUDIUS}/tracks/search?query=${encodeURIComponent(query)}&limit=${limit * 2}&app_name=${encodeURIComponent(app)}`, { fetchImpl });
    return (data.data ?? []).filter(audiusPlayable).slice(0, limit).map((t) => audiusTrack(t, app));
  },
  handles: (u) => /(^|\.)audius\.co$/i.test(u.hostname),
  async resolve(u, { config, fetchImpl }) {
    const app = config.music.audiusAppName;
    const data = (await http(`${AUDIUS}/resolve?url=${encodeURIComponent(u.toString())}&app_name=${encodeURIComponent(app)}`, { fetchImpl })).data;
    if (!data) throw new MusicError('not_found', 'That Audius link could not be found.');
    if (data.playlist_name || data.is_album !== undefined && data.track_count !== undefined) {
      const list = await http(`${AUDIUS}/playlists/${encodeURIComponent(data.id)}/tracks?app_name=${encodeURIComponent(app)}`, { fetchImpl });
      const tracks = (list.data ?? []).filter(audiusPlayable).slice(0, MAX_PLAYLIST).map((t) => audiusTrack(t, app));
      if (!tracks.length) throw new MusicError('restricted', 'That playlist has no tracks that can be streamed.');
      return { tracks, playlist: data.playlist_name ?? 'Audius playlist' };
    }
    if (!audiusPlayable(data)) throw new MusicError('restricted', 'That Audius track is gated or not available for streaming.');
    return { tracks: [audiusTrack(data, app)] };
  },
};

// ------------------------------------------------------------------ Jamendo

const jamendoTrack = (t) => ({
  provider: 'jamendo',
  id: String(t.id),
  canonical: `jamendo:${t.id}`,
  title: t.name,
  artist: t.artist_name ?? null,
  durationMs: (Number(t.duration) || 0) * 1000,
  page: t.shareurl ?? `https://www.jamendo.com/track/${t.id}`,
  artwork: t.image ?? null,
  license: t.license_ccurl ? `Creative Commons (${t.license_ccurl})` : 'Creative Commons',
  input: t.audio,
});

export const jamendo = {
  id: 'jamendo',
  name: 'Jamendo',
  enabled: (config) => config.music.providers.includes('jamendo') && Boolean(config.music.jamendoClientId),
  async search(query, { config, fetchImpl, limit = 6 }) {
    const data = await http(`${JAMENDO}/tracks/?client_id=${encodeURIComponent(config.music.jamendoClientId)}&format=json&limit=${limit}&search=${encodeURIComponent(query)}&audioformat=mp32&include=licenses`, { fetchImpl });
    if (data.headers?.status === 'failed') throw new MusicError('config', `Jamendo rejected the request: ${data.headers.error_message ?? 'check JAMENDO_CLIENT_ID'}`);
    return (data.results ?? []).filter((t) => t.audio).map(jamendoTrack);
  },
  handles: (u) => /(^|\.)jamendo\.com$/i.test(u.hostname),
  async resolve(u, { config, fetchImpl }) {
    if (!config.music.jamendoClientId) throw new MusicError('config', 'Jamendo links need JAMENDO_CLIENT_ID (free) on this deployment.');
    const m = /\/(track|album|playlist)\/(\d+)/.exec(u.pathname);
    if (!m) throw new MusicError('invalid_link', 'That Jamendo link is not a track, album or playlist.');
    const id = encodeURIComponent(config.music.jamendoClientId);
    const url =
      m[1] === 'track'
        ? `${JAMENDO}/tracks/?client_id=${id}&format=json&id=${m[2]}&audioformat=mp32`
        : m[1] === 'album'
          ? `${JAMENDO}/tracks/?client_id=${id}&format=json&album_id=${m[2]}&limit=${MAX_PLAYLIST}&audioformat=mp32&order=position`
          : `${JAMENDO}/playlists/tracks/?client_id=${id}&format=json&id=${m[2]}&limit=${MAX_PLAYLIST}&audioformat=mp32`;
    const data = await http(url, { fetchImpl });
    const raw = m[1] === 'playlist' ? data.results?.[0]?.tracks ?? [] : data.results ?? [];
    const tracks = raw.filter((t) => t.audio).map(jamendoTrack);
    if (!tracks.length) throw new MusicError('not_found', 'Nothing playable was found at that Jamendo link.');
    return { tracks, playlist: m[1] === 'track' ? undefined : data.results?.[0]?.name ?? `Jamendo ${m[1]}` };
  },
};

// ------------------------------------------------------------------ Openverse (Creative Commons audio)

// Openverse (by WordPress.org) indexes openly licensed audio and returns the
// original file URL. Only sources that serve full tracks are used: Jamendo
// (full-length MP3s), Wikimedia Commons and ccMixter. Freesound is excluded
// (mostly sound effects, served as "preview" renditions). Every result carries
// a Creative Commons licence; title, creator and licence are shown when played.
const OPENVERSE = 'https://api.openverse.org/v1';
const OPENVERSE_SOURCES = ['jamendo', 'wikimedia_audio', 'ccmixter'];
const OPENVERSE_SOURCE_LABEL = { jamendo: 'Jamendo', wikimedia_audio: 'Wikimedia Commons', ccmixter: 'ccMixter' };
const MIN_FULL_TRACK_MS = 30000;
const openverseCache = new Map(); // query -> { at, results } (anonymous use is limited to 200 searches/day)
let openverseToken = null; // { token, expires }

async function openverseAuth(config, fetchImpl) {
  const { openverseClientId: id, openverseClientSecret: secret } = config.music;
  if (!id || !secret) return {};
  if (openverseToken && openverseToken.expires > Date.now() + 60000) return { Authorization: `Bearer ${openverseToken.token}` };
  try {
    const res = await fetchImpl(`${OPENVERSE}/auth_tokens/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return {}; // fall back to anonymous access
    const j = await res.json();
    openverseToken = { token: j.access_token, expires: Date.now() + (Number(j.expires_in) || 3600) * 1000 };
    return { Authorization: `Bearer ${openverseToken.token}` };
  } catch {
    return {};
  }
}

/** Formats the built-in decoder can play; others need FFmpeg. */
async function decodableFiletypes() {
  const { detectFfmpeg } = await import('./audioEngine.js');
  return detectFfmpeg().available ? null : new Set(['mp3', 'mp32']);
}

export const openverse = {
  id: 'openverse',
  name: 'Openverse',
  enabled: (config) => config.music.providers.includes('openverse'),
  async search(query, { config, fetchImpl = fetch, limit = 6 }) {
    const key = query.trim().toLowerCase();
    const hit = openverseCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60000) return hit.results.map((t) => ({ ...t }));
    const url = `${OPENVERSE}/audio/?q=${encodeURIComponent(query)}&page_size=${Math.min(20, limit * 2)}&source=${OPENVERSE_SOURCES.join(',')}&mature=false`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...(await openverseAuth(config, fetchImpl)) }, signal: AbortSignal.timeout(12000) });
    } catch (err) {
      throw new MusicError('outage', `Openverse did not respond (${err.name === 'TimeoutError' ? 'timeout' : 'network error'}).`);
    }
    if (res.status === 429) throw new MusicError('rate_limited', 'Openverse search limit reached (anonymous: 200/day); add free OPENVERSE_CLIENT_ID/SECRET to raise it.');
    if (!res.ok) throw new MusicError(res.status >= 500 ? 'outage' : 'unavailable', `Openverse refused the search (HTTP ${res.status}).`);
    const data = await res.json();
    const decodable = await decodableFiletypes();
    const results = (data.results ?? [])
      .filter((r) => OPENVERSE_SOURCES.includes(r.source) && /^https:\/\//.test(r.url ?? '') && (r.duration ?? 0) >= MIN_FULL_TRACK_MS)
      .filter((r) => !decodable || decodable.has(String(r.filetype ?? '').toLowerCase()))
      .slice(0, limit)
      .map((r) => ({
        provider: 'openverse',
        source: r.source,
        id: r.id,
        // The same Jamendo track found directly and through Openverse is one track.
        canonical: r.source === 'jamendo' && /trackid=(\d+)/.exec(r.url) ? `jamendo:${/trackid=(\d+)/.exec(r.url)[1]}` : `openverse:${r.id}`,
        title: r.title,
        artist: r.creator ?? null,
        durationMs: r.duration,
        page: r.foreign_landing_url ?? null,
        license: `CC ${String(r.license ?? '').toUpperCase()} ${r.license_version ?? ''}`.trim(),
        input: r.url,
      }));
    openverseCache.set(key, { at: Date.now(), results });
    if (openverseCache.size > 200) openverseCache.delete(openverseCache.keys().next().value);
    return results.map((t) => ({ ...t }));
  },
};

// ------------------------------------------------------------------ Internet Archive

export async function searchArchive(query, { fetchImpl = fetch, limit = 6 } = {}) {
  const q = query.replace(/[():"]/g, ' ');
  const search = `(title:(${q}) OR creator:(${q})) AND mediatype:audio AND licenseurl:*`;
  const data = await http(`https://archive.org/advancedsearch.php?q=${encodeURIComponent(search)}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=${limit}&output=json&sort[]=downloads+desc`, { fetchImpl });
  return (data.response?.docs ?? [])
    .filter((d) => /creativecommons\.org|publicdomain/i.test(d.licenseurl ?? ''))
    .map((d) => ({
      provider: 'archive',
      id: d.identifier,
      identifier: d.identifier,
      title: Array.isArray(d.title) ? d.title[0] : d.title,
      artist: (Array.isArray(d.creator) ? d.creator[0] : d.creator) ?? null,
      page: `https://archive.org/details/${d.identifier}`,
      license: d.licenseurl,
    }));
}

/** Resolve an Internet Archive item to a playable file URL. */
export async function resolveArchiveStream(track, { fetchImpl = fetch } = {}) {
  const meta = await http(`https://archive.org/metadata/${encodeURIComponent(track.identifier)}`, { fetchImpl });
  const files = meta.files ?? [];
  // Multi-track items (albums): prefer the file whose title matches this track, MP3 first.
  const fileScore = (f) => matchScore(track.wanted ?? track.title ?? '', { title: f.title ?? f.name ?? '', artist: f.creator ?? '' });
  const best = (re) => files.filter((f) => re.test(f.format ?? '')).sort((a, b) => fileScore(b) - fileScore(a))[0];
  const pick = best(/VBR MP3|128Kbps MP3|MP3/i) ?? best(/Ogg Vorbis/i);
  if (!pick) throw new MusicError('unavailable', 'No playable audio file in that Internet Archive item.');
  return `https://archive.org/download/${encodeURIComponent(track.identifier)}/${pick.name.split('/').map(encodeURIComponent).join('/')}`;
}

export const archive = {
  id: 'archive',
  name: 'Internet Archive',
  enabled: (config) => config.music.providers.includes('archive') && config.music.enableArchive !== false,
  search: (query, { fetchImpl, limit }) => searchArchive(query, { fetchImpl, limit }),
  handles: (u) => /(^|\.)archive\.org$/i.test(u.hostname) && /^\/details\//.test(u.pathname),
  async resolve(u, { fetchImpl }) {
    const id = decodeURIComponent(u.pathname.split('/')[2] ?? '');
    const meta = await http(`https://archive.org/metadata/${encodeURIComponent(id)}`, { fetchImpl });
    const licence = meta.metadata?.licenseurl ?? '';
    if (!/creativecommons\.org|publicdomain/i.test(licence)) throw new MusicError('restricted', 'That Internet Archive item has no Creative Commons / public-domain licence, so it will not be streamed.');
    return { tracks: [{ provider: 'archive', id, identifier: id, title: meta.metadata?.title ?? id, artist: meta.metadata?.creator ?? null, page: `https://archive.org/details/${id}`, license: licence }] };
  },
};

// ------------------------------------------------------------------ radio

export const radio = {
  id: 'radio',
  name: 'Internet radio',
  enabled: (config) => config.music.providers.includes('radio') && config.music.enableRadio === true,
  async search(query, { fetchImpl, limit = 5 }) {
    const data = await http(`https://de1.api.radio-browser.info/json/stations/search?name=${encodeURIComponent(query)}&limit=${limit}&hidebroken=true&order=votes&reverse=true`, { fetchImpl });
    return data
      .filter((s) => /^https:\/\//.test(s.url_resolved || s.url))
      .map((s) => ({ provider: 'radio', id: s.stationuuid, title: s.name.trim(), artist: 'Live radio', input: s.url_resolved || s.url, page: s.homepage, live: true, license: 'Station stream (station terms apply)' }));
  },
};

// ------------------------------------------------------------------ local (optional)

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
        tracks.push({ provider: 'local', source: 'local', id: p, title: title.trim(), artist: artist?.trim() ?? null, input: p, license: 'Host-provided local file' });
      }
    }
  };
  if (dir && fs.existsSync(dir)) walk(dir, 0);
  libraryCache = { dir, at: Date.now(), tracks };
  return tracks;
}

export async function searchLocal(query, { dir }) {
  const r = fuzzyFind(scanLibrary(dir), query, (t) => [t.title, t.artist ? `${t.artist} ${t.title}` : t.title, t.artist ? `${t.title} ${t.artist}` : t.title]);
  return (r.candidates ?? []).slice(0, 5).map((t) => ({ ...t }));
}

export const local = {
  id: 'local',
  name: 'Local library',
  enabled: (config) => config.music.providers.includes('local') && fs.existsSync(config.music.localDir),
  search: (query, { config }) => searchLocal(query, { dir: config.music.localDir }),
};

// ------------------------------------------------------------------ links: safety, direct files, playlists

const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./];
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((re) => re.test(ip));
  const v6 = ip.toLowerCase();
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:') && isPrivateAddress(v6.slice(7));
}

const BLOCKED_PLAYBACK_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|spotify\.com|soundcloud\.com|deezer\.com|music\.apple\.com|tidal\.com)$/i;

/** Synchronous checks on a user-supplied URL (no network). */
export function validateDirectUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https links are allowed.' };
  if (u.username || u.password) return { ok: false, error: 'Links with credentials are not allowed.' };
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) || (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, '')))) {
    return { ok: false, error: 'Local/private network addresses are not allowed.' };
  }
  if (BLOCKED_PLAYBACK_HOSTS.test(u.hostname)) {
    return { ok: false, error: 'YouTube/Spotify/SoundCloud audio cannot be streamed lawfully by this bot.' };
  }
  return { ok: true, url: u.toString() };
}

/** DNS check: refuse hostnames that resolve to private addresses (SSRF protection). */
export async function assertPublicHost(hostname, lookup = dns.lookup) {
  const addrs = await lookup(hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw new MusicError('invalid_link', 'That host could not be resolved.');
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new MusicError('invalid_link', 'That link points to a private network address.');
}

export function parsePlaylistFile(text, base) {
  const out = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (/^\[playlist\]/i.test(lines[0] ?? '')) {
    for (const l of lines) {
      const m = /^File\d+=(.+)$/i.exec(l);
      if (m) out.push(m[1].trim());
    }
  } else {
    for (const l of lines) if (l && !l.startsWith('#')) out.push(l);
  }
  return out
    .map((e) => {
      try {
        return new URL(e, base).toString();
      } catch {
        return null;
      }
    })
    .filter((e) => e && validateDirectUrl(e).ok)
    .slice(0, MAX_PLAYLIST);
}

function directTrack(url, title) {
  const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'Audio');
  return { provider: 'url', id: url, title: title ?? name.replace(/\.[a-z0-9]+$/i, ''), artist: null, input: url, page: url, license: 'Provided by a server admin' };
}

export const directUrl = {
  id: 'url',
  name: 'Direct link',
  async resolve(u, { fetchImpl, lookup }) {
    await assertPublicHost(u.hostname, lookup);
    const ext = path.extname(u.pathname).toLowerCase();
    if (ext === '.m3u' || ext === '.pls' || ext === '.m3u8') {
      const text = await http(u.toString(), { fetchImpl, json: false, maxBytes: 256 * 1024 });
      if (/#EXT-X-TARGETDURATION/.test(text)) return { tracks: [{ ...directTrack(u.toString()), live: true }] }; // HLS stream
      const entries = parsePlaylistFile(text, u.toString());
      if (!entries.length) throw new MusicError('invalid_link', 'That playlist contains no playable https entries.');
      return { tracks: entries.map((e) => directTrack(e)), playlist: path.basename(u.pathname) };
    }
    if (!AUDIO_EXT.has(ext)) {
      const head = await http(u.toString(), { fetchImpl, method: 'HEAD' });
      const type = head.headers?.get?.('content-type') ?? '';
      if (!/^audio\/|^application\/ogg|mpegurl/i.test(type)) throw new MusicError('invalid_link', 'That link is not an audio file or supported playlist.');
    }
    return { tracks: [directTrack(u.toString())] };
  },
};

// ------------------------------------------------------------------ metadata-only links

/** Title of a YouTube / Spotify link via public oEmbed (no key, no audio). */
export async function linkTitle(u, { fetchImpl } = {}) {
  if (/(^|\.)(youtube\.com|youtu\.be)$/i.test(u.hostname)) {
    const d = await http(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(u.toString())}`, { fetchImpl });
    return { service: 'YouTube', title: cleanVideoTitle(d.title), raw: d.title };
  }
  if (/(^|\.)spotify\.com$/i.test(u.hostname)) {
    if (!/\/track\//.test(u.pathname)) throw new MusicError('unsupported', 'Spotify playlists/albums cannot be read without Spotify credentials, and Spotify audio cannot be rebroadcast. Paste a track link or search by name.');
    const d = await http(`https://open.spotify.com/oembed?url=${encodeURIComponent(u.toString())}`, { fetchImpl });
    return { service: 'Spotify', title: d.title, raw: d.title };
  }
  if (/(^|\.)soundcloud\.com$/i.test(u.hostname)) {
    const d = await http(`https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(u.toString())}`, { fetchImpl });
    return { service: 'SoundCloud', title: d.title?.replace(/ by .*$/, ''), raw: d.title };
  }
  return null;
}

export function cleanVideoTitle(t) {
  return String(t ?? '')
    .replace(/\((official|lyric|lyrics|audio|music|visualizer|video|hd|4k)[^)]*\)/gi, '')
    .replace(/\[(official|lyric|lyrics|audio|music|visualizer|video|hd|4k)[^\]]*\]/gi, '')
    .replace(/\b(official (music )?video|lyrics?|audio)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ------------------------------------------------------------------ registry

// ------------------------------------------------------------------ metadata-only catalogue

/**
 * Apple's iTunes Search API (free, no key): broad catalogue metadata so users
 * can see that a song exists. These results are NEVER played — Apple does not
 * license rebroadcasting its catalogue — they are shown as "metadata only"
 * with a link, next to playable alternatives.
 */
export const itunes = {
  id: 'itunes',
  name: 'Apple Music catalogue',
  enabled: (config) => config.music.metadataCatalog !== false,
  async search(query, { fetchImpl, limit = 10, country = 'US' }) {
    const data = await http(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&entity=song&limit=${limit}&country=${encodeURIComponent(country)}`, { fetchImpl });
    return (data.results ?? []).map((t) => ({
      provider: 'itunes',
      id: String(t.trackId),
      title: t.trackName,
      artist: t.artistName ?? null,
      durationMs: t.trackTimeMillis ?? 0,
      page: t.trackViewUrl ?? null,
      genre: t.primaryGenreName ?? null,
      playable: false,
      license: 'Metadata only — not licensed for bot playback',
    }));
  },
};

export const SEARCH_PROVIDERS = { audius, jamendo, openverse, archive, radio, local };
export const LINK_PROVIDERS = [audius, jamendo, archive];

export function enabledProviders(config) {
  return config.music.providers.map((id) => SEARCH_PROVIDERS[id]).filter((p) => p && p.enabled(config));
}

const WEIGHT = { local: 6, audius: 4, jamendo: 3, openverse: 3, archive: 0, radio: -5 };

/**
 * Search all enabled providers in parallel. Returns ranked candidates, the
 * providers that failed, and whether the choice is ambiguous.
 */
// Providers that can be slow for queries they have not seen recently.
const SLOW_PROVIDERS = new Set(['openverse']);

/**
 * Query providers in parallel. Once the fast ones have answered with a good
 * match, a slow provider gets only `graceMs` more; its request keeps running
 * and fills its cache for the next search instead of delaying this one.
 */
async function searchAll(providers, query, { config, fetchImpl, graceMs }) {
  const tasks = providers.map((p) => p.search(query, { config, fetchImpl, limit: 6 }));
  const fast = await Promise.allSettled(tasks.filter((_, i) => !SLOW_PROVIDERS.has(providers[i].id)));
  const good = fast.some((s) => s.status === 'fulfilled' && s.value.some((t) => matchScore(query, t) >= 60));
  const late = new MusicError('outage', 'did not answer in time');
  return Promise.all(
    tasks.map((task, i) => {
      const settle = task.then((value) => ({ status: 'fulfilled', value }), (reason) => ({ status: 'rejected', reason }));
      if (!SLOW_PROVIDERS.has(providers[i].id) || !good) return settle;
      let timer;
      const grace = new Promise((resolve) => (timer = setTimeout(() => resolve({ status: 'rejected', reason: late }), graceMs)));
      return Promise.race([settle, grace]).finally(() => clearTimeout(timer));
    }),
  );
}

export async function searchTracks(query, { config, fetchImpl = fetch, logger, limit = 5, withMetadata = false, graceMs = 3000 } = {}) {
  const providers = enabledProviders(config);
  const metaPromise = withMetadata && itunes.enabled(config) ? itunes.search(query, { fetchImpl, limit: 10, country: config.music.metadataCountry }).catch(() => []) : Promise.resolve([]);
  const settled = await searchAll(providers, query, { config, fetchImpl, graceMs });
  const results = [];
  const failed = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') results.push(...s.value);
    else {
      failed.push({ provider: providers[i].name, code: s.reason?.code ?? 'outage' });
      logger?.warn('music provider search failed', { provider: providers[i].id, code: s.reason?.code, err: s.reason?.message });
    }
  });
  for (const t of results) {
    t.playable = true;
    t.score = matchScore(query, t) + (WEIGHT[t.provider] ?? 0) + Math.min(5, Math.log10(1 + (t.plays ?? 0)));
  }
  results.sort((a, b) => b.score - a.score);
  const unique = dedupeTracks(results);
  const strong = unique.filter((t) => t.score >= 45);
  const top = strong[0];
  const ambiguous = Boolean(top && strong[1] && top.score < 95 && strong[1].score >= top.score - 8);
  const metadata = dedupeTracks((await metaPromise).filter((m) => matchScore(query, m) >= 45));
  return { results: strong.slice(0, limit), weak: unique.slice(0, limit), ambiguous, failed, metadata };
}

/**
 * Turn a pasted link into tracks. Metadata-only services are converted into
 * a search on lawful providers.
 * @returns {Promise<{tracks:object[], playlist?:string, note?:string}>}
 */
export async function resolveLink(raw, { config, fetchImpl = fetch, lookup, logger, allowDirect = false } = {}) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new MusicError('invalid_link', 'That is not a valid link.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new MusicError('invalid_link', 'Only web links are supported.');
  const meta = await linkTitle(u, { fetchImpl }).catch((err) => {
    if (err instanceof MusicError && err.code === 'unsupported') throw err;
    return null;
  });
  if (meta || BLOCKED_PLAYBACK_HOSTS.test(u.hostname)) {
    const title = meta?.title;
    const service = meta?.service ?? 'That service';
    const policy = `${service} audio cannot be streamed into Discord under its terms`;
    if (!title) throw new MusicError('restricted', `${policy}, and its title could not be read. Search by song name instead.`);
    const found = await searchTracks(cleanVideoTitle(title), { config, fetchImpl, logger, withMetadata: true, limit: 12 });
    const choice = choosePlayable(cleanVideoTitle(title), found);
    if (!choice.tracks.length) throw new MusicError('not_found', `${policy}, and "${title}" is not available from a source AEGIS may stream.`);
    return { tracks: [choice.tracks[0]], note: `${policy}; playing the same song from ${describeTrack(choice.tracks[0]).split(' · ').pop()} instead.` };
  }
  for (const p of LINK_PROVIDERS) if (p.handles(u)) {
    if (!p.enabled(config) && p.id !== 'jamendo') throw new MusicError('config', `${p.name} is disabled on this deployment.`);
    return p.resolve(u, { config, fetchImpl });
  }
  if (!allowDirect) throw new MusicError('restricted', 'Only server admins can play direct audio links.');
  const v = validateDirectUrl(u.toString());
  if (!v.ok) throw new MusicError('invalid_link', v.error);
  return directUrl.resolve(new URL(v.url), { fetchImpl, lookup });
}

// ------------------------------------------------------------------ de-duplication and the playable guard

/** Title without "(From "Film")", "(feat. …)", "(Official Audio)"-style parts. */
export function canonicalTitle(title) {
  return String(title ?? '')
    .replace(/[([](?:from|feat\.?|ft\.?|featuring|with|official|original|full|audio|video|lyrics?|hd)\b[^)\]]*[)\]]/gi, ' ')
    .replace(/\s+-\s+from\s+.*$/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const pageKey = (u) => {
  try {
    const x = new URL(u);
    return `${x.hostname.replace(/^www\./, '')}${x.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return null;
  }
};

/**
 * Remove duplicates (same provider id, same canonical source, same page URL,
 * or same normalised title + artist), keeping the first (best-ranked) copy.
 * Duplicates of a playable track are kept on it as `mirrors` so a failed
 * stream can fall back to the same recording from another provider.
 */
export function dedupeTracks(list) {
  const out = [];
  const byKey = new Map();
  for (const t of list) {
    const keys = [
      `id:${t.canonical ?? `${t.provider}:${t.id}`}`,
      t.page ? `page:${pageKey(t.page)}` : null,
      `ta:${normName(canonicalTitle(t.title))}|${normName(t.artist ?? '')}`,
    ].filter(Boolean);
    const first = keys.map((k) => byKey.get(k)).find(Boolean);
    if (first) {
      if (t.playable !== false && first.playable !== false && !keys.includes(`id:${first.canonical ?? `${first.provider}:${first.id}`}`)) (first.mirrors ??= []).push(t);
      for (const k of keys) if (!byKey.has(k)) byKey.set(k, first);
      continue;
    }
    for (const k of keys) byKey.set(k, t);
    out.push(t);
  }
  return out;
}

/** Can this track be put in the playable queue? Metadata-only results never can. */
export function isPlayableTrack(t) {
  if (!t || t.playable === false || t.provider === 'itunes') return false;
  if (t.provider === 'archive' || t.source === 'archive') return Boolean(t.identifier);
  return typeof t.input === 'string' && t.input.length > 0;
}

// ------------------------------------------------------------------ choosing what /play plays

const artistNames = (s) =>
  String(s ?? '')
    .toLowerCase()
    .split(/\s*(?:,|&|\band\b|\bx\b|\bfeat\.?|\bft\.?|\/)\s*/)
    .map((x) => x.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);

/** Do two artist credits share a name ("Shreya Ghoshal & Nakash Aziz" vs "Nakash Aziz")? */
export function sameArtist(a, b) {
  const bs = new Set(artistNames(b));
  return artistNames(a).some((x) => bs.has(x));
}

/** Is this exactly the requested title (ignoring the artist's name inside the title)? */
function isSameTitle(t, query) {
  const artistWords = new Set(normWords(t.artist ?? ''));
  const want = normName(significant(query).filter((w) => !artistWords.has(w)).join(' '));
  const strip = (s) => normName(significant(s).filter((w) => !artistWords.has(w)).join(' '));
  return Boolean(want) && (strip(t.title) === want || strip(String(t.title).replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')) === want);
}

// Mood/genre words: a query made only of these ("chill lofi", "bollywood
// romantic") asks for a kind of music, not one specific recording.
const GENERIC_WORDS = new Set('lofi lo fi chill chillhop beats beat jazz jazzhop hip hop hiphop rap study sleep sleeping relax relaxing relaxation ambient piano guitar mix playlist instrumental rain focus calm calming edm house techno trance trap phonk classical bollywood hindi punjabi tamil telugu indian desi romantic love sad happy workout gym party dance meditation yoga acoustic retro synthwave vaporwave rock metal pop indie folk jazzy soft night morning summer vibes'.split(' '));
const isGenericQuery = (q) => significant(q).length > 0 && significant(q).every((w) => GENERIC_WORDS.has(w));

/**
 * Decide what /play plays for a search, without asking the user anything.
 * - Only results that are the requested recording qualify (matchQuality).
 * - When Apple's catalogue knows songs with exactly this title, a same-titled
 *   upload only counts if it is by one of those credited artists — otherwise
 *   it is a different song that happens to share the name. (Classical works
 *   are exempt: any performance of the piece is the piece.)
 * @returns {{tracks:object[], identity:object|null, sameTitle:object[], alternatives:object[]}}
 *   tracks: best first, each with `alternates` (same recording) for fallback.
 */
export function choosePlayable(query, found) {
  const { suitable, alternatives } = rankForPlay(query, found.weak ?? found.results ?? []);
  const catalogue = (found.metadata ?? []).filter((m) => isSameTitle(m, query) && matchQuality(query, m).suitable);
  const identity = catalogue[0] ?? null;
  const restricted = identity && !isGenericQuery(query) && !catalogue.some((m) => /classical|opera/i.test(m.genre ?? ''));
  const credited = (t) => catalogue.some((m) => sameArtist(t.artist, m.artist));
  const sameTitle = [];
  let eligible = suitable;
  if (restricted) {
    // A known title: other artists' same-named songs are different songs, and
    // looser titles ("In Slow Motion" for "Slow Motion") must match closely.
    eligible = suitable.filter((t) => credited(t) || (!isSameTitle(t, query) && matchQuality(query, t).titleCoverage >= 0.75));
    sameTitle.push(...suitable.filter((t) => !eligible.includes(t)));
  }
  // Prefer an upload by a credited artist; then the ranking order.
  eligible = [...eligible.filter(credited), ...eligible.filter((t) => !credited(t))];
  const tracks = eligible.map((t, i) => ({ ...t, ...(t.provider === 'archive' ? { wanted: query } : {}), alternates: [...(t.mirrors ?? []), ...eligible.slice(i + 1)].filter(isPlayableTrack).slice(0, 2) }));
  // Name the catalogue's recordings of this title (up to two artists) — the
  // store's first hit is not always the famous one.
  const artists = [...new Set(catalogue.map((m) => m.artist).filter(Boolean))];
  const named = identity
    ? { ...identity, artist: `${artists.slice(0, 2).join(', ')}${artists.length > 2 ? ' and other catalogue artists' : ''}` }
    : (found.metadata ?? []).find((m) => matchQuality(query, m).suitable) ?? null;
  return { tracks, identity: tracks.length ? null : named, sameTitle, alternatives: [...sameTitle, ...alternatives.filter((a) => !sameTitle.includes(a))] };
}

/** Final input (URL or path) for the audio engine, resolved just before playback. */
export async function streamInput(track, { fetchImpl } = {}) {
  if (!isPlayableTrack(track)) throw new MusicError('unavailable', 'This result is metadata only and cannot be streamed.');
  if (track.provider === 'archive' || track.source === 'archive') return resolveArchiveStream(track, { fetchImpl });
  return track.input;
}

const PROVIDER_LABEL = { local: 'local library', audius: 'Audius', jamendo: 'Jamendo', archive: 'Internet Archive', radio: 'internet radio', url: 'direct link', itunes: 'Apple Music catalogue (metadata only)' };

export function formatMs(ms) {
  if (!ms) return 'live/unknown';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function describeTrack(t) {
  const label = `${t.title}${t.artist ? ` — ${t.artist}` : ''}`;
  const where = t.provider === 'openverse' ? `${OPENVERSE_SOURCE_LABEL[t.source] ?? t.source} via Openverse` : PROVIDER_LABEL[t.provider ?? t.source] ?? t.provider;
  return `${label} · ${where}${t.live ? ' (live)' : ''}`;
}

export function musicErrorMessage(err) {
  if (err instanceof MusicError) return err.message;
  return 'Something went wrong while loading that track.';
}
