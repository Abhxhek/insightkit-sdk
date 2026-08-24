# ADR 0001 — Allowlist AST node types rather than denylist them

Status: accepted, 2026-08-25

## Context

The guard must reject any SQL that is not a pure read. The obvious implementation enumerates dangerous node types (`InsertStmt`, `UpdateStmt`, `DeleteStmt`, `CopyStmt`, `GrantStmt`, ...) and rejects a statement containing any of them. The planning document specified exactly this, as a `DENY_TAGS` set.

## Decision

Invert it. Enumerate the node types a read-only analytics query may contain, and reject anything not on that list.

## Rationale

Both lists are incomplete. They differ in how they behave when they are wrong.

A denylist is fail-open against change. Postgres adds node types with each release. When `pgsql-parser` is bumped from 18 to 19 during routine maintenance, any new node type is absent from `DENY_TAGS` and therefore permitted. Nothing errors, no test fails, and the gap opens during an upgrade nobody associated with security.

An allowlist is fail-closed against the same event. The new node type is absent from `ALLOWED_TAGS`, so statements using it are denied and the corresponding tests fail loudly. A human then reads the new node type, decides, and adds it deliberately.

The cost is real: legitimate SQL using an unanticipated construct is rejected until someone extends the list. We accept that. A false deny is a support ticket; a false allow is data loss in a customer's production database.

## Consequences

- The initial list was derived empirically from a corpus of realistic analytics queries rather than guessed. 28 tags covered everything including window functions and grouping sets.
- Parser version bumps are a reviewed event. CI failure on upgrade is the designed behaviour, not a regression.
- The same posture applies to the field allowlist and the function allowlist. Dangerous items are excluded by absence, never by having been remembered.
