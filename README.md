# Warden

An operations agent that can be trusted with real actions, because it cannot
take one on its own.

The agent reads a case, decides what should happen, and **proposes** it. A
policy engine it cannot see or influence then decides whether that proposal
happens, happens after a human signs it, or does not happen at all. Every
decision is written down before it takes effect.

> Working name. The thesis - *an agent you can let touch real customers* - is
> the part that is settled; the name is not.

---

## Why this shape

Most agent demos are a model with tools bolted on. They work in a demo and are
unshippable, for three reasons this repo is built around:

**A model that can act can be talked into acting.** So the model here does not
act. `propose_action` writes a row; `src/lib/agent/policy.ts` decides. Policy
reads the clock, the tenant's configuration and the case's own history - never
the conversation - so a prompt injection that convinces the agent to call
someone at 3am still gets stopped by the contact-window check.

**A crash between "decided" and "did" is the expensive bug.** Every action is
persisted *before* its side effect fires, keyed by a hash of the action itself.
On resume the runtime can tell "decided but never did" from "already did", and
the uniqueness guarantee is a Postgres index rather than an `if` statement,
because application-level dedupe loses to a race.

**"It worked when I tried it" is not a result.** `EvalRun` pits an agent arm
against a control arm over the same cases with the same pre-drawn seeds, so the
only difference between arms is the decisions, not the dice.

---

## Stack

| | |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript |
| Styling | Tailwind CSS 4 |
| Database | Postgres via Supabase, Prisma 7 with the `pg` driver adapter |
| Model | Groq or Gemini via the Vercel AI SDK |
| Tests | Vitest |

One deployable. There is no separate API service, because a second service
would double the operational surface and buy nothing.

---

## Layout

```
src/lib/agent/
  types.ts         action vocabulary; which actions are irreversible
  policy.ts        the guardrail engine - pure, synchronous, fully tested
  idempotency.ts   deterministic write-ahead keys
  runtime.ts       the durable loop: persists every step, parks for approval
  actions.ts       executors; the only code that touches the outside world
  audit.ts         append-only log
  seed.ts          common random numbers for eval arms
prisma/schema.prisma
```

`policy.ts` has no I/O and no model access on purpose: it is a pure function of
(proposal, policy, case, clock), which is why it can be exhaustively tested and
why its verdict can be shown to a user as a list of named checks.

---

## Running it

```bash
pnpm install
cp .env.example .env     # fill in Supabase + a model provider key
pnpm db:setup            # push the schema and lock the tables (uses DIRECT_URL)
pnpm dev
```

`db:setup`, never `db:push` on its own. Supabase serves every table in `public`
over its REST API to anyone holding the anon key, and that key ships in the
browser bundle. `db:push` creates the tables and leaves them readable there;
`db:setup` also applies `prisma/rls.sql`, which turns on row level security
with no policies, so that API sees nothing. Prisma connects as the table owner
and is unaffected.

Two connection strings, and they are not interchangeable:

- `DATABASE_URL` - Supabase **transaction pooler**, port 6543, runtime queries.
  Must carry `?pgbouncer=true&connection_limit=1`.
- `DIRECT_URL` - Supabase **direct** connection, port 5432, migrations only.
  pgbouncer multiplexes sessions and cannot run DDL.

```bash
pnpm typecheck
pnpm test
pnpm build
```

---

## The measurement

```
pnpm eval --count 2000 --seed warden-v1
```

Inbound enquiries to an Indian SMB. The agent answers them; three baselines
answer them too. Same leads, same scoring function, same guardrails, same
pre-drawn random numbers - so the gap is the decisions, not the dice.

```
agent_v2        26.15%          <- the arm we ship
autoresponder   22.75%          <- strongest baseline
batch            5.45%             inbox checked 3x a day
                                   1.149x, +3.40 points
```

**These are simulated outcomes under the model in `src/lib/eval/simulator.ts`,
not live traffic.** Every eval arm runs the executors with `dryRun=true`; no
message is ever sent. What is being measured is whether the decisions beat the
baseline's decisions under a stated model - and the model is one file, with
every constant named, so it can be argued with.

Three things the harness does that a demo does not:

**It quotes the strongest baseline.** Against a business that checks its inbox
three times a day the number is 4.8x, which is the flattering one. The headline
is 1.149x, against an instant autoresponder, because that is the honest
comparison.

**It reports losses.** 21 leads out of 2000 went to the baseline and not to the
agent. It lost 2 of 20 batches. Both stay in the output.

**It says which assumption the result rests on.**

```
misfire=0%    lift 1.207x
misfire=12%   lift 1.149x
misfire=25%   lift 1.084x
misfire=40%   lift 0.996x     <- break-even
```

Personalisation is not free: a reply that misreads the enquiry lands worse than
a neutral template, because it proves nobody was paying attention. Past roughly
a 40% misread rate this whole system is worse than a stock auto-reply. That is
the number to measure in production, and it is the number that decides whether
any of this should ship.

### A finding that changed the code

The first eval had the agent treating its contact window as absolute, so
overnight enquiries waited until 09:00. It lost the overnight segment to a
plain autoresponder by 5.6 points.

The fix was not to special-case the metric. It was that a contact window exists
to stop us *interrupting* people, and answering someone who messaged ninety
seconds ago is not that - which is also why India's DLT regime governs
registered template content rather than banning replies. So `Policy` gained
`inboundReplyGraceMinutes`, and a reply inside that grace window is exempt
while proactive follow-ups still wait. The overnight segment went from -5.6 to
+4.2 points.

Correcting it also surfaced a bug in our own favour: the autoresponder was
being penalised for replying at 3am while the agent was about to be exempted
for the identical behaviour. Both are reactive. Fixing it made the headline
number smaller.

## Status

In: runtime core, policy engine, write-ahead execution, audit log, lead domain
model, eval harness with control arms, 40 tests.

Next: approval queue and run-trace UI, the replay tool, and wiring the real
message providers behind the executors.
