// Resolve a validated step's free-text references against the guild and
// refine its risk using real data (e.g. opening a channel to @everyone or
// assigning a role that carries administrative permissions).
import { getAction, RISK } from './registry.js';
import { resolveChannel, resolveMember, resolveRole, resolveTarget, normName } from '../discord/resolve.js';
import { dangerousPermissionsOf } from '../discord/safety.js';
import { getRef } from '../context.js';
import { isServerSupreme } from '../auth.js';

const CONTEXT_TOKENS = { $last_channel: 'channel', $last_member: 'member', $last_role: 'role' };

const MEMBER_FIELDS = ['member'];
const CHANNEL_FIELDS = ['channel', 'category'];
const ROLE_FIELDS = ['role', 'fromRole'];

function channelLabel(c) {
  return c.type === 2 ? `🔊 ${c.name}` : `#${c.name}`;
}

/**
 * @param {object} o
 * @param {object} o.guild discord.js Guild (or test mock)
 * @param {{action:string, params:object}} o.step validated step
 * @param {{userId:string, source:string}} o.request
 * @param {Set<string>} [o.pendingRefs] context kinds an earlier step in the same plan will produce
 * @returns {Promise<{ok:boolean, step?:object, risk?:number, warnings?:string[], error?:string, deferred?:boolean}>}
 */
export async function resolveStep({ guild, step, request, db, config, pendingRefs = new Set() }) {
  const def = getAction(step.action);
  if (!def) return { ok: false, error: `Unknown action ${step.action}` };
  const params = { ...step.params };
  const warnings = [];
  let deferred = false;

  // Context references ("that channel") and self references.
  for (const [key, value] of Object.entries(params)) {
    if (value === '$self') {
      params[key] = `<@${request.userId}>`;
      continue;
    }
    const kind = CONTEXT_TOKENS[value];
    if (!kind) continue;
    if (pendingRefs.has(kind)) {
      deferred = true; // produced by an earlier step; resolve at execution time
      continue;
    }
    const id = getRef(db, guild.id, request.userId, kind);
    if (!id) return { ok: false, error: `I don't know which ${kind} you mean by "that ${kind}". Please name it.` };
    params[key] = id;
  }

  // References by name to an entity created earlier in the same plan.
  const byName = (kind, value) => typeof value === 'string' && pendingRefs.has(`${kind}:${normName(value)}`);
  if (CHANNEL_FIELDS.some((f) => byName('channel', params[f])) || ROLE_FIELDS.some((f) => byName('role', params[f])) || byName('role', params.target) || byName('channel', params.target)) {
    deferred = true;
  }

  let risk = def.risk(params, request);
  if (deferred) return { ok: true, step: { action: step.action, params }, risk, warnings, deferred: true };

  // Never let a loose fuzzy match pick the target of a sensitive action:
  // high-risk actions need an exact name (or mention/ID); voice commands
  // never accept typo-tolerant matches.
  const minScore = risk >= RISK.HIGH ? 100 : request.source === 'voice' ? 60 : 0;
  const fuzzyNote = (label, score) => {
    if (score != null && score < 100) {
      warnings.push(`Matched "${label}" by partial name.`);
      if (request.source === 'voice') risk = Math.max(risk, RISK.MEDIUM);
    }
  };

  for (const f of CHANNEL_FIELDS) {
    if (!params[f]) continue;
    const r = await resolveChannel(guild, params[f], f === 'category' ? { types: ['category'], minScore } : { minScore });
    if (!r.ok) return { ok: false, error: r.error };
    fuzzyNote(channelLabel(r.channel), r.score);
    params[`${f}Id`] = r.channel.id;
    params[`${f}Label`] = channelLabel(r.channel);
  }
  for (const f of ROLE_FIELDS) {
    if (!params[f]) continue;
    const r = await resolveRole(guild, params[f], { minScore });
    if (!r.ok) return { ok: false, error: r.error };
    fuzzyNote(`@${r.role.name}`, r.score);
    params[`${f}Id`] = r.role.id;
    params[`${f}Label`] = r.role.id === guild.id ? '@everyone' : `@${r.role.name}`;
    if (f === 'role' && ['role.assign', 'role.bulk_assign'].includes(step.action)) {
      const dangerous = dangerousPermissionsOf(r.role);
      if (dangerous.length) {
        risk = RISK.CRITICAL;
        warnings.push(`@${r.role.name} carries privileged permissions (${dangerous.join(', ')}).`);
      }
    }
  }
  for (const f of MEMBER_FIELDS) {
    if (!params[f]) continue;
    const r = await resolveMember(guild, params[f], { minScore });
    if (!r.ok) return { ok: false, error: r.error };
    const m = r.member;
    fuzzyNote(m.displayName, r.score);
    params[`${f}Id`] = m.id;
    params[`${f}Label`] = `${m.displayName} (${m.user?.username ?? m.id})`;
    if (step.action.startsWith('mod.')) {
      if (m.id === request.userId) return { ok: false, error: 'You cannot moderate yourself.' };
      if (isServerSupreme(m.id, guild, config)) return { ok: false, error: `${m.displayName} is protected and cannot be moderated.` };
    }
  }
  if (params.target) {
    const r = await resolveTarget(guild, params.target, { minScore });
    if (!r.ok) return { ok: false, error: r.error };
    fuzzyNote(r.kind === 'role' ? `@${r.target.name}` : r.target.displayName, r.score);
    params.targetId = r.target.id;
    params.targetKind = r.kind;
    const isEveryone = r.kind === 'role' && r.target.id === guild.id;
    params.targetLabel = r.kind === 'role' ? (isEveryone ? '@everyone' : `@${r.target.name}`) : r.target.displayName;
    if (step.action === 'channel.permit') {
      if (isEveryone && !['deny', 'mute'].includes(params.template)) {
        risk = RISK.CRITICAL;
        warnings.push('This grants @everyone access: the channel becomes public.');
      }
      if (r.kind === 'role' && r.target.permissions?.has?.('Administrator')) {
        warnings.push(`@${r.target.name} has Administrator; channel overwrites do not restrict it.`);
      }
    }
  }
  if (step.action === 'role.bulk_assign' && params.fromRoleId) {
    const from = guild.roles.cache.get(params.fromRoleId);
    const count = from?.members?.size;
    if (count != null) warnings.push(`Affects about ${count} member(s).`);
  }
  return { ok: true, step: { action: step.action, params }, risk, warnings, deferred: false };
}
