# ADR 0016 — Drawing numbers that arrive as text

Status: accepted, 2026-09-29

## Context

`packages/react` is the only component that renders data, and it inherits a contract most charting code does not expect. ADR 0007 made the pg adapter return `bigint`, `numeric`, `float4`, `float8`, `date`, `timestamp`, `interval` and `bytea` as **strings**, because `JSON.stringify` corrupts a `Date` and rewrites `NaN` and the infinities to `null`.

So the chart receives `"1234.5"`, `"NaN"`, `"2026-09-05"` and `"12345678901234567890.12"`, and has to decide what each means on an axis.

## Decision

**A value that will not coerce is never zero.** Coercion accepts decimal and scientific notation only — deliberately narrower than `Number()`, which turns `'0x10'` into 16 and `''` into 0. A value that fails is rendered as a *gap*, not a point:

- a bar is not drawn (a missing bar and a zero-length bar look different, and the category label remains)
- a line breaks into segments, so a gap reads as a gap rather than a dip to zero
- a note under the chart counts them: *"1 of 5 values could not be read as a number and are left out of the chart, not drawn as zero"*
- the value stays in the table fallback as the text that arrived

`"NaN"` is a real Postgres value but has no position on a number line, so it is treated as any other non-coercible string. Never zero, never the axis minimum.

**High-precision values print exactly.** A value is round-tripped through `Number().toString()`; if it differs, the original text is shown. `"12345678901234567890.12"` stays exact on a stat tile instead of becoming `12345678901234567000`.

**The x axis is spaced by row position, never by a parsed date.** `new Date("2026-09-05")` is UTC midnight while `new Date("2026-09-05 00:00")` is local — which reintroduces exactly the off-by-one-day bug ADR 0007 exists to prevent. Index spacing cannot be wrong about a day. The cost is that unevenly sampled series are drawn evenly spaced; the alternative fails silently and timezone-dependently, which is the worst shape of bug this product can ship.

ISO-ish values are sorted lexicographically for line and area only, and only when none carries a numeric UTC offset — `2026-01-01T00:00+05:30` sorts before `2025-12-31T23:00Z` lexically, and that would be a silently wrong axis. Bar order is left as the server sent it, since a bar chart's order is usually a ranking the SQL chose.

**Zero charting dependency.** Hand-rolled SVG. A charting library would be forced on every host application, which this repo's dependency discipline does not accept.

**A table always exists behind the visual**, in a collapsed `<details>` so it is in the DOM, findable and printable. That is both the accessibility fallback and the relief channel the palette requires.

**`unanswerable` and `refused` are `role="status"`, not `role="alert"`.** Only a real breakage is an alert. "The schema cannot answer this" is an answer, and the accessibility tree should say so.

**More than eight series renders the table instead of folding a tail into "Other".** Summing a tail is only valid if the measure is additive, and a `ChartSpec` does not say whether it is — an average folded that way is silently wrong. Declining to chart beats inventing a number.

**A single row downgrades bar/line/area to a stat tile.** A one-bar bar chart is not a chart. The consequence worth knowing: the rendered form can disagree with the server's `kind`.

## Consequences

The package renders but does not collect: there is no input box, no request cache, and two components asking the same question issue two model calls.

The stream token travels in a query string because `EventSource` is GET-only and cannot set headers, so **it will appear in server access logs**. A host that minds must supply a cookie-based token source.

Nothing here has made a real HTTP round-trip. Every test injects a fetch and a fake `EventSource`, which matches the repo's standing position that nothing has run against a real Postgres either.
