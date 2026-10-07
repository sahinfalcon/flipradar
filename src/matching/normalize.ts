const NON_WORD = /[^\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

/** Lowercase, strip accents, turn punctuation/emoji into spaces, collapse whitespace. */
export function normalizeText(text: string): string {
  return text.normalize("NFKD").replace(MARKS, "").toLowerCase().replace(NON_WORD, " ").trim().replace(/\s+/g, " ");
}

export function toWords(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ") : [];
}

/** Shared fetch key for a search: like normalizeText but keeps "+" and "-". */
export function toTermKey(keywords: string): string {
  return keywords
    .normalize("NFKD")
    .replace(MARKS, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+\-]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Every listing word plus every run of 2–3 adjacent words joined without spaces. */
function phraseSet(listingWords: string[]): Set<string> {
  const phrases = new Set<string>();
  for (let i = 0; i < listingWords.length; i += 1) {
    let joined = "";
    for (let k = 0; k < 3 && i + k < listingWords.length; k += 1) {
      joined += listingWords[i + k];
      phrases.add(joined);
    }
  }
  return phrases;
}

/** True when some phrase equals the candidate, allowing a trailing "s"/"es" on either side. */
function hasSameWord(phrases: Set<string>, candidate: string): boolean {
  if (phrases.has(candidate) || phrases.has(`${candidate}s`) || phrases.has(`${candidate}es`)) return true;
  if (candidate.endsWith("es") && phrases.has(candidate.slice(0, -2))) return true;
  if (candidate.endsWith("s") && phrases.has(candidate.slice(0, -1))) return true;
  return false;
}

/**
 * Spec §6 "Strict keyword matching": whole words only; adjacent search words or
 * adjacent listing words may be joined (up to 3); plurals allowed; one-character
 * search words that cannot be joined are ignored.
 */
export function strictKeywordMatch(keywords: string, listingText: string): boolean {
  const search = toWords(keywords);
  const phrases = phraseSet(toWords(listingText));
  let i = 0;
  while (i < search.length) {
    let consumed = 0;
    for (let k = Math.min(3, search.length - i); k >= 1; k -= 1) {
      if (hasSameWord(phrases, search.slice(i, i + k).join(""))) {
        consumed = k;
        break;
      }
    }
    if (consumed === 0) {
      if ((search[i] ?? "").length === 1) {
        i += 1;
        continue;
      }
      return false;
    }
    i += consumed;
  }
  return true;
}

/** Whole-word/phrase containment on normalised text ("locked" does not match "unlocked"). */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = normalizeText(phrase);
  if (!needle) return false;
  return ` ${normalizeText(text)} `.includes(` ${needle} `);
}
