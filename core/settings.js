// Per-guild settings: defaults deep-merged with stored overrides.
import { DEFAULT_GUILD_SETTINGS } from '../config/defaults.js';

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function deepMerge(base, over) {
  if (!isObj(over)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : structuredClone(v);
  }
  return out;
}

function readOverrides(db, guildId) {
  const row = db.get('SELECT data FROM guild_settings WHERE guild_id = ?', guildId);
  if (!row) return {};
  try {
    return JSON.parse(row.data);
  } catch {
    return {};
  }
}

export function getGuildSettings(db, guildId) {
  return deepMerge(DEFAULT_GUILD_SETTINGS, readOverrides(db, guildId));
}

/** Resolve the default value at a dotted path, or undefined if the path is unknown. */
function defaultAt(path) {
  let cur = DEFAULT_GUILD_SETTINGS;
  for (const key of path.split('.')) {
    if (!isObj(cur) || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * Set one setting by dotted path. Only paths present in the defaults are
 * accepted and the value must match the default's type, so arbitrary keys
 * (including from AI output) can never be written.
 */
export function setGuildSetting(db, guildId, path, value) {
  const def = defaultAt(path);
  if (def === undefined) throw new Error(`Unknown setting "${path}"`);
  const expected = def === null ? 'nullable-string' : Array.isArray(def) ? 'array' : typeof def;
  const ok =
    expected === 'nullable-string'
      ? value === null || typeof value === 'string'
      : expected === 'array'
        ? Array.isArray(value)
        : typeof value === expected;
  if (!ok) throw new Error(`Setting "${path}" expects ${expected}`);
  db.transaction(() => {
    const data = readOverrides(db, guildId);
    const keys = path.split('.');
    let cur = data;
    for (const k of keys.slice(0, -1)) cur = isObj(cur[k]) ? cur[k] : (cur[k] = {});
    cur[keys.at(-1)] = value;
    db.run(
      `INSERT INTO guild_settings (guild_id, data, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      guildId,
      JSON.stringify(data),
      Date.now(),
    );
  });
  return getGuildSettings(db, guildId);
}

export function kvGet(db, key, fallback = null) {
  const row = db.get('SELECT value FROM kv WHERE key = ?', key);
  return row ? JSON.parse(row.value) : fallback;
}

export function kvSet(db, key, value) {
  db.run(
    `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    JSON.stringify(value),
    Date.now(),
  );
}
