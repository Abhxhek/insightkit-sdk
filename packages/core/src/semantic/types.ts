export interface GlossaryRef {
  /** Omitted resolves by table name alone, and is a problem when more than one matches. */
  readonly schema?: string;
  readonly table: string;
  readonly columns?: readonly string[];
}

export interface GlossaryEntry {
  /** The business word as a person says it. Matched case-insensitively, as a whole phrase. */
  readonly term: string;
  readonly synonyms?: readonly string[];
  /** A sentence or two, rendered into the prompt as written. */
  readonly definition?: string;
  /** What the term is about. An entry with no refs at all is global and always rendered. */
  readonly refs?: readonly GlossaryRef[];
  /** An expression that defines the term. Prompt text: it is never parsed, spliced or executed. */
  readonly sql?: string;
}

export interface Glossary {
  readonly entries: readonly GlossaryEntry[];
  /** Normalised phrase to the index of the entry claiming it. The first claimant wins. */
  readonly byPhrase: ReadonlyMap<string, number>;
  readonly longestPhrase: number;
}

export type FragmentProblemCode = 'sql_unsafe' | 'sql_too_long' | 'sql_unknown_identifier';

export type GlossaryProblemCode =
  | FragmentProblemCode
  | 'unknown_table'
  | 'unknown_column'
  | 'ambiguous_table'
  | 'duplicate_term'
  | 'unsearchable_term'
  | 'empty_entry'
  | 'sql_without_refs'
  | 'globals_exceed_budget';

export interface FragmentIssue {
  readonly code: FragmentProblemCode;
  readonly detail: string;
}

export interface GlossaryProblem {
  readonly code: GlossaryProblemCode;
  /** An error names something that does not exist or must not be shown. A warning is dropped work. */
  readonly severity: 'error' | 'warning';
  /** Index into `Glossary.entries`, or -1 for a problem about the glossary as a whole. */
  readonly entry: number;
  readonly term: string;
  readonly detail: string;
}

export interface GlossaryReport {
  /** True when nothing of error severity was found. Warnings are still worth surfacing. */
  readonly ok: boolean;
  readonly problems: readonly GlossaryProblem[];
}

export interface GlossaryValidateOptions {
  readonly maxSqlLength?: number;
  /** The budget rendering will be given, so global entries can be checked against it. */
  readonly maxTokens?: number;
}

export interface GlossaryMatch {
  readonly entry: number;
  readonly term: string;
  /** The normalised phrase the question used, which may be a synonym. */
  readonly phrase: string;
}

export interface Expansion {
  /** Extra search terms, normalised as retrieval normalises, minus what the question already has. */
  readonly terms: readonly string[];
  /** The question with those terms appended. For `selectTables` only — never send it to a model. */
  readonly searchText: string;
  readonly matches: readonly GlossaryMatch[];
}

export interface ExpandOptions {
  /** Cap on added terms, so a question hitting many entries cannot flatten the ranking. */
  readonly maxTerms?: number;
}

export interface GlossarySection {
  /** Empty when nothing was relevant. Append it to the prompt as additional context. */
  readonly text: string;
  readonly included: readonly string[];
  readonly omitted: number;
  readonly estimatedTokens: number;
}

export interface GlossaryRenderOptions {
  readonly maxTokens?: number;
  readonly maxEntries?: number;
  readonly maxSqlLength?: number;
  readonly includeSql?: boolean;
}
