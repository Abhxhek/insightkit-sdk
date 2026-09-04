# ADR 0007 — Values that a driver cannot convert losslessly cross the boundary as text

Status: accepted, 2026-09-05

## Context

`core` now has an adapter for node-postgres. The adapter is where a Postgres value stops being wire bytes and becomes a JavaScript value, and that conversion is not neutral: node-postgres applies a type parser per column OID, and several of those parsers change the value's meaning.

Probing the parsers directly, in `Asia/Calcutta`:

| Postgres type | sent by the server | node-postgres returns | after `JSON.stringify` |
|---|---|---|---|
| `date` | `2026-09-05` | `Date` at local midnight | `"2026-09-04T18:30:00.000Z"` |
| `timestamp` | `2026-09-05 13:45:00` | `Date` read as local time | `"2026-09-05T08:15:00.000Z"` |
| `numeric` | `12345678901234567890.12` | `"12345678901234567890.12"` | exact |
| `numeric[]` | `{1.5,2.5}` | `[1.5, 2.5]` | precision dropped |

The first row is the one that matters. "Group by day" is the most common shape a question takes in this product, and a `date` column serialised for a chart arrives a day early anywhere east of UTC. There is no error and no warning; the axis is simply wrong, and it is wrong as a function of the *server's* timezone, so it passes on a UTC CI runner and fails in production in India.

The second row is a different failure: `timestamp without time zone` carries no offset by definition, and the driver supplies one anyway.

The fourth is an inconsistency inside the driver — the scalar `numeric` parser is careful to return a string precisely so precision survives, and the array parser then throws that away.

## Decision

**The adapter returns the text Postgres sent for any type whose driver conversion loses or invents information.** Everything else keeps the driver's parsing, which is correct and convenient.

Text: `date`, `time`, `timetz`, `timestamp`, `timestamptz`, `interval`, `bytea`, `numeric[]`, and the array form of each.

Unchanged: integers stay numbers, `bool` stays boolean, `json`/`jsonb` stay objects, `int8` and scalar `numeric` stay strings (the driver already does the right thing), ordinary arrays stay arrays.

The test for inclusion is *does the value survive `JSON.stringify` and mean the same thing on the other side*. A `Date` does not, because it is an instant and the things being represented — a calendar day, a wall-clock reading — are not.

**Converting is the presentation layer's job.** The browser knows the viewer's timezone; the server does not, and guessing is what produces the bug above.

**The registry is per-query, never global.** node-postgres reads `config.types` per query and falls back to the process-wide registry otherwise (`pg/lib/result.js`). Calling `pg.types.setTypeParser` would have been shorter and would have silently changed the behaviour of every other query in the host application. A library does not get to do that.

**`pg` is an optional peer dependency behind a subpath.** The adapter lives at `@insightkit/core/pg`; the main entry does not reference `pg`, so a consumer on another driver installs nothing extra and `core` stays testable without a database. The client shape in `core/src/types.ts` is still structural — this adapter is an implementation of it, not a replacement for it.

**A pool with no `connectionTimeoutMillis` is rejected.** With it unset, an exhausted pool waits forever, so one slow query turns every later request into a hang rather than an error. Analytics endpoints are reachable by whoever can ask a question, which makes an unbounded wait an availability problem and not merely an ergonomic one. Failing closed here matches how the rest of the reader path already behaves.

## Consequences

An `int8`, a `numeric`, a date and a timestamp all arrive as strings. Consumers must not assume a column is a JS number because it holds a number; the eval comparator already coerces numeric strings for exactly this reason.

Array-typed temporal columns arrive as the raw Postgres array literal — `{2026-09-05,2026-09-06}` — rather than as a JavaScript array, because keeping the array shape would mean parsing elements ourselves or taking a dependency to do it. This is a visible oddity rather than a silent wrong answer, which is the correct direction to fail, but it is a real gap: if these columns turn out to be common, the fix is element-wise parsing, not reverting to the driver default.

Rejecting a pool that omits `connectionTimeoutMillis` will break a consumer with an existing pool. The error names the option and the reason.

## Alternatives rejected

**Return everything as text.** Total fidelity, no driver dependency at all, and the column OIDs are available to convert downstream. Rejected because every consumer then reimplements integer and boolean parsing, and the common case — a count on a bar chart — becomes a string for no benefit.

**Keep the driver defaults and document the hazard.** Rejected because the failure is silent and the documentation would be read after the wrong chart shipped.

**Set the process timezone to UTC.** Makes `date` round-trip by accident, still invents an offset for `timestamp`, and reaches outside our own package to do it.
