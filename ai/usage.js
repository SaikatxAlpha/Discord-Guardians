// Daily usage accounting for hosted free-tier providers. Free tiers are not
// unlimited: requests beyond the configured daily cap are refused locally.
import { dayKey } from '../core/time.js';

/** Atomically reserve one request if under `limit`. Returns false when exhausted. */
export function reserveUsage(db, provider, kind, limit, units = 0, now = Date.now()) {
  const day = dayKey(now, 'UTC');
  return db.transaction(() => {
    const row = db.get('SELECT requests FROM provider_usage WHERE day = ? AND provider = ? AND kind = ?', day, provider, kind);
    if (row && row.requests >= limit) return false;
    db.run(
      `INSERT INTO provider_usage (day, provider, kind, requests, units) VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(day, provider, kind) DO UPDATE SET requests = requests + 1, units = units + excluded.units`,
      day,
      provider,
      kind,
      units,
    );
    return true;
  });
}

/** Per-server daily counter; returns false once `limit` is reached for that server. */
export function reserveGuildUsage(db, guildId, kind, limit, now = Date.now()) {
  if (!guildId || !limit) return true;
  const day = dayKey(now, 'UTC');
  return db.transaction(() => {
    const row = db.get('SELECT count FROM guild_usage WHERE day = ? AND guild_id = ? AND kind = ?', day, guildId, kind);
    if (row && row.count >= limit) return false;
    db.run(
      `INSERT INTO guild_usage (day, guild_id, kind, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(day, guild_id, kind) DO UPDATE SET count = count + 1`,
      day,
      guildId,
      kind,
    );
    return true;
  });
}

export function guildUsageToday(db, guildId, kind, now = Date.now()) {
  return db.get('SELECT count FROM guild_usage WHERE day = ? AND guild_id = ? AND kind = ?', dayKey(now, 'UTC'), guildId, kind)?.count ?? 0;
}

export function usageToday(db, provider, kind, now = Date.now()) {
  const row = db.get('SELECT requests, units FROM provider_usage WHERE day = ? AND provider = ? AND kind = ?', dayKey(now, 'UTC'), provider, kind);
  return row ?? { requests: 0, units: 0 };
}

/** Simple circuit breaker: after repeated failures or a 429, pause the provider. */
export class CircuitBreaker {
  constructor({ threshold = 3, cooldownMs = 5 * 60000 } = {}) {
    Object.assign(this, { threshold, cooldownMs, failures: 0, openUntil: 0 });
  }
  get open() {
    return Date.now() < this.openUntil;
  }
  success() {
    this.failures = 0;
  }
  failure(retryAfterMs) {
    this.failures++;
    if (retryAfterMs || this.failures >= this.threshold) {
      this.openUntil = Date.now() + Math.max(retryAfterMs || 0, this.cooldownMs);
      this.failures = 0;
    }
  }
}
