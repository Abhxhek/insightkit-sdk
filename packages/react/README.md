# @insightkit/react

The component a developer drops into an admin panel. It posts a question to the server, renders the answer as hand-rolled SVG, and optionally follows it live.

## The boundary

`@insightkit/protocol` and `react` are the entire import surface. `package.json` lists one dependency and one peer.

`react` may **never** import `@insightkit/core`. One `import { … } from '@insightkit/core'` inside a Next.js client component ships the database connection string into the browser bundle — not a leak that shows up in a test, a leak that shows up in someone's `main.js`. This package talks to the server over HTTP, never in process.

Enforced three ways, each of which fails `pnpm verify`:

- `.dependency-cruiser.cjs` — `browser-never-imports-engine` (`packages/react/src` must not reach `packages/(core|cli|server)`) and `browser-no-server-modules` (no `node:*`, no `pg`).
- The typecheck. `react` does not declare `@insightkit/core`, so under pnpm's strict layout a bare import cannot resolve and fails with `TS2307` — before dependency-cruiser, which reports an unresolvable import as unresolved rather than as a violation.
- `test/boundaries.test.ts` — walks every `.ts`/`.tsx` under `src/` and asserts the only `@insightkit/*` specifier anywhere is `@insightkit/protocol`, that the strings `@insightkit/core`, `@insightkit/cli` and `@insightkit/server` do not appear even in a comment, and that `dangerouslySetInnerHTML` is never used.

## Install

```sh
pnpm add @insightkit/react
```

Nothing is published to npm yet. `react >=18` is a peer dependency and is **not** optional. There is no charting dependency at all — the SVG is hand-rolled, and the stylesheet ships inside the component.

## Usage

```tsx
import { Insight } from '@insightkit/react';

export const Panel = () => (
  <Insight
    endpoint="/api/insightkit"
    question="how many users joined this week, split by signup method"
    live
  />
);
```

`endpoint` is where the server handler is mounted; the component appends `/ask` and `/subscribe` itself, because the server routes on the last path segment. A trailing slash is trimmed. `headers` adds a bearer token to the ask request, `theme` takes `'light' | 'dark' | 'auto'`, `streamEndpoint` and `intervalMs` adjust the live feed, and `fetchImpl` / `eventSourceFactory` are the injection points the tests use.

`live` only does something if the server was created with `live` enabled. Otherwise the answer carries no stream token, and the component renders it once without saying so.

Lower level, if you want your own shell: `useAsk({ endpoint, question })` returns `{ state, reload }`, `useLiveResult({ endpoint, token })` returns `{ state, reconnect }`, and `<Chart spec={…} data={…} />` renders either on its own. `ChartStyles` and `INSIGHTKIT_CSS` are exported for hosts that would rather hoist the stylesheet than let every `Frame` emit it.

## What defines it

**Numbers arrive as strings, and one that will not coerce is never zero.** [ADR 0007](../../docs/adr/0007-driver-values-cross-the-boundary-as-text.md) makes the pg adapter return `numeric`, `date`, `timestamp`, `interval` and friends as the text Postgres sent, so the chart receives `"1234.5"`, `"NaN"` and `"12345678901234567890.12"`. [ADR 0016 — Drawing numbers that arrive as text](../../docs/adr/0016-drawing-numbers-that-arrive-as-text.md) decides what each means: `toNumber` accepts decimal and scientific notation only — deliberately narrower than `Number()`, which turns `'0x10'` into 16 and `''` into 0 — and a value that fails is a **gap**. The bar is not drawn, `segmentsOf` breaks the line rather than dipping it to zero, a note under the chart counts what was left out, and the raw text survives in the table. A high-precision value that does not survive `Number().toString()` is printed exactly as it arrived.

**The x axis is spaced by row position, never a parsed date.** `new Date("2026-09-05")` is UTC midnight and `new Date("2026-09-05 00:00")` is local — the off-by-one-day bug ADR 0007 exists to prevent. Index spacing cannot be wrong about a day. ISO-ish categories are sorted lexicographically for line and area only, and only when none carries a numeric UTC offset.

**The browser is given a narrowing, and cannot ask for more.** [ADR 0012 — The wire is a narrowing](../../docs/adr/0012-the-wire-is-a-narrowing.md) means no deny code, no token count, no attempt history and no SQL unless the host opted in. `refused` is one generic sentence. `unanswerable` and `refused` render as `role="status"`; only a real breakage is `role="alert"` and only that offers a retry button.

**A contract no test names is prose.** `react` and `server` once shipped mismatched endpoints with both suites green, because neither asserted a URL. `test/use-ask.test.tsx` now renders `<Insight>` through a spy `fetchImpl` and asserts the string `/api/insightkit/ask`.

## What it does not do

- **It has never made a real HTTP round trip.** Every test injects a `fetchImpl` or a fake `EventSource` class. No network, no server, no browser.
- **The stream token travels in the query string** (`?token=…&intervalMs=…`), because `EventSource` is GET-only and cannot set a header. It is short-lived (15 minutes by default) and bound to the identity that asked, but it will appear in server access logs, proxy logs and anything else that records a URL. A host that minds must supply its own `eventSourceFactory`.
- **The bearer token does not reach the live feed at all.** `headers` applies to the ask request only. In multi-tenant mode the server resolves the tenant on `subscribe` too, so with the defaults the stream is refused with 401 and the component shows "Lost the live feed." The server must read the token from somewhere an `EventSource` carries it — a same-origin cookie, through `tokenFrom` — or the host must supply an `eventSourceFactory` that can send headers.
- **It renders, it does not collect.** No input box, no request cache: two components asking the same question issue two requests and two model calls.
- **It declines rather than inventing.** More than `MAX_SERIES` (8) series renders the table instead of folding a tail into "Other", because summing a tail is only valid if the measure is additive and a `ChartSpec` does not say. Bar charts stop at `MAX_BAR_CATEGORIES` (30) and the table at `MAX_TABLE_ROWS` (200), each with a note.
- **The rendered kind can disagree with the server's.** A single row downgrades bar, line and area to a stat tile; a spec whose `y` columns are all absent from the result falls back to a table.
- **Nothing here is an authorisation boundary.** It shows what the server sent. Scoping happens in Postgres, three packages away.
