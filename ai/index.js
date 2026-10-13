// Hosted AI provider facade. The bots work fully without it: it is only an
// optional fallback interpreter when deterministic parsing fails, and an
// optional summariser. Its output is untrusted and is validated against the
// action registry before anything is executed.
import { actionCatalogue, getAction } from '../core/actions/registry.js';
import { validateParams } from '../core/actions/validate.js';
import { reserveUsage, CircuitBreaker, usageToday } from './usage.js';
import { groqChatJson } from './groq.js';

const PLAN_SYSTEM = `You convert a Discord server owner's spoken or typed instruction into JSON.
Only use actions from this catalogue (params ending in "?" are optional; "ref" means a name of a channel, role or member exactly as the user said it):
{CATALOGUE}
Rules:
- Respond with {"steps":[{"action":"<name>","params":{...}}]} or {"steps":[],"clarify":"<short question>"} if unsure.
- Never invent actions or parameters. Never include IDs you were not given.
- Use "$last_channel" / "$last_member" / "$last_role" for "that channel" / "that member" / "that role".
- Durations are in milliseconds. Times (at/startsAt) are unix epoch milliseconds; current time is {NOW} ({TZ}).
- You cannot grant permissions, confirm actions or bypass approval; the application decides that.`;

export class NoAI {
  name = 'none';
  available() {
    return false;
  }
  status() {
    return { provider: 'none', enabled: false, note: 'Deterministic parsing only' };
  }
  async planCommand() {
    return null;
  }
  async summarize() {
    return null;
  }
}

export class GroqAI {
  constructor({ config, db, logger, fetchImpl }) {
    this.name = 'groq';
    this.cfg = config.ai;
    this.tz = config.timezone;
    this.db = db;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.breaker = new CircuitBreaker();
  }

  available() {
    return Boolean(this.cfg.apiKey) && !this.breaker.open;
  }

  status() {
    const u = usageToday(this.db, 'groq', 'chat');
    return {
      provider: 'groq',
      model: this.cfg.model,
      enabled: Boolean(this.cfg.apiKey),
      circuitOpen: this.breaker.open,
      usedToday: u.requests,
      dailyLimit: this.cfg.dailyLimit,
    };
  }

  async call(system, user) {
    if (!this.available()) return null;
    if (!reserveUsage(this.db, 'groq', 'chat', this.cfg.dailyLimit)) {
      this.logger?.warn('AI daily limit reached; using deterministic logic only');
      return null;
    }
    try {
      const out = await groqChatJson({ apiKey: this.cfg.apiKey, model: this.cfg.model, system, user, timeoutMs: this.cfg.timeoutMs, fetchImpl: this.fetchImpl });
      this.breaker.success();
      return out;
    } catch (err) {
      this.breaker.failure(err.status === 429 ? err.retryAfterMs || 60000 : undefined);
      this.logger?.warn('AI provider call failed; continuing without AI', { err: err.message, status: err.status });
      return null;
    }
  }

  /** Returns validated steps, a clarification, or null. */
  async planCommand(text, { now = Date.now() } = {}) {
    const system = PLAN_SYSTEM.replace('{CATALOGUE}', JSON.stringify(actionCatalogue())).replace('{NOW}', String(now)).replace('{TZ}', this.tz);
    const out = await this.call(system, String(text).slice(0, 500));
    return sanitizePlan(out);
  }

  /** Optional synthesis over retrieved items. Clearly labelled as inference by callers. */
  async summarize(query, items) {
    const system =
      'Summarise the provided news/search items for a Discord channel in 3-5 bullet points. Use ONLY the given items; cite each point with its [n] index. Respond as {"bullets":["..."]}.';
    const user = JSON.stringify({ query, items: items.map((it, i) => ({ n: i + 1, title: it.title, source: it.source, snippet: it.snippet?.slice(0, 300) })) });
    const out = await this.call(system, user);
    if (!out || !Array.isArray(out.bullets)) return null;
    return out.bullets.filter((b) => typeof b === 'string').slice(0, 6).map((b) => b.slice(0, 400));
  }
}

/** Validate untrusted AI output against the action registry. */
export function sanitizePlan(out) {
  if (!out || typeof out !== 'object') return null;
  if (typeof out.clarify === 'string' && (!Array.isArray(out.steps) || out.steps.length === 0)) {
    return { steps: [], clarify: out.clarify.slice(0, 300) };
  }
  if (!Array.isArray(out.steps) || out.steps.length === 0 || out.steps.length > 5) return null;
  const steps = [];
  for (const s of out.steps) {
    const def = s && typeof s.action === 'string' ? getAction(s.action) : null;
    if (!def) return null;
    const v = validateParams(def.params, s.params ?? {});
    if (!v.ok) return null;
    steps.push({ action: s.action, params: v.value });
  }
  return { steps };
}

export function createAI({ config, db, logger, fetchImpl }) {
  if (config.ai.provider === 'groq' && config.ai.apiKey) return new GroqAI({ config, db, logger, fetchImpl });
  return new NoAI();
}
