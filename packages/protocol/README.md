# @insightkit/protocol

The wire contract between an InsightKit browser client and an InsightKit server: zod schemas, the types inferred from them, and parse functions that return a result instead of throwing.

## The boundary

`protocol` depends on `zod` and nothing else. It may not import a Node builtin, a database driver, or any other workspace package — `protocol-stays-portable` in [`.dependency-cruiser.cjs`](../../.dependency-cruiser.cjs) forbids all three, because the same module is bundled into a browser and loaded on a server, and anything that only runs in one of those places breaks the other.

`pnpm --filter @insightkit/protocol list --prod --depth Infinity` reports **1 package**: `zod@4.6.5`.

The more important boundary is the one in the *shapes*. `protocol` is a narrowing of what the server knows, not a re-export of it. There is no deny code on the wire, no token count, no attempt history, and no SQL unless the host opts in. `@insightkit/core` does not depend on this package at all: it declares its own `ChartSpec` and `ResultSet`, alongside a `PlanResult` carrying attempt history, token usage and guard deny codes. Translating the first two and dropping the rest is a deliberate step in `@insightkit/server`.

## Install

```bash
pnpm add @insightkit/protocol
```

No peer dependencies. Isomorphic — no Node builtins, no DOM.

## Usage

```ts
import { parseAskResponse, PROTOCOL_VERSION } from '@insightkit/protocol';

PROTOCOL_VERSION; // 1

const payload = {
  status: 'ok',
  protocol: 1,
  chart: { kind: 'bar', x: 'wk', y: ['n'], series: null, title: 'Signups' },
  data: { columns: ['wk', 'n'], rows: [['2026-09-29', '412']] },
  truncated: false,
};

parseAskResponse(payload);
// { ok: true, value: { status: 'ok', protocol: 1, chart: { … }, data: { … }, truncated: false } }

// the same payload with one extra field the server was never supposed to send
parseAskResponse({ ...payload, denyCode: 'E_NOT_SELECT' });
// {
//   ok: false,
//   error: 'Unrecognized key: "denyCode"',
//   issues: [ { path: '', message: 'Unrecognized key: "denyCode"' } ]
// }
```

Four response shapes discriminated on `status` — `ok`, `unanswerable`, `refused`, `error` — plus `AskRequest`, `ResultSet`, `ChartSpec`, `Cell`, and the live-update events (`StreamSnapshot`, `StreamError`, `StreamClosed`, `SubscribeRequest`). Every schema has a matching `parse*` helper; all of them return `ParseResult<T>` and none of them throw.

## What defines it

**Strict objects, because strictness protects the sender.** Every object schema is `z.strictObject`, so an unexpected key is an error rather than something quietly stripped. Stripping protects the *receiving* end — by which point the JSON has already crossed. Being strict turns a leak into a 500 on the server that was about to commit it. See [ADR 0012 — The wire is a narrowing, not a re-export](../../docs/adr/0012-the-wire-is-a-narrowing.md).

**Statuses are deliberately uninformative.** `refused` and `unanswerable` and `error` each carry one prose `message` and nothing else. `E_NOT_SELECT` arriving at a client would tell an attacker their probe was detected *and classified*, which is an oracle; so would an HTTP status that varied by outcome, which is why `@insightkit/server` answers 200 for all four. Same ADR 0012.

**Cells are JSON values, never `Date`.** `Cell` is `JsonValue`. The reader path hands `date`, `time`, `timestamp`, `interval`, `bytea`, `numeric` and the float types over as the text Postgres sent, so a `Date` reaching this layer means a driver conversion escaped — see [ADR 0007 — Values that a driver cannot convert losslessly cross the boundary as text](../../docs/adr/0007-driver-values-cross-the-boundary-as-text.md). `StreamSnapshot.at` is an ISO 8601 *string* for the same reason.

**A stream token is handed back, never constructed.** `subscribeRequestSchema` takes an opaque token the server issued and an `intervalMs` hint the server is free to clamp (1s to 1h). A client cannot name a query it wants live rows for — the same instinct as the guarded-query brand in `core`.

**Protocol version is readable without parsing.** `protocolVersionOf(value)` plucks `protocol` off an unknown object so a version mismatch reports as a version mismatch rather than as a schema failure.

## What it does not do

- **It does not validate anything about your data.** `ResultSet` checks only that every row has one cell per column. Column names, types and meanings are not its business.
- **It does not define the HTTP surface.** No paths, no methods, no status codes, no headers. A schema here cannot stop a client and a server disagreeing about which URL to use — that has to be asserted by a test on one of them.
- **It is not a security boundary.** It narrows what *can* be expressed, which stops an accidental disclosure; it does not authenticate, authorise or rate-limit.
- **It does not do versioning beyond a single integer.** `PROTOCOL_VERSION` is `1`. There is no negotiation, no deprecation window and no migration path yet.
- **It has never been exercised against a real deployment.** Every test (`npx vitest run packages/protocol` from the repo root) runs against a value constructed in the test.
