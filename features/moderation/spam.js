// In-memory spam and raid detectors (per process, per guild).
import crypto from 'node:crypto';
import { normaliseText } from './filter.js';

const INVITE_RE = /(?:discord(?:app)?\.com\/invite|discord\.gg)\/[\w-]+/i;

export class SpamTracker {
  constructor() {
    this.users = new Map();
  }

  /**
   * @param {{guildId:string, userId:string, content:string, mentionCount:number, now?:number}} m
   * @param {object} cfg moderation.spam settings
   * @returns {{spam:false}|{spam:true, rule:string, detail:string}}
   */
  check({ guildId, userId, content, mentionCount = 0, now = Date.now() }, cfg) {
    if (!cfg.enabled) return { spam: false };
    const key = `${guildId}:${userId}`;
    const horizon = Math.max(cfg.floodWindowMs, cfg.duplicateWindowMs);
    const s = this.users.get(key) ?? { times: [], hashes: [] };
    s.times = s.times.filter((t) => now - t < horizon);
    s.hashes = s.hashes.filter((h) => now - h.t < horizon);
    s.times.push(now);
    const norm = normaliseText(content).replace(/\s+/g, ' ').trim();
    const hash = norm ? crypto.createHash('sha1').update(norm).digest('hex') : null;
    if (hash) s.hashes.push({ h: hash, t: now });
    this.users.set(key, s);

    if (mentionCount >= cfg.mentionLimit) return { spam: true, rule: 'mention_spam', detail: `${mentionCount} mentions in one message` };
    if (cfg.blockInvites && INVITE_RE.test(content)) return { spam: true, rule: 'invite_link', detail: 'Discord invite link' };
    const recent = s.times.filter((t) => now - t < cfg.floodWindowMs).length;
    if (recent >= cfg.floodCount) return { spam: true, rule: 'flood', detail: `${recent} messages in ${cfg.floodWindowMs / 1000}s` };
    if (hash) {
      const dup = s.hashes.filter((x) => x.h === hash && now - x.t < cfg.duplicateWindowMs).length;
      if (dup >= cfg.duplicateCount) return { spam: true, rule: 'duplicate', detail: `same message ${dup} times` };
    }
    return { spam: false };
  }

  /** Drop idle entries to bound memory. */
  sweep(now = Date.now(), maxAgeMs = 120000) {
    for (const [k, s] of this.users) if (!s.times.length || now - s.times.at(-1) > maxAgeMs) this.users.delete(k);
  }
}

export class RaidDetector {
  constructor() {
    this.joins = new Map();
    this.raidUntil = new Map();
  }

  /** @returns {{raid:boolean, started:boolean, count:number, newAccount:boolean}} */
  onJoin({ guildId, accountCreatedAt, now = Date.now() }, cfg) {
    const list = (this.joins.get(guildId) ?? []).filter((t) => now - t < cfg.joinWindowMs);
    list.push(now);
    this.joins.set(guildId, list);
    const newAccount = accountCreatedAt != null && now - accountCreatedAt < cfg.newAccountDays * 86400000;
    if (!cfg.enabled) return { raid: false, started: false, count: list.length, newAccount };
    const wasRaid = (this.raidUntil.get(guildId) ?? 0) > now;
    if (list.length >= cfg.joinCount) this.raidUntil.set(guildId, now + cfg.joinWindowMs * 4);
    const raid = (this.raidUntil.get(guildId) ?? 0) > now;
    return { raid, started: raid && !wasRaid, count: list.length, newAccount };
  }
}
