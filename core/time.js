// Time zone aware helpers with no external dependencies.

const fmtCache = new Map();
function partsFormatter(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

/** Wall-clock parts of `ts` in time zone `tz`. */
export function zonedParts(ts, tz) {
  const out = {};
  for (const p of partsFormatter(tz).formatToParts(new Date(ts))) out[p.type] = p.value;
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year: +out.year,
    month: +out.month,
    day: +out.day,
    hour: +out.hour,
    minute: +out.minute,
    second: +out.second,
    weekday: weekdays[out.weekday],
  };
}

/** Offset (ms) of tz from UTC at instant ts. */
function tzOffset(ts, tz) {
  const p = zonedParts(ts, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/** Convert a wall-clock time in tz to a UTC timestamp. */
export function zonedToUtc({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - tzOffset(guess, tz);
  // Second pass handles DST boundaries.
  ts = guess - tzOffset(ts, tz);
  return ts;
}

export function dayKey(ts, tz) {
  const p = zonedParts(ts, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** ISO-like week key (Monday-based) in tz, e.g. 2026-W42. */
export function weekKey(ts, tz) {
  const p = zonedParts(ts, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function previousDayKey(ts, tz) {
  return dayKey(ts - 86400000, tz);
}

export function parseHHMM(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str).trim());
  if (!m) return null;
  const hour = +m[1];
  const minute = +m[2];
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

/**
 * Next run time for a schedule strictly after `after`.
 * Schedules: {kind:'once', at} | {kind:'interval', everyMs, anchor} |
 *            {kind:'daily', time:'HH:MM'} | {kind:'weekly', weekday, time}
 */
export function nextOccurrence(schedule, after, tz) {
  switch (schedule.kind) {
    case 'once':
      return schedule.at > after ? schedule.at : null;
    case 'interval': {
      const anchor = schedule.anchor ?? after;
      if (anchor > after) return anchor;
      const n = Math.floor((after - anchor) / schedule.everyMs) + 1;
      return anchor + n * schedule.everyMs;
    }
    case 'daily':
    case 'weekly': {
      const t = parseHHMM(schedule.time);
      if (!t) throw new Error(`invalid time ${schedule.time}`);
      const p = zonedParts(after, tz);
      for (let i = 0; i <= 8; i++) {
        const base = new Date(Date.UTC(p.year, p.month - 1, p.day + i));
        const cand = zonedToUtc(
          { year: base.getUTCFullYear(), month: base.getUTCMonth() + 1, day: base.getUTCDate(), ...t },
          tz,
        );
        if (cand <= after) continue;
        if (schedule.kind === 'weekly' && base.getUTCDay() !== schedule.weekday) continue;
        return cand;
      }
      return null;
    }
    default:
      throw new Error(`unknown schedule kind ${schedule.kind}`);
  }
}

const UNITS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
};

/** Parse "10m", "1h30m", "5 minutes", "2 hours" into milliseconds. */
export function parseDuration(text) {
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w)(?![a-z])/gi;
  let total = 0;
  let m;
  let matched = false;
  while ((m = re.exec(String(text)))) {
    matched = true;
    total += parseFloat(m[1]) * UNITS[m[2].toLowerCase()];
  }
  return matched ? Math.round(total) : null;
}

export function formatDuration(ms) {
  if (ms == null) return 'n/a';
  const parts = [];
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms % 86400000) / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d && !h) parts.push(`${s}s`);
  return parts.join(' ') || '0s';
}
