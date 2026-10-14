// Deterministic intent parser: turns an ALPHA instruction into structured
// action steps without any AI model. Patterns are anchored so unrecognised
// trailing text never silently becomes part of a parameter.
import { parseDuration, zonedParts, zonedToUtc, parseHHMM } from '../time.js';

export const WAKE_WORD_RE = /^\s*(?:hey\s+|ok(?:ay)?\s+)?(?:alpha|alfa|alpa|elpha|alpha's|aalpha)\b[\s,.:;!-]*/i;

const NUMBER_WORDS = {
  zero: 0, one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, ninety: 90, hundred: 100,
};
const UNIT_WORDS = 'seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?';

/** "five minutes" -> "5 minutes", "twenty five" -> "25", "half an hour" -> "30 minutes" */
export function normaliseNumbers(text) {
  let out = text.replace(/\bhalf an? hour\b/gi, '30 minutes').replace(/\ban? hour and a half\b/gi, '90 minutes');
  out = out.replace(/\b(twenty|thirty|forty|fifty)[\s-](one|two|three|four|five|six|seven|eight|nine)\b/gi, (_, t, u) =>
    String(NUMBER_WORDS[t.toLowerCase()] + NUMBER_WORDS[u.toLowerCase()]),
  );
  out = out.replace(new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join('|')})\\s+(${UNIT_WORDS})\\b`, 'gi'), (_, n, u) => `${NUMBER_WORDS[n.toLowerCase()]} ${u}`);
  return out;
}

/** "40", "forty", "forty five", "a hundred" → number (0–999), else null. */
export function toNumber(text) {
  const t = String(text).trim().toLowerCase();
  if (/^\d{1,3}$/.test(t)) return +t;
  let total = 0;
  let any = false;
  for (const w of t.split(/[\s-]+/)) {
    if (w === 'and') continue;
    if (w === 'hundred') {
      total = (total || 1) * 100;
      any = true;
      continue;
    }
    const v = NUMBER_WORDS[w];
    if (v == null || w === 'a' || w === 'an') {
      if ((w === 'a' || w === 'an') && !any) continue;
      return null;
    }
    total += v;
    any = true;
  }
  return any ? total : null;
}

export function stripWakeWord(text) {
  const m = WAKE_WORD_RE.exec(text);
  return m ? { matched: true, rest: text.slice(m[0].length).trim() } : { matched: false, rest: text.trim() };
}

const FILLER = /^(?:please|kindly|can you|could you|would you|will you|i want you to|i need you to|go ahead and|now)\s+/i;

function clean(text) {
  let t = normaliseNumbers(String(text).replace(/\s+/g, ' ').trim()).replace(/[.!?]+$/, '');
  let prev;
  do {
    prev = t;
    t = t.replace(FILLER, '').replace(/\s+(?:please|for me|now)$/i, '');
  } while (t !== prev);
  return t.trim();
}

/** Normalise an entity reference; map pronouns to context tokens. */
export function entityRef(raw, kind) {
  let s = String(raw ?? '').trim();
  if (/^<[@#][&!]?\d{17,20}>$/.test(s)) return s; // Discord mention
  s = s.replace(/^(?:the|a|an|my|our)\s+/i, '').replace(/[.,!?]+$/, '');
  if (kind === 'channel') s = s.replace(/\s+(?:text |voice )?channel$/i, '').replace(/^#/, '');
  if (kind === 'role') s = s.replace(/\s+role$/i, '').replace(/^@/, '');
  if (kind === 'member') s = s.replace(/^@/, '');
  const lower = s.toLowerCase();
  if (kind === 'channel' && /^(?:that|this|it|there|the new one|same)(?: channel| one)?$/.test(lower)) return '$last_channel';
  if (kind === 'member' && /^(?:that|this|the)\s+(?:member|user|guy|person|one)$|^(?:him|her|them)$/.test(lower)) return '$last_member';
  if (kind === 'role' && /^(?:that|this|the new)(?: role)?$|^it$/.test(lower)) return '$last_role';
  if (kind === 'member' && /^(?:me|myself)$/.test(lower)) return '$self';
  if ((kind === 'role' || kind === 'target') && /^@?everyone$/.test(lower)) return '@everyone';
  return s;
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/**
 * Parse a time expression. Returns {at} (UTC ms), {dailyTime:'HH:MM'} or null.
 * Supports: in 10 minutes | at 6pm | at 18:30 | tomorrow (at 9am) | tonight |
 * on saturday at 8pm | every day at 9am | daily at 21:00
 */
export function parseWhen(text, now, tz) {
  const t = text.toLowerCase().trim();
  const clock = (s) => {
    const m = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\b/.exec(s);
    if (!m) return null;
    let hour = +m[1];
    const minute = m[2] ? +m[2] : 0;
    const ap = m[3]?.[0];
    if (ap === 'p' && hour < 12) hour += 12;
    if (ap === 'a' && hour === 12) hour = 0;
    if (!m[2] && !ap && hour < 7) hour += 12; // "at 6" in casual speech means evening
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
  };
  const daily = /\b(?:every ?day|daily|each day)\b(?:\s+at\s+(.+))?/.exec(t);
  if (daily) {
    const c = clock(daily[1] || '9:00') || parseHHMM(daily[1] || '');
    return c ? { dailyTime: `${String(c.hour).padStart(2, '0')}:${String(c.minute).padStart(2, '0')}` } : null;
  }
  const rel = /\bin\s+(\d+(?:\.\d+)?\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)(?:\s*(?:and\s*)?\d+\s*(?:minutes?|mins?|seconds?))?)\b/.exec(t);
  if (rel) {
    const ms = parseDuration(rel[1]);
    return ms ? { at: now + ms } : null;
  }
  const p = zonedParts(now, tz);
  const dateFor = (offsetDays, c) => {
    const base = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
    return zonedToUtc({ year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), ...c }, tz);
  };
  if (/\btomorrow\b/.test(t)) {
    const c = clock(t.replace(/.*tomorrow/, '')) || { hour: 9, minute: 0 };
    return { at: dateFor(1, c) };
  }
  if (/\btonight\b/.test(t)) {
    const c = clock(t.replace(/.*tonight/, '')) || { hour: 21, minute: 0 };
    if (c.hour < 12) c.hour += 12;
    return { at: dateFor(0, c) };
  }
  const wd = new RegExp(`\\b(?:on\\s+|next\\s+)?(${WEEKDAYS.join('|')})\\b`).exec(t);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]);
    let diff = (target - p.weekday + 7) % 7;
    const c = clock(t.slice(wd.index + wd[0].length)) || { hour: 19, minute: 0 };
    if (diff === 0 && dateFor(0, c) <= now) diff = 7;
    return { at: dateFor(diff, c) };
  }
  const at = /\bat\s+(.+)$/.exec(t);
  if (at) {
    const c = clock(at[1]);
    if (!c) return null;
    let ts = dateFor(0, c);
    if (ts <= now) ts = dateFor(1, c);
    return { at: ts };
  }
  return null;
}

/** Split "... at 6pm" / "... in 2 hours" / "... tomorrow" off the end of a phrase. */
function splitTrailingWhen(text) {
  const m = /\s+((?:in\s+\d|at\s+\d|tomorrow|tonight|every ?day|daily|on\s+(?:sun|mon|tue|wed|thu|fri|sat)|next\s+(?:sun|mon|tue|wed|thu|fri|sat))[^]*)$/i.exec(text);
  return m ? { head: text.slice(0, m.index).trim(), when: m[1] } : { head: text, when: null };
}

const step = (action, params) => ({ action, params });

const CHANNEL_MODIFIERS = {
  readonly: /\b(?:read[\s-]?only|announcement-only)\b/i,
  private: /\b(?:private|secret|hidden|staff-only)\b/i,
  voice: /\b(?:voice|vc)\b/i,
  category: /\bcategory\b/i,
  forum: /\bforum\b/i,
};

function parseChannelCreate(t) {
  const m = /^(?:create|make|add|set up|setup|open|build)\s+(?:a\s+|an\s+|the\s+|new\s+)*(.*?)\s*(?:channel|vc|category|forum)(?:\s+(?:called|named|for)\s+(.+))?$/i.exec(t);
  if (!m) return null;
  let descriptor = m[1] || '';
  let name = m[2] || '';
  let type = 'text';
  let template = 'public';
  if (CHANNEL_MODIFIERS.readonly.test(descriptor)) template = 'readonly';
  if (CHANNEL_MODIFIERS.private.test(descriptor)) template = 'private';
  if (/\bcategory\s*$/i.test(t) || CHANNEL_MODIFIERS.category.test(descriptor) || /^(?:create|make|add)\s+(?:a\s+)?(?:new\s+)?category/i.test(t)) type = 'category';
  else if (CHANNEL_MODIFIERS.forum.test(descriptor) || /\bforum(?:\s+(?:called|named)|$)/i.test(t)) type = 'forum';
  else if (CHANNEL_MODIFIERS.voice.test(descriptor) || /\bvc\b/i.test(t)) type = 'voice';
  descriptor = descriptor
    .replace(/\b(?:read[\s-]?only|private|secret|hidden|voice|vc|text|public|new|category|forum)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^announcements?$/i.test(descriptor) && !name) {
    name = 'announcements';
    if (template === 'public') template = 'readonly';
  }
  if (!name) name = descriptor;
  name = name.replace(/^(?:the|a|an)\s+/i, '').trim();
  if (!name) return null;
  if (type !== 'voice' && type !== 'category') name = name.toLowerCase().replace(/[^a-z0-9\s_-]/g, '').trim().replace(/\s+/g, '-');
  if (!name) return null;
  return [step('channel.create', { name, type, template })];
}

const MATCHERS = [
  // --- voice / system ---
  [/^(?:stop|end|quit|pause|cancel)\s+(?:listening|voice(?: mode)?|alpha)$|^go to sleep$|^(?:that'?s all|dismissed)$/i, () => [step('voice.stop_listening', {})]],
  [/^(?:system |bot )?(?:status|health(?: check)?)$|^are you (?:ok|alive|online)$/i, () => [step('system.status', {})]],
  [/^(?:help|what can you do|commands|show commands)$/i, () => [step('system.help', {})]],

  // --- music ---
  [/^(?:skip|next)(?:\s+(?:this|the)?\s*(?:song|track))?$/i, () => [step('music.skip', {})]],
  [/^pause(?:\s+(?:the\s+)?(?:music|song|track|playback))?$/i, () => [step('music.pause', {})]],
  [/^(?:resume|continue|unpause)(?:\s+(?:the\s+)?(?:music|song|track|playback))?$/i, () => [step('music.resume', {})]],
  [/^stop(?:\s+(?:the\s+)?(?:music|song|playback|playing))?$|^end\s+(?:the\s+)?music$/i, () => [step('music.stop', {})]],
  [/^(?:show|display|list|what'?s in|what is in)(?:\s+me)?\s+(?:the\s+)?(?:music\s+)?queue$|^queue$/i, () => [step('music.queue', {})]],
  [/^(?:what'?s|what is)\s+(?:playing|this song|the song)(?:\s+now)?$|^now playing$/i, () => [step('music.nowplaying', {})]],
  [
    /^(?:set\s+(?:the\s+)?)?volume\s+(?:to\s+|at\s+)?([a-z0-9][a-z0-9 -]{0,25}?)(?:\s*(?:%|percent))?$/i,
    (m) => {
      const n = toNumber(m[1]);
      return n == null ? null : [step('music.volume', { percent: Math.min(100, n) })];
    },
  ],
  [/^(?:turn\s+(?:it|the\s+(?:music|volume))\s+up|volume\s+up|louder)$/i, () => [step('music.volume', { change: 20 })]],
  [/^(?:turn\s+(?:it|the\s+(?:music|volume))\s+down|volume\s+down|quieter|softer)$/i, () => [step('music.volume', { change: -20 })]],
  [/^shuffle(?:\s+(?:the\s+)?(?:queue|playlist|music|songs))?$/i, () => [step('music.shuffle', {})]],
  [/^(?:leave|disconnect|get out)(?:\s+(?:from\s+|of\s+)?(?:the\s+)?(?:voice|vc|channel|voice channel|call))?$/i, () => [step('music.leave', {})]],
  [/^clear(?:\s+the)?\s+(?:queue|playlist|upcoming(?:\s+songs)?)$/i, () => [step('music.clear', {})]],
  [/^remove\s+(?:track|song|number)\s*#?(\d{1,3})(?:\s+from\s+the\s+queue)?$/i, (m) => [step('music.remove', { position: +m[1] })]],
  [/^(?:stop\s+looping|loop\s+off|disable\s+loop(?:ing)?|no\s+loop)$/i, () => [step('music.loop', { mode: 'off' })]],
  [/^(?:loop|repeat)(?:\s+(?:the\s+|this\s+)?(song|track|queue|playlist))?$/i, (m) => [step('music.loop', { mode: /queue|playlist/i.test(m[1] ?? '') ? 'queue' : 'track' })]],
  [/^play\s+(?:the\s+song\s+|me\s+)?(.+?)(?:\s+(?:song|music))?$/i, (m) => [step('music.play', { query: m[1] })]],

  // --- research ---
  [
    /^(find|search(?: for)?|look up|research|get|fetch|gather|check|summari[sz]e)(?:\s+me)?\s+(.+?)(?:\s+and\s+(?:post|send|share|put|drop|publish)(?:\s+(?:a|the|it|them))?(?:\s+(?:summary|report|digest|brief))?(?:\s+of\s+(?:it|them))?\s+(?:in|to|into)\s+(?:the\s+)?#?([\w-]+)(?:\s+channel)?)?$/i,
    (m) => {
      let q = m[2];
      if (/^(?:a |the )?(?:server|activity|moderation)\b/i.test(q)) return null;
      // "get"/"check" alone are too generic: require an information-seeking phrase.
      if (/^(?:get|check)$/i.test(m[1]) && !/\b(?:news|updates?|headlines?|latest|info(?:rmation)?|today'?s?|this week)\b/i.test(q)) return null;
      let timeframe = 'any';
      if (/\b(?:today'?s?|latest|recent|current|this morning|tonight)\b/i.test(q)) timeframe = 'today';
      if (/\b(?:this week'?s?|weekly|past week)\b/i.test(q)) timeframe = 'week';
      q = q
        .replace(/\b(?:today'?s?|latest|recent|current|this week'?s?|weekly|past week|the|some|information|info)\b/gi, ' ')
        .replace(/\b(?:news\s+)?(?:about|on|regarding)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (q.length < 2) return null;
      if (/\bnews\b/i.test(m[2]) && timeframe === 'any') timeframe = 'today';
      const params = { query: q, timeframe };
      if (m[3]) params.channel = entityRef(m[3], 'channel');
      return [step('research.run', params)];
    },
  ],

  // --- reports ---
  [
    /^(?:give(?: me)?|show(?: me)?|generate|post|send|get|create|make)?\s*(?:a\s+|an\s+|the\s+)?(today'?s?|this week'?s?|weekly|daily)?\s*(?:server\s+)?(activity|moderation|mod)\s+(?:report|stats|statistics|summary)(?:\s+for\s+(today|this week))?(?:\s+(?:in|to)\s+#?([\w-]+))?$/i,
    (m) => {
      const when = `${m[1] || ''} ${m[3] || ''}`.toLowerCase();
      const isMod = /mod/i.test(m[2]);
      const period = /week/.test(when) ? 'week' : 'today';
      const params = { period };
      if (m[4]) params.channel = entityRef(m[4], 'channel');
      return [step(isMod ? 'report.moderation' : 'report.activity', params)];
    },
  ],
  [/^(?:server\s+)?(?:stats|statistics)(?:\s+for\s+(today|this week))?$/i, (m) => [step('report.activity', { period: /week/i.test(m[1] || '') ? 'week' : 'today' })]],

  // --- moderation (KNIGHT) ---
  [
    /^(?:time\s?out|mute|silence)\s+(.+?)(?:\s+for\s+(\d+(?:\.\d+)?\s*(?:seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)\b(?:\s*\d+\s*(?:minutes?|mins?|m))?))?(?:\s+(?:for|because|reason:?)\s+(.+))?$/i,
    (m) => {
      const params = { member: entityRef(m[1], 'member') };
      if (m[2]) params.durationMs = parseDuration(m[2]);
      if (m[3]) params.reason = m[3];
      return [step('mod.timeout', params)];
    },
  ],
  [/^(?:remove|lift|end|clear)\s+(?:the\s+)?time\s?out\s+(?:from|for|on)\s+(.+)$|^(?:untimeout|unmute)\s+(.+)$/i, (m) => [step('mod.untimeout', { member: entityRef(m[1] || m[2], 'member') })]],
  [/^warn\s+(.+?)(?:\s+(?:for|because|about)\s+(.+))?$/i, (m) => [step('mod.warn', { member: entityRef(m[1], 'member'), ...(m[2] ? { reason: m[2] } : {}) })]],
  [/^kick\s+(?!off\b)(.+?)(?:\s+(?:for|because)\s+(.+))?$/i, (m) => [step('mod.kick', { member: entityRef(m[1], 'member'), ...(m[2] ? { reason: m[2] } : {}) })]],
  [/^unban\s+(?:user\s+)?(\d{17,20})$/i, (m) => [step('mod.unban', { userId: m[1] })]],
  [/^ban\s+(.+?)(?:\s+(?:for|because)\s+(.+))?$/i, (m) => [step('mod.ban', { member: entityRef(m[1], 'member'), ...(m[2] ? { reason: m[2] } : {}) })]],
  [/^(lock(?:\s?down)?|unlock)\s+(?:the\s+)?(.+?)(?:\s+channel)?$/i, (m) => [step('security.lockdown', { channel: entityRef(m[2], 'channel'), enable: !/^unlock/i.test(m[1]) })]],

  // --- economy ---
  [/^(?:give|grant|award)\s+(\d+)\s+aura\s+to\s+(.+?)(?:\s+(?:for|because)\s+(.+))?$/i, (m) => [step('economy.grant', { amount: +m[1], member: entityRef(m[2], 'member'), reason: m[3] || 'Granted by ALPHA' })]],
  [/^(?:take|remove|revoke|deduct)\s+(\d+)\s+aura\s+from\s+(.+?)(?:\s+(?:for|because)\s+(.+))?$/i, (m) => [step('economy.grant', { amount: -m[1], member: entityRef(m[2], 'member'), reason: m[3] || 'Revoked by ALPHA' })]],

  // --- roles ---
  [
    /^(?:give|assign|add)\s+(?:the\s+)?(.+?)\s+role\s+to\s+(?:every(?:one|body)|all(?:\s+members)?)\s+(?:with|who has|who have|in)\s+(?:the\s+)?(.+?)(?:\s+role)?$/i,
    (m) => [step('role.bulk_assign', { role: entityRef(m[1], 'role'), fromRole: entityRef(m[2], 'role') })],
  ],
  [/^(?:give|assign|add)\s+(?:the\s+)?(.+?)\s+role\s+to\s+(.+)$/i, (m) => [step('role.assign', { role: entityRef(m[1], 'role'), member: entityRef(m[2], 'member') })]],
  [/^(?:give|assign)\s+(.+?)\s+the\s+(.+?)\s+role$/i, (m) => [step('role.assign', { role: entityRef(m[2], 'role'), member: entityRef(m[1], 'member') })]],
  [/^(?:remove|take|revoke)\s+(?:the\s+)?(.+?)\s+role\s+from\s+(.+)$/i, (m) => [step('role.remove', { role: entityRef(m[1], 'role'), member: entityRef(m[2], 'member') })]],
  [/^(?:delete|remove)\s+(?:the\s+)?(.+?)\s+role$/i, (m) => [step('role.delete', { role: entityRef(m[1], 'role') })]],
  [
    /^(?:create|make|add)\s+(?:a\s+|an\s+|new\s+)*(?:role\s+(?:called|named)\s+(.+?)|(.+?)\s+role)(?:\s+with\s+(moderator|mod|basic|no)\s+permissions?)?$/i,
    (m) => {
      const tpl = m[3] ? (/^mod/i.test(m[3]) ? 'moderator' : m[3].toLowerCase() === 'no' ? 'none' : 'basic') : 'none';
      const name = (m[1] || m[2]).replace(/^(?:the|a|an)\s+/i, '').trim();
      return name ? [step('role.create', { name, template: tpl })] : null;
    },
  ],

  // --- channel permissions ---
  [
    /^(?:give|grant|allow|let)\s+(?:the\s+)?(.+?)(?:\s+role)?\s+(read[\s-]?only\s+access|view\s+access|read\s+access|full\s+access|access|permission|permissions|to see|to view)\s+(?:to|in|into|for|on)\s+(.+)$/i,
    (m) => {
      const kind = m[2].toLowerCase();
      const template = /read[\s-]?only/.test(kind) ? 'readonly' : /view|see|read/.test(kind) ? 'view' : 'access';
      return [step('channel.permit', { target: entityRef(m[1], 'target'), channel: entityRef(m[3].replace(/^(?:the\s+)?(?:private\s+)?/i, ''), 'channel'), template })];
    },
  ],
  [
    /^(?:deny|block|revoke|remove|hide)\s+(?:the\s+)?(.+?)(?:\s+role)?(?:\s+(?:access|permission))?\s+(?:to|from|in)\s+(?:the\s+)?(.+)$/i,
    (m) => [step('channel.permit', { target: entityRef(m[1], 'target'), channel: entityRef(m[2].replace(/^(?:private\s+)/i, ''), 'channel'), template: 'deny' })],
  ],
  [
    /^(?:hide|make)\s+(?:the\s+)?(.+?)(?:\s+channel)?\s+(private|read[\s-]?only)(?:\s+for\s+(?:the\s+)?(.+?))?$/i,
    (m) => [
      step('channel.permit', {
        channel: entityRef(m[1], 'channel'),
        target: m[3] ? entityRef(m[3], 'target') : '@everyone',
        template: /private/i.test(m[2]) ? 'deny' : 'readonly',
      }),
    ],
  ],

  // --- channels ---
  [/^rename\s+(?:the\s+)?(.+?)(?:\s+channel)?\s+to\s+(.+)$/i, (m) => [step('channel.rename', { channel: entityRef(m[1], 'channel'), name: m[2].replace(/^#/, '') })]],
  [/^(?:delete|remove|destroy)\s+(?:the\s+)?(?:channel\s+)?(.+?)(?:\s+channel)?$/i, (m) => (/\brole$/i.test(m[1]) ? null : [step('channel.delete', { channel: entityRef(m[1], 'channel') })])],
  [/^(?:create|make|add|set up|setup|open|build)\s+.*(?:channel|vc|category|forum)(?:\s+(?:called|named|for)\s+.+)?$/i, (m) => parseChannelCreate(m[0])],
];

/** Patterns that need the clock (scheduling) are handled separately. */
function parseTimed(t, now, tz) {
  // Reminders
  let m = /^remind\s+me\s+(?:to\s+|about\s+|that\s+)?(.+)$/i.exec(t);
  if (m) {
    const { head, when } = splitTrailingWhen(m[1]);
    const w = when ? parseWhen(when, now, tz) : null;
    if (!w?.at) return { error: 'I could not understand when to remind you. Try "remind me to stretch in 20 minutes".' };
    return { steps: [step('reminder.create', { message: head, at: w.at })] };
  }
  // Events
  m = /^(?:create|schedule|make|host|plan|set up)\s+(?:an?\s+)?(?:new\s+)?(event|tournament|game night|movie night|meetup)(?!\s+(?:channel|role|vc|category|forum)\b)(?:\s+(?:called|named))?\s*(.*)$/i.exec(t);
  if (m) {
    const { head, when } = splitTrailingWhen(m[2]);
    const w = when ? parseWhen(when, now, tz) : null;
    if (!w?.at) return { error: 'Tell me when the event starts, e.g. "create an event called Valorant night tomorrow at 9pm".' };
    const name = (head || m[1]).replace(/^["']|["']$/g, '').trim();
    return { steps: [step('event.create', { name: name.charAt(0).toUpperCase() + name.slice(1), startsAt: w.at })] };
  }
  // Daily research schedules: "every day at 9am post AI news in research"
  m = /^(?:every ?day|daily)\s+at\s+(.+?)\s+(?:post|send|share|find)\s+(.+?)\s+(?:in|to)\s+#?([\w-]+)$/i.exec(t);
  if (m) {
    const w = parseWhen(`every day at ${m[1]}`, now, tz);
    if (w?.dailyTime) return { steps: [step('research.schedule', { query: m[2], channel: entityRef(m[3], 'channel'), dailyTime: w.dailyTime })] };
  }
  // Announcements, optionally scheduled
  m =
    /^(?:post|send|make|schedule|publish)\s+(?:an?\s+)?announcement\s+(?:in|to)\s+(?:the\s+)?#?([\w-]+)(?:\s+channel)?\s+(?:saying|that says|that|:)\s+(.+)$/i.exec(t) ||
    /^(?:announce|post|send|say)\s+["“]?(.+?)["”]?\s+(?:in|to)\s+(?:the\s+)?#?([\w-]+)(?:\s+channel)?((?:\s+(?:in\s+\d|at\s+\d|tomorrow|tonight|every ?day|daily|on\s+\w+day)[^]*)?)$/i.exec(t);
  if (m) {
    let channel;
    let message;
    let whenText = null;
    if (/announcement/i.test(m[0].split(/\s+(?:saying|that says|that|:)\s+/i)[0]) && m.length === 3) {
      channel = m[1];
      const split = splitTrailingWhen(m[2]);
      message = split.head;
      whenText = split.when;
    } else {
      message = m[1];
      channel = m[2];
      whenText = m[3]?.trim() || null;
    }
    const pingEveryone = /\b(?:and\s+)?ping\s+everyone\b/i.test(message);
    message = message.replace(/\s*(?:and\s+)?ping\s+everyone\b/i, '').trim();
    if (!message) return null;
    const base = { channel: entityRef(channel, 'channel'), message };
    if (whenText) {
      const w = parseWhen(whenText, now, tz);
      if (!w) return { error: 'I could not understand the schedule time.' };
      return { steps: [step('schedule.message', { ...base, ...(w.at ? { at: w.at } : { dailyTime: w.dailyTime }) })] };
    }
    return { steps: [step('announce.send', { ...base, pingEveryone })] };
  }
  return null;
}

function parseSingle(t, now, tz) {
  const timed = parseTimed(t, now, tz);
  if (timed) return timed;
  for (const [re, build] of MATCHERS) {
    const m = re.exec(t);
    if (!m) continue;
    const steps = build(m);
    if (steps) return { steps };
  }
  return null;
}

/**
 * @returns {{steps: {action:string, params:object}[], confidence:number, error?:string, text:string}}
 */
export function parseCommand(input, { now = Date.now(), tz = 'UTC' } = {}) {
  const { rest } = stripWakeWord(String(input ?? ''));
  const t = clean(rest);
  if (!t) return { steps: [], confidence: 0, text: t, error: 'empty command' };

  const whole = parseSingle(t, now, tz);

  // Compound instructions ("X and Y"): used when EVERY part parses on its
  // own. Names containing "and" stay intact because the leftover fragment
  // ("Roll" in "play Rock and Roll") does not parse by itself.
  const parts = t.split(/\s*(?:,\s*)?\b(?:and then|then|and also|and)\b\s*/i).filter(Boolean);
  let compound = null;
  let failedPart = null;
  if (parts.length > 1) {
    compound = [];
    for (const part of parts) {
      const r = parseSingle(clean(part), now, tz);
      if (!r?.steps) {
        compound = null;
        failedPart = part;
        break;
      }
      compound.push(...r.steps);
    }
  }
  // "find X and post a summary in Y" is a single research instruction.
  const wholeIsResearchPost = whole?.steps?.[0]?.action === 'research.run' && whole.steps[0].params.channel;
  if (compound && !wholeIsResearchPost) return { steps: compound, confidence: 0.85, text: t };
  if (whole?.steps) return { steps: whole.steps, confidence: 0.95, text: t };
  if (whole?.error) return { steps: [], confidence: 0, text: t, error: whole.error };
  return { steps: [], confidence: 0, text: t, error: `I did not understand "${failedPart ?? t}".` };
}
