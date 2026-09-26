import { terms } from '../plan/retrieve.js';
import { GLOSSARY_DEFAULTS, surfaceForms } from './glossary.js';
import type { ExpandOptions, Expansion, Glossary, GlossaryEntry, GlossaryMatch } from './types.js';

function entryTerms(entry: GlossaryEntry): string[] {
  const out: string[] = [];
  for (const form of surfaceForms(entry)) out.push(...terms(form));
  for (const ref of entry.refs ?? []) {
    out.push(...terms(ref.table));
    for (const column of ref.columns ?? []) out.push(...terms(column));
  }
  return out;
}

/**
 * Longest phrase wins at each position and consumes it, so an entry for "revenue" cannot fire
 * inside "monthly recurring revenue" and the more specific definition is the one that applies.
 */
export function expandQuestion(glossary: Glossary, question: string, options: ExpandOptions = {}): Expansion {
  const maxTerms = options.maxTerms ?? GLOSSARY_DEFAULTS.maxTerms;
  const asked = terms(question);
  const seen = new Set(asked);
  const matches: GlossaryMatch[] = [];
  const added: string[] = [];

  let i = 0;
  while (i < asked.length) {
    let index: number | undefined;
    let length = 0;
    for (let n = Math.min(glossary.longestPhrase, asked.length - i); n >= 1; n -= 1) {
      index = glossary.byPhrase.get(asked.slice(i, i + n).join(' '));
      if (index !== undefined) {
        length = n;
        break;
      }
    }

    const entry = index === undefined ? undefined : glossary.entries[index];
    if (index === undefined || entry === undefined) {
      i += 1;
      continue;
    }

    matches.push({ entry: index, term: entry.term, phrase: asked.slice(i, i + length).join(' ') });
    for (const term of entryTerms(entry)) {
      if (seen.has(term) || added.length >= maxTerms) continue;
      seen.add(term);
      added.push(term);
    }
    i += length;
  }

  return {
    terms: added,
    searchText: added.length === 0 ? question : `${question} ${added.join(' ')}`,
    matches,
  };
}
