// Resolve free-text references ("gaming", "#gaming", "<@123>", "John") to
// exact Discord entities. Ambiguous matches are reported, never guessed.

export function normName(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Rank candidates by name similarity.
 * @param {Iterable<any>} items
 * @param {(item:any)=>string[]} namesOf all names an item can be called by
 */
export function fuzzyFind(items, query, namesOf) {
  const q = normName(query);
  if (!q) return { match: null, candidates: [] };
  const scored = [];
  for (const item of items) {
    let best = 0;
    for (const raw of namesOf(item)) {
      const n = normName(raw);
      if (!n) continue;
      let score = 0;
      if (n === q) score = 100;
      else if (n.startsWith(q) || n.endsWith(q)) score = 80 - Math.min(20, n.length - q.length);
      else if (n.includes(q)) score = 60 - Math.min(20, n.length - q.length);
      else if (q.length >= 4) {
        const d = levenshtein(n, q);
        if (d <= Math.max(1, Math.floor(q.length / 4))) score = 50 - d * 10;
      }
      best = Math.max(best, score);
    }
    if (best > 0) scored.push({ item, score: best });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) return { match: null, candidates: [] };
  const top = scored[0];
  const tied = scored.filter((s) => s.score === top.score);
  if (tied.length > 1) return { match: null, ambiguous: true, candidates: tied.slice(0, 5).map((s) => s.item) };
  // Weak fuzzy matches are only accepted when clearly better than the runner-up.
  if (top.score < 60 && scored[1] && scored[1].score >= top.score - 5) {
    return { match: null, ambiguous: true, candidates: scored.slice(0, 5).map((s) => s.item) };
  }
  return { match: top.item, score: top.score, candidates: scored.slice(0, 5).map((s) => s.item) };
}

const idFrom = (ref, re) => {
  const m = re.exec(String(ref).trim());
  return m ? m[1] : null;
};

/**
 * Apply a minimum match quality. Exact name = 100, prefix/suffix ≈ 60–80,
 * substring ≈ 40–60, typo-tolerant ≤ 50. Weak matches are reported as a
 * suggestion instead of being used.
 */
function enforceMinScore(r, minScore, label, describe) {
  if (!r.match || (r.score ?? 100) >= minScore) return r;
  return { match: null, weak: true, error: `I'm not certain which ${label} you mean. Did you mean ${describe(r.match)}? Please use its exact name or mention it.` };
}

const CHANNEL_TYPE_NAMES = { 0: 'text', 2: 'voice', 4: 'category', 5: 'announcement', 13: 'stage', 15: 'forum' };

export async function resolveChannel(guild, ref, { types, minScore = 0 } = {}) {
  if (!ref) return { ok: false, error: 'No channel specified.' };
  const id = idFrom(ref, /^(?:<#)?(\d{17,20})>?$/);
  if (id) {
    const ch = guild.channels.cache.get(id) ?? (await guild.channels.fetch(id).catch(() => null));
    return ch ? { ok: true, channel: ch } : { ok: false, error: `Channel ${ref} was not found.` };
  }
  let pool = [...guild.channels.cache.values()];
  if (types) pool = pool.filter((c) => types.includes(CHANNEL_TYPE_NAMES[c.type]));
  const r = enforceMinScore(fuzzyFind(pool, ref, (c) => [c.name]), minScore, 'channel', (c) => `#${c.name}`);
  if (r.weak) return { ok: false, error: r.error };
  if (r.match) return { ok: true, channel: r.match, score: r.score };
  if (r.ambiguous) return { ok: false, error: `"${ref}" matches several channels: ${r.candidates.map((c) => `#${c.name}`).join(', ')}. Please be specific.` };
  return { ok: false, error: `No channel named "${ref}" was found.` };
}

export async function resolveRole(guild, ref, { minScore = 0 } = {}) {
  if (!ref) return { ok: false, error: 'No role specified.' };
  if (ref === '@everyone' || /^everyone$/i.test(ref)) return { ok: true, role: guild.roles.everyone };
  const id = idFrom(ref, /^(?:<@&)?(\d{17,20})>?$/);
  if (id) {
    const role = guild.roles.cache.get(id) ?? (await guild.roles.fetch(id).catch(() => null));
    return role ? { ok: true, role } : { ok: false, error: `Role ${ref} was not found.` };
  }
  const pool = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id);
  const r = enforceMinScore(fuzzyFind(pool, ref, (x) => [x.name]), minScore, 'role', (x) => `@${x.name}`);
  if (r.weak) return { ok: false, error: r.error };
  if (r.match) return { ok: true, role: r.match, score: r.score };
  if (r.ambiguous) return { ok: false, error: `"${ref}" matches several roles: ${r.candidates.map((x) => `@${x.name}`).join(', ')}. Please be specific.` };
  return { ok: false, error: `No role named "${ref}" was found.` };
}

export async function resolveMember(guild, ref, { minScore = 0 } = {}) {
  if (!ref) return { ok: false, error: 'No member specified.' };
  const id = idFrom(ref, /^(?:<@!?)?(\d{17,20})>?$/);
  if (id) {
    const m = guild.members.cache.get(id) ?? (await guild.members.fetch(id).catch(() => null));
    return m ? { ok: true, member: m } : { ok: false, error: `Member ${ref} was not found in this server.` };
  }
  const names = (m) => [m.displayName, m.nickname, m.user?.username, m.user?.globalName].filter(Boolean);
  let r = fuzzyFind(guild.members.cache.values(), ref, names);
  if (!r.match && !r.ambiguous) {
    // Not cached: ask Discord (requires the Guild Members intent).
    const fetched = await guild.members.fetch({ query: String(ref).slice(0, 32), limit: 10 }).catch(() => null);
    if (fetched?.size) r = fuzzyFind(fetched.values(), ref, names);
  }
  r = enforceMinScore(r, minScore, 'member', (m) => m.displayName);
  if (r.weak) return { ok: false, error: r.error };
  if (r.match) return { ok: true, member: r.match, score: r.score };
  if (r.ambiguous) return { ok: false, error: `"${ref}" matches several members: ${r.candidates.map((m) => m.displayName).join(', ')}. Use a mention or ID.` };
  return { ok: false, error: `No member named "${ref}" was found.` };
}

/** Channel permission target: a role first, then a member. */
export async function resolveTarget(guild, ref, opts = {}) {
  const role = await resolveRole(guild, ref, opts);
  if (role.ok) return { ok: true, kind: 'role', target: role.role, score: role.score };
  const member = await resolveMember(guild, ref, opts);
  if (member.ok) return { ok: true, kind: 'member', target: member.member, score: member.score };
  if (role.error?.startsWith("I'm not certain")) return { ok: false, error: role.error };
  if (member.error?.startsWith("I'm not certain")) return { ok: false, error: member.error };
  return { ok: false, error: `No role or member named "${ref}" was found.` };
}

export { CHANNEL_TYPE_NAMES };
