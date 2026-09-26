import { terms } from '../plan/retrieve.js';
import type { Glossary, GlossaryEntry } from './types.js';

export const GLOSSARY_DEFAULTS = {
  maxTerms: 32,
  maxTokens: 500,
  maxEntries: 20,
  maxSqlLength: 200,
} as const;

/**
 * Retrieval's own normalisation, joined into one key. Both sides of the match reduce through
 * the same function, so a phrase matches a phrase and nothing has to agree about stemming.
 */
export const phraseKey = (text: string): string => terms(text).join(' ');

export const surfaceForms = (entry: GlossaryEntry): readonly string[] => [
  entry.term,
  ...(entry.synonyms ?? []),
];

export function defineGlossary(entries: readonly GlossaryEntry[]): Glossary {
  const byPhrase = new Map<string, number>();
  let longestPhrase = 0;
  for (const [i, entry] of entries.entries()) {
    for (const form of surfaceForms(entry)) {
      const key = phraseKey(form);
      if (key === '' || byPhrase.has(key)) continue;
      byPhrase.set(key, i);
      longestPhrase = Math.max(longestPhrase, key.split(' ').length);
    }
  }
  return { entries: [...entries], byPhrase, longestPhrase };
}
