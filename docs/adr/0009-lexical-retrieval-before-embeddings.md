# ADR 0009 — Retrieval starts lexical, and the schema goes into the prompt as DDL

Status: accepted, 2026-09-05

## Context

Introspection returns every table the reader can see. A customer with 200 tables produces far more than fits in a prompt, and stuffing it in anyway is not merely expensive — a model given 200 tables picks the wrong one more often than a model given eight. So something has to choose, and something has to decide what the chosen tables look like as text.

Neither problem has an obviously correct answer, and both are cheap to change later. What matters now is not being wrong in a way that is expensive to undo.

## Decision

**The schema is rendered as Postgres DDL.** `CREATE TABLE public.users (...)` with `PRIMARY KEY` and `FOREIGN KEY` lines, comments preserved inline, and a row estimate above each table.

A model has seen orders of magnitude more `CREATE TABLE` than any format we could invent, so the representation costs no explanation. It is also readable by a person, which matters when a plan comes back wrong and the first question is what the model was actually told.

Two details are load-bearing. **Comments are kept**, because a column comment is the only place the database records what a name does not say — `deleted_at -- soft delete; null means active` is the difference between a correct answer and a plausible wrong one. **Foreign keys are only rendered when both tables are present**, since a `REFERENCES` pointing at a table the prompt never describes invites a join against something the model cannot see.

**Retrieval is lexical, not vector.** Question and schema are tokenised the same way — snake_case and camelCase split, stopwords dropped, crude plural stemming — and tables are scored by overlap, weighted: table name 10, column name 3, table comment 2, column comment 1. Each distinct question term contributes at most once, so repetition cannot dominate.

**A match pulls in its foreign key neighbours.** Retrieving `orders` without `users` makes the join the question needs impossible to express. One hop by default.

**When nothing matches, say so.** `matched: false` is part of the result, and the fallback is the most foreign-key-connected tables rather than whatever sorts first — a hub table is a better guess than an alphabetical accident. Returning nothing would be worse: the planner would have no schema at all.

**The budget is enforced by rendering.** Tables are added one at a time and the candidate set is re-rendered, so the token estimate is measured on the actual output rather than approximated from table metadata. At most a dozen tables, so the repeated rendering costs nothing. At least one table is always returned, even if it alone exceeds the budget, because a prompt with no schema cannot produce SQL.

## Consequences

**The obvious limitation is vocabulary.** Asked "what is our monthly recurring revenue by plan", retrieval scores `accounts` first — `plan` is one of its columns — and reaches `subscriptions`, which holds `mrr_cents`, only through the foreign key. "Monthly recurring revenue" and `mrr` share no token. Lexical matching cannot know they are the same thing.

That is not a bug to fix here. It is the semantic layer's entire purpose, and the failure is visible and explicable rather than mysterious. Until that layer exists, foreign key expansion is what rescues these cases, which is a good reason to keep it on by default.

Weights and defaults are guesses. They are guesses that can be measured, once the eval corpus has a planner to run against; tuning them by intuition before then would be inventing evidence.

Retrieval is deterministic and pure, so an eval run reproduces exactly and a regression is attributable.

## Alternatives rejected

**Embeddings over table and column descriptions.** Almost certainly better on vocabulary mismatch, which is the known weakness. Rejected *for now*, not on merit: it needs an embedding model, somewhere to store vectors, an invalidation story when the schema changes, and a network call on a path that currently has none. It also cannot be evaluated yet — there is no planner to measure an improvement against, so adopting it now would mean taking on real infrastructure on the strength of an assumption. The interface returns a `Selection`, so swapping the scoring underneath changes nothing above it.

**Send the whole schema and let the model choose.** Works for a ten-table demo and fails for the customer this product is aimed at. It also gets more expensive per question forever.

**Let the model ask for tables it wants, in a second round trip.** Plausible, and probably good. Rejected as premature: it doubles latency and cost per question, and it should be judged against a measured baseline rather than instead of one.
