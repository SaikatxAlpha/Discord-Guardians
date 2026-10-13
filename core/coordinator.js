// ALPHA core: the shared command pipeline used by both guardian bots.
//
// request -> identity verification -> intent resolution -> structured plan
// -> permission checks -> risk classification -> optional confirmation
// -> execution (locally or on the other bot via the task queue)
// -> result verification -> audit log -> response
import { parseCommand } from './intents/parser.js';
import { getAction, RISK, RISK_NAMES } from './actions/registry.js';
import { validateParams } from './actions/validate.js';
import { resolveStep } from './actions/resolve.js';
import { authLevel, AUTH, AUTH_NAMES } from './auth.js';
import { audit } from './audit.js';
import { setRef } from './context.js';
import { createApproval, decideApproval, finishApproval } from './approvals.js';
import { enqueueTask, waitForTask, claimRequest } from './taskQueue.js';
import { getGuildSettings } from './settings.js';
import { normName } from './discord/resolve.js';

/** Steps that produce a context reference usable by later steps. */
const PRODUCES = { 'channel.create': 'channel', 'role.create': 'role' };

export class AlphaCoordinator {
  /**
   * @param {object} o
   * @param {import('../database/db.js').Database} o.db
   * @param {object} o.config
   * @param {'knight'|'aegis'} o.bot this process's bot
   * @param {Map<string, Function>} o.handlers action handlers available in this process
   * @param {(guildId:string)=>Promise<object|null>} o.getGuild
   * @param {(guild:object, request:object)=>object} [o.makeContext] extra handler context
   */
  constructor({ db, config, bot, logger, ai, handlers, getGuild, makeContext = () => ({}), crossBotTimeoutMs = 45000 }) {
    Object.assign(this, { db, config, bot, logger, ai, handlers, getGuild, makeContext, crossBotTimeoutMs });
  }

  /** Natural-language entry point (typed "ALPHA, ..." or a voice transcript). */
  async handleText(req) {
    if (!claimRequest(this.db, req.requestId, this.bot)) return { status: 'duplicate', message: 'Already handled.' };
    // 1. Identity verification. The wake word is not authentication.
    const level = authLevel({ userId: req.userId, config: this.config });
    if (level < AUTH.TRUSTED) {
      this.audit(req, 'alpha.denied', { outcome: 'denied', detail: 'not owner/trusted' });
      return { status: 'rejected', message: 'ALPHA only accepts commands from the Soul Society owner.' };
    }
    // 2. Intent resolution: deterministic first, hosted AI only as a fallback.
    let parsed = parseCommand(req.text, { tz: this.config.timezone });
    let via = 'deterministic';
    if (!parsed.steps.length && this.ai?.available()) {
      const ai = await this.ai.planCommand(parsed.text || req.text);
      if (ai?.clarify) return { status: 'clarify', message: ai.clarify };
      if (ai?.steps?.length) {
        parsed = { steps: ai.steps, confidence: 0.7, text: parsed.text };
        via = 'ai';
      }
    }
    if (!parsed.steps.length) {
      return { status: 'clarify', message: `${parsed.error ?? 'I did not understand that.'} Say "ALPHA, help" for examples.` };
    }
    return this.handleSteps({ ...req, level, via }, parsed.steps, { dedupe: false });
  }

  /** Structured entry point (slash commands, and the natural-language path above). */
  async handleSteps(req, steps, { dedupe = true } = {}) {
    if (dedupe && !claimRequest(this.db, req.requestId, this.bot)) return { status: 'duplicate', message: 'Already handled.' };
    const level = req.level ?? authLevel({ userId: req.userId, config: this.config, member: req.member });
    req = { ...req, level };
    const guild = await this.getGuild(req.guildId);
    if (!guild) return { status: 'error', message: 'This command must be used inside the server.' };

    // 3. Structured plan with validation and per-action authorisation.
    const plan = [];
    for (const s of steps) {
      const def = getAction(s.action);
      if (!def) return { status: 'rejected', message: `Unknown action "${s.action}".` };
      const v = validateParams(def.params, s.params);
      if (!v.ok) return { status: 'clarify', message: `${s.action}: ${v.errors.join('; ')}` };
      if (level < def.minAuth) {
        this.audit(req, s.action, { outcome: 'denied', params: v.value, detail: `requires ${AUTH_NAMES[def.minAuth]}` });
        return { status: 'rejected', message: `You are not authorised to perform ${s.action} (requires ${AUTH_NAMES[def.minAuth].toLowerCase()}).` };
      }
      plan.push({ action: s.action, params: v.value });
    }

    // 4/5. Resolve targets and classify risk.
    const prepared = await this.prepare(guild, req, plan);
    if (!prepared.ok) return { status: 'clarify', message: prepared.error };

    // 6. Optional confirmation.
    if (this.needsConfirmation(prepared.maxRisk, req)) {
      const summary = prepared.resolved.map((r, i) => `${i + 1}. ${getAction(r.step.action).describe(r.step.params)}`).join('\n');
      const approval = createApproval(this.db, {
        guildId: req.guildId,
        ownerId: req.userId,
        bot: this.bot,
        plan,
        context: { snapshot: prepared.resolved.map(snapshotOf), request: pickRequest(req) },
        summary,
        risk: RISK_NAMES[prepared.maxRisk],
        ttlMs: this.config.approvalTtlMs,
      });
      this.audit(req, 'approval.requested', { outcome: 'pending', params: plan, detail: approval.id });
      return { status: 'awaiting_approval', approval, summary, warnings: prepared.warnings, risk: RISK_NAMES[prepared.maxRisk] };
    }
    return this.execute(guild, req, prepared.resolved, null);
  }

  needsConfirmation(risk, req) {
    if (risk >= RISK.CRITICAL) return true;
    if (risk >= RISK.HIGH && req.source !== 'slash') return true;
    if (risk >= RISK.MEDIUM && req.source === 'voice') {
      const s = getGuildSettings(this.db, req.guildId);
      return s.alpha.confirmMediumFromVoice;
    }
    return false;
  }

  async prepare(guild, req, plan) {
    const resolved = [];
    const warnings = [];
    let maxRisk = RISK.LOW;
    const pendingRefs = new Set();
    for (const step of plan) {
      const r = await resolveStep({ guild, step, request: req, db: this.db, config: this.config, pendingRefs });
      if (!r.ok) return { ok: false, error: r.error };
      resolved.push(r);
      warnings.push(...r.warnings);
      maxRisk = Math.max(maxRisk, r.risk);
      if (PRODUCES[step.action]) {
        // Later steps may refer to the new entity as "it"/"that ..." or by its name.
        pendingRefs.add(PRODUCES[step.action]);
        pendingRefs.add(`${PRODUCES[step.action]}:${normName(step.params.name)}`);
      }
    }
    return { ok: true, resolved, warnings, maxRisk };
  }

  /** Button decision on a pending approval. */
  async decide({ approvalId, userId, approve }) {
    const d = decideApproval(this.db, { id: approvalId, userId, approve });
    const req = d.approval?.context?.request;
    if (!d.ok) {
      this.audit({ guildId: d.approval?.guild_id, userId }, 'approval.decision', { outcome: `refused:${d.reason}`, detail: approvalId });
      const messages = {
        not_found: 'This approval no longer exists.',
        unauthorized: 'Only the person who requested this action can approve it.',
        expired: 'This approval has expired. Please issue the command again.',
        already_decided: 'This approval was already decided.',
      };
      return { status: 'rejected', reason: d.reason, message: messages[d.reason] };
    }
    if (!approve) {
      this.audit(req, 'approval.decision', { outcome: 'rejected', detail: approvalId });
      return { status: 'cancelled', message: 'Cancelled. Nothing was changed.' };
    }
    const guild = await this.getGuild(d.approval.guild_id);
    if (!guild) return { status: 'error', message: 'Server is unavailable.' };
    // Re-resolve against the current server state and make sure the targets
    // are exactly those the owner approved (no time-of-check drift).
    const prepared = await this.prepare(guild, req, d.approval.plan);
    if (!prepared.ok) {
      finishApproval(this.db, approvalId, 'failed: ' + prepared.error);
      return { status: 'error', message: prepared.error };
    }
    const now = JSON.stringify(prepared.resolved.map(snapshotOf));
    if (now !== JSON.stringify(d.approval.context.snapshot)) {
      finishApproval(this.db, approvalId, 'aborted: targets changed');
      return { status: 'error', message: 'The targets changed after approval was requested. Nothing was done; please issue the command again.' };
    }
    this.audit(req, 'approval.decision', { outcome: 'approved', detail: approvalId });
    const result = await this.execute(guild, req, prepared.resolved, approvalId);
    finishApproval(this.db, approvalId, result.status);
    return result;
  }

  /** 7-10. Execute, verify, audit and report each step in order. */
  async execute(guild, req, resolved, approvalId) {
    const results = [];
    for (let i = 0; i < resolved.length; i++) {
      let { step } = resolved[i];
      if (resolved[i].deferred) {
        const r = await resolveStep({ guild, step, request: req, db: this.db, config: this.config });
        if (!r.ok) {
          results.push({ action: step.action, ok: false, message: r.error });
          break;
        }
        step = r.step;
      }
      const res = await this.runStep(guild, req, step, i, approvalId);
      results.push({ action: step.action, ...res });
      if (res.refs) for (const [kind, id] of Object.entries(res.refs)) setRef(this.db, req.guildId, req.userId, kind, id);
      if (res.ok === false) break; // stop the plan; later steps may depend on this one
    }
    const ok = results.every((r) => r.ok);
    const pending = results.some((r) => r.ok == null);
    return { status: ok ? 'executed' : pending ? 'queued' : 'failed', results };
  }

  async runStep(guild, req, step, index, approvalId) {
    const def = getAction(step.action);
    const target = def.bot === 'any' ? this.bot : def.bot;
    let res;
    try {
      if (target === this.bot) {
        const handler = this.handlers.get(step.action);
        if (!handler) throw new Error(`${step.action} is not available in this process`);
        const settings = getGuildSettings(this.db, guild.id);
        res = await handler({ db: this.db, config: this.config, logger: this.logger, bot: this.bot, guild, settings, request: req, ...this.makeContext(guild, req) }, step.params);
      } else {
        // Cross-bot execution through the shared queue (idempotent per request step).
        const task = enqueueTask(this.db, {
          targetBot: target,
          action: step.action,
          params: step.params,
          context: pickRequest(req),
          guildId: req.guildId,
          requestedBy: req.userId,
          source: req.source,
          idempotencyKey: `${req.requestId}:${approvalId ?? 'direct'}:${index}`,
          maxAttempts: def.retryable ? 3 : 1,
        });
        const done = await waitForTask(this.db, task.id, { timeoutMs: this.crossBotTimeoutMs });
        if (done.status === 'done') res = done.result;
        else if (done.status === 'failed') res = { ok: false, message: done.error };
        else res = { ok: null, message: `Queued for ${target.toUpperCase()}; it will act as soon as it is online.` };
      }
    } catch (err) {
      this.logger?.error('action failed', { action: step.action, err });
      res = { ok: false, message: humanError(err) };
    }
    this.audit(req, step.action, {
      outcome: res?.ok === true ? (res.simulated ? 'simulated' : 'success') : res?.ok === false ? 'failed' : 'queued',
      params: step.params,
      target: step.params.memberId || step.params.channelId || step.params.roleId || step.params.targetId || null,
      detail: [res?.message, approvalId && `approval ${approvalId}`, req.via && `via ${req.via}`].filter(Boolean).join(' | '),
    });
    return res ?? { ok: false, message: 'No result' };
  }

  audit(req, action, { outcome, params = null, target = null, detail = null }) {
    try {
      audit(this.db, { guildId: req?.guildId ?? null, actorId: req?.userId ?? null, bot: this.bot, action, target, params, outcome, detail: [req?.source, detail].filter(Boolean).join(' | ') });
    } catch (err) {
      this.logger?.error('audit write failed', { err });
    }
  }
}

function snapshotOf(r) {
  const p = r.step.params;
  const ids = Object.fromEntries(Object.entries(p).filter(([k]) => k.endsWith('Id') || k === 'template' || k === 'durationMs'));
  return { action: r.step.action, ...ids };
}

function pickRequest(req) {
  return { requestId: req.requestId, guildId: req.guildId, userId: req.userId, channelId: req.channelId, source: req.source, via: req.via, level: req.level };
}

export function humanError(err) {
  const code = err?.code;
  const map = {
    50013: 'Discord refused: I am missing permissions for that (check my role position and channel permissions).',
    50001: 'Discord refused: I cannot access that channel.',
    10003: 'That channel no longer exists.',
    10007: 'That member is no longer in the server.',
    10011: 'That role no longer exists.',
    30013: 'This server has reached the maximum number of roles.',
    50035: 'Discord rejected the request as invalid.',
  };
  return map[code] ?? String(err?.message ?? err).slice(0, 300);
}
