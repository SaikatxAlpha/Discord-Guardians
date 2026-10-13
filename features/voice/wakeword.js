// Configurable wake word with strict, safe fuzzy matching, plus transcript
// normalisation. Fuzzy matching is used ONLY to recognise the activation
// word; it never authorises anything and never picks a moderation target.
import { levenshtein } from '../../core/discord/resolve.js';

const FILLERS = new Set(['hey', 'hi', 'ok', 'okay', 'um', 'umm', 'uh', 'so', 'yo', 'and', 'oh']);
// Known spelling variants Whisper produces for the default wake word.
const KNOWN_VARIANTS = { alpha: ['alfa', 'alpa', 'alpha', "alpha's", 'alphaa'] };

const fold = (s) => String(s).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();

/** Transcript clean-up that never changes meaning: unicode, quotes, spacing, trailing punctuation. */
export function normaliseTranscript(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(/[“”„«»"]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[,.;:!?\-–— ]+/, '')
    .replace(/[.!?…]+$/, '')
    .trim();
}

// Whole-command corrections for frequent mis-hearings of single-word
// commands. Applied only when the entire command matches, never to names.
const COMMAND_FIXES = [
  [/^(?:paws|pours|pores|paus)$/i, 'pause'],
  [/^(?:skips?|skipped|skip it|skip this)$/i, 'skip'],
  [/^(?:show (?:me )?the (?:cue|q|queues?)|(?:cue|q))$/i, 'show the queue'],
  [/^(?:resumed?|resume it|resume music|continue playing)$/i, 'resume'],
  [/^(?:stop the music|stop music|stop playing)$/i, 'stop music'],
  [/^time out\b/i, 'timeout'],
];

export function fixCommonMishearings(command) {
  let c = command;
  for (const [re, rep] of COMMAND_FIXES) c = c.replace(re, rep);
  return c;
}

export function buildWakeMatcher(wakeWord = 'ALPHA') {
  const target = fold(wakeWord);
  const variants = new Set([target, ...(KNOWN_VARIANTS[target] ?? [])]);
  // Edit distance 1 is tolerated only for longer wake words, with the same
  // first letter, so short everyday words cannot activate ALPHA.
  const isWake = (token) => {
    const t = fold(token).replace(/[^\p{L}\p{N}']/gu, '');
    if (!t) return false;
    if (variants.has(t)) return true;
    return target.length >= 5 && t[0] === target[0] && Math.abs(t.length - target.length) <= 1 && levenshtein(t, target) <= 1;
  };

  /**
   * @returns {{activated:boolean, command:string}}
   */
  function detect(transcript) {
    const t = normaliseTranscript(transcript);
    if (!t) return { activated: false, command: '' };
    const tokens = t.split(/\s+/);
    // Wake word must be the first word, optionally after up to two fillers.
    for (let i = 0; i < Math.min(3, tokens.length); i++) {
      if (isWake(tokens[i])) {
        // The token must be a standalone word ("alphabet" is not "alpha").
        const rest = tokens.slice(i + 1).join(' ').replace(/^[,.;:!?\-–— ]+/, '').trim();
        return { activated: true, command: fixCommonMishearings(normaliseTranscript(rest)) };
      }
      if (!FILLERS.has(fold(tokens[i]).replace(/[^\p{L}]/gu, ''))) break;
    }
    return { activated: false, command: '' };
  }
  return { detect, isWake, wakeWord };
}
