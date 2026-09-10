# ADR 0011 — Repair an honest mistake, never an attack

Status: accepted, 2026-09-10

## Context

The planner asks a model for SQL and hands it to the guard. Sometimes the guard says no. The question is whether to tell the model why and let it try again.

Feeding the verdict back is the largest accuracy lever available: the deny codes are specific, so `E_FUNCTION_NOT_ALLOWED: pg_sleep` is a correction a model acts on well. The obvious objection is safety — and the obvious objection is wrong.

**Repair cannot make anything unsafe.** Every attempt ends at the guard; attempt five gets the same scrutiny as attempt one. There is no path where retrying admits something that would otherwise be refused.

The real objection is different, and it is the one that decides this: the guard refuses for two unrelated reasons, and only one of them is worth another attempt.

## Decision

**Repair is offered for denials a mistake produces, and refused for denials a mistake does not.**

| Never repaired | Why |
|---|---|
| `E_NOT_SELECT` | A write. A model asked to count users does not reach for `DELETE`. |
| `E_MULTI_STATEMENT` | Stacked statements — injection's signature. |
| `E_NUL_BYTE` | Nothing legitimate puts a NUL in SQL. |
| `E_ROUND_TRIP_FAILED` | Our own invariant broke; asking again cannot help. |
| `E_INTERNAL` | Our bug. |

Everything else — a parse error, a function off the allowlist, an unsupported construct, a non-literal `LIMIT` — is our allowlist being narrow or the model slipping, and is worth one more attempt. Two attempts total by default.

The reason to refuse the first group is not safety. It is that repairing an attack **hands the attacker an automated loop against the validator, billed to the host application**. Two attempts is two probes of where the boundary sits; N attempts is a free fuzzer. Refusing costs one wasted question. Allowing it leaks the shape of the defence.

**An attack-shaped denial is a security event, not a failed query.** It is reported through an `onSecurityEvent` callback carrying the question, the rejected SQL, the code and the detail, so a host can log, alert or rate-limit. Swallowing it as an ordinary error would hide the one thing the developer most needs to see. The callback is wrapped: a host logger that throws must not fail the request it is reporting on.

**A repair turn carries our verdict, never the user's text.** The correction sent back is the deny code and the guard's detail. Echoing the end user's words into a follow-up turn would give an injected instruction a second delivery route.

**The model may decline.** The plan carries `answerable`, and a false answer with a one-sentence reason is a first-class outcome. Without it a model asked about weather in a SaaS database will invent `SELECT * FROM users` and return a confident wrong chart. `answerable: true` with no SQL is treated as an invalid plan rather than a refusal — the model contradicting itself is not the same as the schema being unable to answer, and reporting it as the latter would tell the user something untrue.

**The question is a user turn, never part of the instructions.** Hygiene rather than defence — the guard is what actually stops an injected write — but it keeps hostile text out of the instruction slot, and the prompt says plainly that the question is data.

## `core` defines the provider shape rather than importing it

Adding the planner surfaced a contradiction. The architecture table said `core` may import `llm`; the enforced rule `core-never-reaches-the-browser` forbade exactly that. Rule and prose disagreed, and the rule had never fired because nothing had tried.

Resolved in favour of the rule, because weakening an enforced constraint to fit new code is the reflex this project exists to resist, and because `core` already has the pattern: `SqlClient` is declared structurally instead of importing `pg`. `ModelProvider` is now declared the same way. `core` takes on no dependency to reach a model, the planner is testable without one, and any client satisfying the shape works — `@insightkit/llm` merely happens to. A test asserts a real adapter still satisfies it, so the seam cannot drift silently.

Provider errors are read by duck-typing `kind` rather than an `instanceof`, for the same reason.

## Consequences

A repairable denial costs a second model call on the questions that hit it. Every attempt is recorded — the SQL, the outcome, the code, the tokens — so the eval corpus can answer whether repair earns that cost rather than us assuming it.

`E_FIELD_NOT_ALLOWED` is the weak spot. It covers benign unsupported clauses **and** `SELECT * INTO exfil FROM users`, which is exfiltration. It is currently treated as repairable and raises no security event, because the code alone cannot tell the two apart. The honest fix is a finer deny code in `sql-guard`; until then this classification is a heuristic, not a proof. The guard blocks both regardless.

Attempt counts, token totals and per-attempt outcomes are on every result, which is what makes a poor eval score attributable rather than merely disappointing.

## Alternatives rejected

**Never repair.** Simplest, and gives up the largest accuracy lever available for a risk that does not exist — the guard runs on every attempt either way.

**Always repair.** Automates an attacker's probe loop on the customer's token budget, and spends money asking a model to reconsider an instruction it should not have followed.

**Classify by inspecting the SQL rather than the deny code.** Would mean a second analysis of untrusted text alongside the one that already exists. The guard's verdict is the analysis; a parallel one is a second thing to get wrong.
