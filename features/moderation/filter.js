// Profanity detection with normalisation and context handling.
import { MILD, SEVERE, DEFAULT_ALLOW } from './wordlist.js';

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 6: 'g', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l', '¡': 'i' };
// Common Cyrillic/Greek look-alikes.
const CONFUSABLE = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', ɡ: 'g', ο: 'o', ν: 'v', α: 'a', ι: 'i', κ: 'k' };

export function normaliseText(text) {
  let s = String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, '')
    .toLowerCase();
  s = [...s].map((ch) => CONFUSABLE[ch] ?? ch).join('');
  // Sentence punctuation at the end of a word is not leetspeak ("shit!" ≠ "shiti").
  s = s.replace(/([a-z0-9])[!?.,;:]+(?=\s|$)/g, '$1 ');
  // Leet substitutions only inside words (keep standalone numbers).
  s = s.replace(/[a-z0-9@$!|+€£¡]+/g, (w) => (/[a-z]/.test(w) ? [...w].map((c) => LEET[c] ?? c).join('') : w));
  return s;
}

const collapseRuns = (w) => w.replace(/(.)\1+/g, '$1');

/** Tokenise, also joining spaced-out single letters ("f u c k", "f.u.c.k"). */
export function tokens(normalised) {
  const raw = normalised.split(/[^a-z]+/).filter(Boolean);
  const out = [...raw];
  let run = [];
  for (const t of raw.concat([''])) {
    if (t.length === 1) run.push(t);
    else {
      if (run.length >= 3) out.push(run.join(''));
      run = [];
    }
  }
  return out;
}

const SUFFIXES = ['', 's', 'es', 'ed', 'er', 'ers', 'ing', 'in', 'y'];

export function buildMatcher({ extraWords = [], allowWords = [] } = {}) {
  const mild = new Set(MILD.concat(extraWords.map((w) => normaliseText(w))));
  const severe = new Set(SEVERE);
  const allow = new Set(DEFAULT_ALLOW.concat(allowWords.map((w) => normaliseText(w))));
  const collapsedIndex = new Map();
  for (const [set, sev] of [[mild, 'mild'], [severe, 'severe']]) {
    for (const w of set) {
      const c = collapseRuns(w);
      if (c.length >= 4) collapsedIndex.set(c, { word: w, sev });
    }
  }

  function classify(token) {
    if (allow.has(token)) return null;
    for (const suf of SUFFIXES) {
      if (suf && !token.endsWith(suf)) continue;
      const stem = suf ? token.slice(0, -suf.length) : token;
      if (severe.has(stem)) return { word: stem, sev: 'severe' };
      if (mild.has(stem)) return { word: stem, sev: 'mild' };
    }
    const c = collapseRuns(token);
    if (c !== token && collapsedIndex.has(c)) return collapsedIndex.get(c); // "fuuuuck"
    // Embedded severe terms ("xxniggerxx"), but only long ones to avoid false positives.
    for (const w of severe) if (w.length >= 5 && token.length > w.length && token.includes(w)) return { word: w, sev: 'severe' };
    return null;
  }
  return classify;
}

/** Remove quoted lines, inline quotes and code so context can be judged. */
function stripQuotedContext(text) {
  return String(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/^>.*$/gm, ' ')
    .replace(/"[^"]{1,300}"|“[^”]{1,300}”/g, ' ');
}

/**
 * @returns {{matched:boolean, severity:'mild'|'severe'|null, terms:string[], contextual:boolean}}
 * contextual=true means every match was inside a quote/code block: such
 * messages are flagged for review instead of being punished.
 */
export function checkProfanity(text, matcherOrOpts) {
  const classify = typeof matcherOrOpts === 'function' ? matcherOrOpts : buildMatcher(matcherOrOpts);
  const scan = (t) => {
    const found = [];
    for (const tok of tokens(normaliseText(t))) {
      const hit = classify(tok);
      if (hit) found.push(hit);
    }
    return found;
  };
  const all = scan(text);
  if (!all.length) return { matched: false, severity: null, terms: [], contextual: false };
  const direct = scan(stripQuotedContext(text));
  const pool = direct.length ? direct : all;
  return {
    matched: true,
    severity: pool.some((h) => h.sev === 'severe') ? 'severe' : 'mild',
    terms: [...new Set(pool.map((h) => h.word))],
    contextual: direct.length === 0,
  };
}
