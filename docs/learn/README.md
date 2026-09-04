# Learning track

Written alongside the code, not after it. Each chapter explains what we built, why that shape and not another, and what we got wrong on the way.

Chapters appear as the corresponding code lands. There is deliberately no outline for parts that do not exist yet.

| # | Chapter | Covers |
|---|---|---|
| 01 | [What an SDK actually is](./01-sdk-anatomy.md) | why library code differs from app code, semver as a contract, `exports`, dependency footprint, async-init/sync-use, errors as values |
| 02 | [Package boundaries as security boundaries](./02-boundaries.md) | monorepo vs polyrepo, pnpm strict resolution, the dependency rules and how they are enforced |
| 03 | [Deciding whether SQL is safe](./03-parsing-sql-safely.md) | why regex loses, real grammar parsing, allowlist vs denylist, the three layers, deparse round-trip |
| 04 | [Measuring a system that guesses](./04-measuring-a-system-that-guesses.md) | why the eval comes before the planner, two adversarial surfaces, multiset comparison and the transitivity trap, three-state outcomes, why a spend cap needs bounded concurrency, safety vs fidelity |
| 05 | [Turning a claim about text into a claim about the database](./05-making-a-guarantee-real.md) | capabilities vs conventions, unforgeable brands, the sealed read-only transaction, why it never commits, fail-closed interpolation, proving isolation from the catalog |

Decisions with a real alternative are recorded separately in [../adr](../adr).
