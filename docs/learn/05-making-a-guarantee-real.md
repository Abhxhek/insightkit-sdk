# 05 — Turning a claim about text into a claim about the database

The README says user-derived SQL can only read, and lists four mechanisms. Until now exactly one of them existed. The guard reasons about **SQL text**; it has no idea whether the connection it advises can write, and it never touches a database.

This chapter is about the other three, and about a question worth asking of any security design: *what stops someone from simply not using it?*

## The gap nobody writes down

A validator that returns a verdict is only a defence if something makes you act on the verdict. Nothing did. A developer with a connection pool in scope could write:

```ts
const rows = await pool.query(modelOutput);
```

and every test would still pass, because no test knows that line exists.

This is the most common way security components fail in practice. Not defeated — **bypassed**, by someone in a hurry who did not know the component was load-bearing.

So the design question is not "is the guard correct?" It is "can the guard be skipped?"

## Capabilities instead of conventions

The fix is to make the dangerous thing **unobtainable** rather than discouraged.

```ts
const reader = asReaderSource(pool);
const approval = approve(guard, sql);
if (!approval.ok) return reject(approval.code);
const result = await runGuardedRead(reader, approval.query);
```

Three things are going on.

**The wrapper removes the shortcut.** `asReaderSource` does not tag your pool, it returns a *new object* exposing only `connect()`. A driver pool also has `query()` — hand that through and you have left an unsealed path to the database sitting in plain sight. The wrapper deletes it. You cannot use the reader source to run an arbitrary string, because the method is not there.

**Reader and admin are different types.** They have identical shapes, so structural typing would happily accept one for the other. A brand makes them distinct:

```ts
await runGuardedRead(adminSource, query);
//                   ^^^^^^^^^^^ compile error
```

The mistake this prevents is not exotic. It is grabbing the wrong variable because both were in scope.

**A guarded query cannot be fabricated.** `runGuardedRead` will not take a string. Its parameter type is `GuardedQuery`, and only `approve()` returns one. There is exactly one remaining route — a cast:

```ts
runGuardedRead(reader, { sql: userInput } as GuardedQuery)
```

which is why the brand is a **real runtime symbol** rather than a phantom type. The cast satisfies the compiler and then throws:

```
TypeError: runGuardedRead requires a query produced by approve; it was handed a plain object
```

That combination is the point. Compile-time branding stops the accident; the runtime symbol stops the deliberate shortcut. And what remains — a genuine `as` cast — is *greppable*, in a file CODEOWNERS already gates. An object literal is not.

> **The pattern: when a rule matters, make breaking it require a visible, unusual act.** Not impossible. Visible.

## The sealed transaction

Everything the reader runs is wrapped like this:

```sql
BEGIN READ ONLY
SET LOCAL statement_timeout = '15000ms'
SET LOCAL lock_timeout = '2000ms'
SET LOCAL idle_in_transaction_session_timeout = '30000ms'
SET LOCAL row_security = on
SET LOCAL search_path = "pg_catalog", "public"
SHOW transaction_read_only
<the deparsed sql>
ROLLBACK
```

Five decisions worth understanding.

**`BEGIN READ ONLY` is a second, independent layer.** If the guard were somehow wrong, Postgres itself refuses the write. The guard and the database disagree about *how* to be safe, which is exactly what defence in depth means — two mechanisms that fail for different reasons.

**`SET LOCAL`, never `SET`.** `SET` changes the session. With a connection pool that session is handed to the next request, carrying your settings. `SET LOCAL` is scoped to the transaction and reverts on rollback. This is the difference between a timeout that protects one query and a timeout that silently leaks onto somebody else's.

**`pg_temp` is deliberately absent from the search path.** A writable temp schema on the search path lets an attacker define a function that *shadows* a real one — the CVE-2018-1058 class. Leaving it off is a one-word decision that closes a whole family of attacks, and it is invisible unless you know to look for it.

**`SHOW transaction_read_only` — because sending a command is not the same as it having worked.** This costs one round trip and converts "we sent `BEGIN READ ONLY`" into "the server agrees this transaction cannot write." There is no option to turn it off, on the principle that a defence with a switch eventually gets switched.

**`ROLLBACK` always — including when everything succeeded.**

This is the one that looks wrong at first. Why roll back a successful read?

Because a read-only transaction has nothing to commit, and rolling back unconditionally buys an invariant that is worth more than the tidiness: **`COMMIT` does not appear anywhere in the reader path.** Not in a branch, not in an error handler, not behind a flag. A reviewer can confirm it with grep, and a test asserts it directly:

```ts
expect(log.some(s => /commit/i.test(s))).toBe(false);
```

Compare the alternative — commit on success, roll back on failure. Now correctness depends on the error handling being right in every path, forever. The unconditional version cannot be got wrong.

## Interpolation you cannot avoid

`SET LOCAL` does not accept bind parameters. The values have to go into the SQL text. That is a small injection surface, and it is real:

```ts
`SET LOCAL search_path = ${schemaFromConfig}`   // config is not always trusted
```

The response is to **fail closed rather than escape cleverly**. Schema names must match a plain identifier pattern; anything else throws. Timeouts must be integers inside a sane range; anything else throws.

```ts
sessionPreamble({ searchPath: ['public"; DROP TABLE users --'] })
// RangeError: unsafe identifier in search path
```

Escaping tries to make hostile input safe. Validation refuses to accept it. When you have a fixed, small set of legitimate values, validation is strictly better, because being wrong about your escaping is a vulnerability while being wrong about your validation is a support ticket.

## Proving it rather than asserting it

The last layer is the database's own configuration, and the only honest way to know it is right is to ask the database.

`proveIsolation` runs a set of catalog queries and grades them. Five are **blocking** — the proof fails:

| | |
|---|---|
| A1 | the reader holds no privilege other than `SELECT` |
| A2 | the reader is a member of no `pg_*` predefined role |
| A3 | no role carries `SUPERUSER`, `BYPASSRLS`, `CREATEROLE`, `CREATEDB` or `REPLICATION` |
| A4 | the reader cannot reach the metadata schema, which stores prompts and query history |

Three are **advisory**, and being honest about why is the point:

| | |
|---|---|
| B1 | `SECURITY DEFINER` functions the reader may execute |
| B2 | views and materialised views the reader may read |
| B3 | `dblink`, `postgres_fdw`, `plpython3u`, `http` and friends |

**B1 and B2 are the largest residual risk in the whole design, and no amount of AST validation can close them.** A view body and a function body expand *server-side*, after our guard has seen the query and approved it. A customer-owned `SECURITY DEFINER` function owned by a superuser is a full write primitive reachable from a perfectly valid `SELECT`. We can detect these and make a human look at them. We cannot prevent them.

Saying so plainly is better than a checklist that implies otherwise.

Two smaller design points, both about not lying to yourself:

**A check that could not run is a failure, not a pass.** If the catalog query throws — permission denied, table missing — the result is `fail`, never silently skipped. Otherwise a locked-down database produces a green proof by refusing to answer the questions.

**A0 refuses to run the proof as the role under test.** `information_schema.table_privileges` only shows grants where the current user is grantor or grantee. Run the proof as `ik_sdk` and it under-reports — and under-reporting looks exactly like passing. So the first check is that we are *not* that role.

> A verification that gets weaker as the system gets more locked down is worse than none.

## What is still missing

Honest scope, because a security component that overstates itself is worse than one that does not exist.

- **None of this has touched a real Postgres.** Every test here runs against a fake client that records statements. That proves we *send* the right things and refuse the wrong ones. It does not prove Postgres behaves as expected — that needs Testcontainers, and it is the highest-value thing left.
- The row cap bounds **rows returned, not work done**. A cross join still runs. That is `cost-ceiling`.
- Nothing yet restricts **which columns** a query may read. That is `column-policy`.
- Nothing yet scopes rows to the **viewer's tenant**. That is `tenant-scoping`.

Those three are still asserted as open in the eval corpus, which is where the list came from in the first place.

## What to read next

- [ADR 0005 — the row cap in the validated tree](../adr/0005-row-cap-in-the-validated-tree.md)
- [ADR 0006 — reaching the database is a capability](../adr/0006-reader-path-is-a-capability.md)
