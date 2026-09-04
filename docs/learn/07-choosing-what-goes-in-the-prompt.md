# 07 — Choosing what goes in the prompt

Chapter 06 ended with a description of every table the reader can see. For a customer with 200 tables that is far too much to send a model, so this chapter is about the two decisions that follow: **which tables**, and **what do they look like as text**.

## Why not just send everything

The first instinct is that more context is better. It isn't, for two separate reasons.

The cost reason is obvious: you pay for every token, on every question, forever.

The accuracy reason is the one that matters. A model given 200 tables picks the wrong one more often than a model given eight. Extra tables are not neutral padding — they are plausible wrong answers sitting next to the right one. Narrowing the schema is not just an optimisation; it *is* part of getting the answer right.

## The format: boring on purpose

The schema goes in as Postgres DDL.

```sql
-- people who signed up
-- approximately 51,000 rows
CREATE TABLE public.users (
  id bigint,
  email text,
  signup_method text,
  deleted_at timestamptz, -- soft delete; null means active
  PRIMARY KEY (id)
);
```

There is no clever encoding here, and that is the point. A model has seen vastly more `CREATE TABLE` than any format we could invent, so the representation costs zero explanation. It is also readable by a person, which matters the first time a plan comes back wrong and the question is "what did the model actually see?"

Two details do real work.

**Comments survive.** `deleted_at -- soft delete; null means active` is the entire difference between "how many users do we have" being right and being confidently wrong. A column comment is often the only place the database records what the name does not say.

**A foreign key is only rendered if both tables are in the prompt.** Emit `REFERENCES public.accounts (id)` without describing `accounts` and you have invited a join against a table the model cannot see. It will try.

**Row estimates are included** so the model can tell a lookup from a full scan — but they come from `reltuples`, an estimate, so they inform the plan and never the answer.

## Choosing tables: overlap, not vectors

The scoring is deliberately plain. Tokenise the question and the schema the same way, count the overlap, weight it:

| where the word matched | weight |
|---|---|
| table name | 10 |
| column name | 3 |
| table comment | 2 |
| column comment | 1 |

Tokenising means splitting `signup_method` and `signupMethod` both into `signup, method`, dropping stopwords, and stemming plurals so "users" finds `users`.

The stemmer is crude — `status` becomes `statu` — and that is fine, because **it is applied to both sides**. Question and schema reduce identically, so `statu` matches `statu`. An imperfect stemmer costs nothing; an *asymmetric* one would break everything. That is the only property that has to hold.

Each distinct question term contributes at most once, so asking "orders orders orders" does not let one word dominate.

## Two things scoring alone gets wrong

**A join needs both tables.** Ask "total orders" and only `orders` scores. But the query the user wants may need `users` too, and the model cannot join to a table the prompt never mentioned. So a matched table pulls in its foreign key neighbours, one hop by default.

**Sometimes nothing matches.** Ask "what is the weather in Jaipur" of a SaaS database and every score is zero. Returning nothing would leave the planner with no schema at all. So the result carries `matched: false` — an honest signal the caller can act on — and falls back to the *most foreign-key-connected* tables. A hub table is a better guess than whatever happens to sort first alphabetically.

## Measuring the budget instead of estimating it

Tables are added one at a time, and after each one the whole candidate set is re-rendered and measured:

```ts
const candidate = [...chosen, table]
const rendered = renderSchema(candidate, schema.foreignKeys, options.render)
if (estimateTokens(rendered) > maxTokens && chosen.length > 0) { omitted += 1; continue }
```

Rendering the set repeatedly is wasteful in the abstract and free in practice — there are at most a dozen tables. The gain is that the budget is checked against the **actual output**, including the foreign key lines that appear or vanish depending on which tables made the cut. Estimating from metadata would drift from the truth in exactly the case that matters.

`chosen.length > 0` guarantees at least one table comes back even if it alone blows the budget, because a prompt with no schema cannot produce SQL at all.

## What this does not do, and why that is fine

Run it against a realistic schema and most questions land well. One does not:

> **"what is our monthly recurring revenue by plan"**
> → `accounts, subscriptions, users, tickets`

`accounts` scores first because `plan` is one of its columns. `subscriptions` — which actually holds `mrr_cents` — only arrives through the foreign key. "Monthly recurring revenue" and `mrr` share no token. Lexical matching cannot know they are the same thing.

That is not a defect to fix here. It is the **semantic layer's** entire reason to exist: the place where a business word is mapped to a column. Until that layer is built, foreign key expansion is what rescues these cases, which is a good argument for leaving it on by default.

It is worth noticing the failure is *legible*. You can look at the score, see that no word matched, and know exactly why. An embedding-based retriever that quietly ranked the wrong table would give you nothing to look at.

## Why not embeddings, then?

They would probably be better at precisely this weakness. The reason to wait is not that they are wrong — it is that adopting them now means an embedding model, a vector store, an invalidation story for when the schema changes, and a network call on a path that currently has none.

And there is no way to tell whether it helped. The eval corpus exists, but there is no planner yet to run it against, so "better retrieval" would be an assumption wearing the clothes of an improvement. `selectTables` returns a `Selection`; swapping what happens underneath changes nothing above it. That is the part worth getting right today.

The weights in that table are guesses too. They are guesses that can be *measured* — later, against the corpus, once there is something to measure.

---

Next: the planner. A question, a schema, and a model, producing SQL that then has to survive the guard.
