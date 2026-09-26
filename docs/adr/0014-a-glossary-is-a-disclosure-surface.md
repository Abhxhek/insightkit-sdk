# ADR 0014 — A glossary is a disclosure surface

Status: accepted, 2026-09-27

## Context

ADR 0009 documented exactly where lexical retrieval fails:

> "what is our monthly recurring revenue by plan" ranks `accounts` first, because `plan` is one of its columns, and reaches `subscriptions` — which holds `mrr_cents` — only through a foreign key. "Monthly recurring revenue" and `mrr` share no token.

The semantic layer is where a business word is mapped to the schema. It is also where a definition lives: `deleted_at IS NULL` meaning "active" is the difference between a correct answer and a plausible wrong one.

## Decision

**A glossary entry may carry a SQL fragment, as text.** A fragment is never parsed, spliced or executed: the model reads it, writes its own query, and the guard validates *that* and re-emits from the AST. So it is not a trust boundary.

What it *is* is a **disclosure surface** — the same one ADR 0008 guards in introspection. A fragment naming `users.ssn` puts that name in a prompt even though the reader cannot see the column.

Containment is proved by composition rather than by parsing: validation checks an entry's declared refs against the schema, and a lint checks every identifier in the fragment against those refs. refs ⊆ schema and fragment ⊆ refs gives fragment ⊆ schema, without `core` asserting a property it cannot check. Reaching for `guard()` here was rejected: it validates *statements*, not expressions, so it would have been a false guarantee.

The same function powers validation and rendering, so what a host is warned about at startup is exactly what rendering leaves out. It fails closed either way, and the report says why.

**Phrase matching is a contiguous token subsequence, after both sides pass through retrieval's own `terms()`.** A bag of words would fire the MRR entry on "revenue" alone. A regex over raw text would be asymmetric with the stemmer, so "revenues" would miss. Sharing `terms()` is what makes "cost of goods sold" match a question that writes it out — "of" is dropped identically on both sides. Longest match wins and consumes its tokens, so a general term cannot dilute a specific one.

**Rendering is filtered to the tables retrieval actually chose.** An entry matched by the *question* whose table did not make the cut would define a table the model cannot see. Rendering only ever emits names taken off a selected table, so it does not depend on the host having run validation.

**Expansion is applied at the call site, not inside `retrieve.ts`.** `semantic/` imports `terms` from retrieval, so calling back would close a module cycle that `no-circular` already forbids. The expanded text goes to `selectTables` only; the planner still sends the **original** question to the model.

## Consequences

**A wrong entry is worse than no entry.** A definition in a prompt is more authoritative to a model than silence, so this layer increases the blast radius of a bad glossary. Startup validation is therefore not politeness — it is the only thing between a typo and confidently wrong answers everywhere.

It bridges **vocabulary, not paraphrase**. "MRR" and "monthly recurring revenue" work; "what are we making each month" does not. ADR 0009's rejected alternatives are not made obsolete.

Validation catches names that vanished, not meanings that drifted. An `mrr_cents` that quietly becomes a monthly average still validates.

Expansion adds terms but cannot remove them: "revenue by plan" still scores `accounts` on its `plan` column. It raises the right table above the wrong one; it does not suppress the wrong one.

The fragment lint is a lexer, not a parser. A column named `year` or `range` is skipped as a keyword, and an unanticipated construct can be a false positive that drops a fragment. It is reported, so it is visible, but an author has to look.

Whether any of this improves accuracy is exactly as unknown as retrieval's weights. The budgets are guesses awaiting the eval corpus, and deliberately conservative for that reason.
