# `micro-worlds`

[![ci](https://github.com/cloudsforge-online/micro-worlds/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-worlds/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml) [![licence](https://img.shields.io/badge/licence-MIT-blue)](./LICENSE)

The title registry, the cross-title player profile and inventory, achievements, seasons, rewards
that are real money — and **the entitlement bridge**: the consumer of
`billing.entitlement.granted` that finally turns a paid private world into a world that exists.

Design authority: [`ecosystem/03-repository-responsibilities.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/03-repository-responsibilities.md)

> **It owns nothing a title owns.** A title service owns simulation state; this service owns
> anything that must outlive a season or cross a title (`src/migrations.ts`). It also holds
> no money: a reward is a posting to `micro-ledger`, and the budget that bounds it is a database
> CHECK, not a counter in a handler.

> **A bound item cannot be listed for sale, and that is a CHECK constraint.**
> `inventory_items_bound_not_listed` (`src/migrations.ts`). 04-domain-model §7.3 — "anything
> conferring power is bound and cannot enter the market" — expressed in the schema **because a rule
> in a route is a rule that the next route forgets** (`src/migrations.ts`).

---

## The entitlement bridge

`src/provisioning.ts` is the most important file header in the repository. The short version:

The estate sells `private_skirmish` for 1,800 Shards and `private_saga` for 2,500. Pay debits the
balance, writes an `entitlements` row with the world name the customer typed into its `meta`, and
returns 201. **Nothing then reads that row.** The seller's own source says

```
// The game service later reads this to actually provision the world (out of scope here).
```

**and that consumer has never existed.** The only world-creation path in the estate is an
operator-only `POST /admin/worlds` which takes no user, no entitlement and no owner, because
`worlds` has no column to put one in. The rental is excluded from Pay's own-once unique index and
takes no idempotency key, so **the same customer can be charged for the same undelivered world as
many times as they press the button**. The shop's own source calls this "WITHHELD", and the
mitigation that shipped was to hide the button.

Six things had to exist before a provisioner could be written at all, and each now does
(`src/provisioning.ts`):

| # | What | Where it now is |
| --- | --- | --- |
| 1 | a service-readable entitlement API | billing's `GET /internal/entitlements/:userId` and the `billing.entitlement.granted` event. Pay's is Bearer-only, so **no background job could ever ask** — which is why no async fulfilment of any kind is possible there |
| 2 | a provisioning marker | `provisions.state` (`src/migrations.ts`). Pay's entitlements table has no state column at all; only `meta` is free |
| 3 | idempotent creation keyed on the entitlement | `provisions_entitlement_uniq` (`src/migrations.ts`), and the same id sent to the title as its idempotency key |
| 4 | owner, visibility and capacity on a world | the title's business, behind `service_url`, carried in `metadata` |
| 5 | an operator view of failed rentals | `GET /v1/provisions?state=failed` (`src/server.ts`) plus `worlds_provisions_total{outcome}` |
| 6 | a refund path | not this service's to perform — billing owns revocation — but `worlds.provision.failed` names the entitlement and starts one |

### Consume, then provision. Never both in one step.

The webhook does one thing: `withInbox` plus one INSERT. **It does not call the title**, because a
title that is slow would then make billing's relay time out and redeliver — and **a bridge whose
delivery pressure is coupled to a title's provisioning latency is a bridge that melts on the day a
title is slow**. The job does the calling, under a lease, with a bounded attempt budget
(`src/provisioning.ts`, enqueue at `src/server.ts`).

### Three failure modes, and why they are three

`src/titleclient.ts` uses `HttpError.peerDecided` as the discriminator, and
`driveProvision` acts on each differently (`src/provisioning.ts`):

| Error | Meaning | What the row becomes |
| --- | --- | --- |
| `TitleUnsupportedError` (422, or `code: unsupported`) | the title cannot do this, ever | `state = 'unsupported'` — terminal, with a reason (`src/provisioning.ts`) |
| `TitleRefusedError` (any other 4xx) | the title **looked at it and said no** | `state = 'failed'` — permanent for this request; retrying is a guaranteed second refusal and a second burnt attempt (`src/provisioning.ts`) |
| `TitleUnavailableError` (5xx, timeout, open circuit) | **we do not know whether it provisioned** | the row keeps everything it has, the lease is released, and the next tick sends **the same entitlement id** — which the title recognises (`src/provisioning.ts`) |

"That distinction is what keeps a title having a bad minute from turning into a refund queue"
(`src/titleclient.ts`).

A 2xx carrying no `urn` is treated as an **outage, not a success**: a title claiming a success it
cannot name would break `provisions_provisioned_is_complete` anyway, "and would deserve to"
(`src/titleclient.ts`).

Two checks are made **before** the call rather than discovered from a 404: the scope must name a
registered title, and that title must declare the capability. "A title that cannot do this is a
catalogue mistake, and it deserves a row that says so" (`src/provisioning.ts`).

Cosmetics and convenience items are delivered **here**, by writing an inventory row, and never
routed through a title — routing them through one would make every cosmetic purchase depend on a
game being up (`src/provisioning.ts`).

---

## A reward is a ledger posting with a budget cap

`src/rewards.ts`. The service this supersedes increments XP, levels, skill points and `tokens`
as plain integer columns in place — `work.tokens += locked.rewardTokens` — with **no entry anywhere
and no possibility of reconciliation**. It survives only because those tokens are a dead currency.
"The moment a reward is worth a Shard, and a Shard is one US cent funded by an on-chain deposit, an
unreconciled increment is a hole in the money."

There is also **no cap of any kind there**: no daily, weekly, seasonal or global issuance budget, no
counter, no alert; `grantXp` loops levels with no ceiling. So a bug granting an objective twice per
tick grants it for ever, bounded only by how long it takes somebody to notice.

Here the budget is a column, the check is `seasons_within_budget`, and the increment happens in the
**same transaction** as the grant — so it cannot be spent past by application-level cleverness, by a
second replica, or by a hand-run UPDATE. The transaction simply fails to commit. **That is the
difference between a control and an intention.**

The ordering inside `grantReward` is the part easy to get backwards (`src/rewards.ts`):

1. increment `rewards_granted_shards` **first**, under the CHECK — if the season cannot afford it
   the transaction fails **before the ledger has been asked for anything**. Posting first and
   capping second would move real money and then decline to record it;
2. post to the ledger, inside the transaction, with a **derived** key;
3. insert the `reward_grants` row naming the entry.

A crash anywhere rolls all three back, and the retry **replays** the ledger entry rather than
posting a second one. A crash between 2 and 3 is the dangerous one, and the derived key is what
makes it safe.

---

## Routes

Read out of `src/server.ts`. Everything domain is under `/v1`. `authenticate()` resolves the bearer
token; scope is checked per-route and **only for service principals**, users being authorised by
ownership (`/players/me`) or by the `admin` role.

Four scopes: `worlds:read`, `worlds:write`, `worlds:title` and `worlds:admin`
(`src/server.ts`).

| Method | Path | Who | What it does |
| --- | --- | --- | --- |
| `GET` | `/livez` | **no auth** | liveness (`src/server.ts`) |
| `GET` | `/readyz` | **no auth** | 200/503 (`src/server.ts`) |
| `GET` | `/metrics` | **no auth** | Prometheus text (`src/server.ts`) |
| `POST` | `/v1/events` | **no bearer token** — an **HMAC signature** | the bridge's front door, now serving TWO topics: `billing.entitlement.granted` (provisioning) and `aetherholm.season.sealed` (heraldry — `src/heraldry.ts`, dispatch in `src/server.ts`). Everything else is acknowledged and ignored |
| `GET` | `/v1/titles` | **no auth** | the registry. **Public deliberately: a launcher listing games cannot require a token to do it** (`src/server.ts`, note) |
| `POST` | `/v1/titles` | admin; service needs `worlds:admin` | registers a title with its `service_url`, capabilities and asset scopes (`src/server.ts`) |
| `GET` | `/v1/players/me` | user; service needs `worlds:read` | the cross-title profile (`src/server.ts`) |
| `PUT` | `/v1/players/me` | user; service needs `worlds:write` | updates it (`src/server.ts`) |
| `PUT` | `/v1/players/me/cosmetics` | user; service needs `worlds:write` | equips cosmetics (`src/server.ts`) |
| `GET` | `/v1/players/me/inventory` | user; service needs `worlds:read` | the inventory (`src/server.ts`) |
| `POST` | `/v1/players/me/inventory/:id/list` | user; service needs `worlds:write` | lists an item for sale — **refused by the schema if the item is bound** (`src/server.ts`) |
| `DELETE` | `/v1/players/me/inventory/:id/list` | user; service needs `worlds:write` | delists it (`src/server.ts`) |
| `GET` | `/v1/provisions` | user (own) or admin; service needs `worlds:read` | **the operator view of failed rentals** — `?state=failed` (`src/server.ts`) |
| `GET` | `/v1/provisions/:id` | user (own) or admin; service needs `worlds:read` | one provision (`src/server.ts`) |
| `POST` | `/v1/provisions/:id/retry` | admin; service needs `worlds:admin` | re-opens a `failed` or `unsupported` row (`src/server.ts`, guarded at `src/provisioning.ts`) |
| `GET` | `/v1/titles/:id/achievements` | **no auth** | the title's achievement catalogue (`src/server.ts`) |
| `PUT` | `/v1/titles/:id/achievements` | service with `worlds:title` | a title declares its achievements (`src/server.ts`) |
| `POST` | `/v1/titles/:id/achievements/unlock` | service with `worlds:title` | a title reports an unlock (`src/server.ts`) |
| `GET` | `/v1/titles/:id/seasons` | **no auth** | the seasons (`src/server.ts`) |
| `POST` | `/v1/titles/:id/seasons` | admin; service needs `worlds:admin` | opens a season **with a budget**, or re-opens the one with that slug. The budget is a spending limit on `engagement:worlds`, so **lowering it is free and raising it needs `budgetRaiseApprovalId`** — a raise without one is `422 budget_raise_needs_approval` (`src/server.ts`) |
| `GET` | `/v1/seasons/:id/budget` | user or admin; service needs `worlds:read` | budget and consumption (`src/server.ts`) |
| `POST` | `/v1/seasons/:id/rewards` | service with `worlds:title` | grants a reward — a ledger posting under the cap (`src/server.ts`) |

**Six routes make no `authenticate()` call**: `/livez`, `/readyz`, `/metrics`, `GET /v1/titles`,
`GET /v1/titles/:id/achievements` and `GET /v1/titles/:id/seasons`. A client that sends a token to
one of them is not refused — the token is simply never looked at.

**`POST /v1/events` is the seventh, and it is different.** It takes no bearer token at all; it is
authenticated by an **HMAC signature over the raw bytes**, checked *before* the body is parsed
(`src/server.ts`, and `src/server.test.ts` pins the ordering against the source so it
cannot be reversed by a refactor). The header explains why the raw bytes: parsing first would make
the signature cover a re-serialisation rather than what arrived, and would run a parser for an
unauthenticated caller (`src/server.ts`). A bad signature is **401, not 403** — the caller failed
to authenticate at all — and the message says nothing about which half was wrong
(`src/server.ts`).

The check accepts **every key in `OUTBOX_ACCEPT_SECRETS`**, not just the one this service signs
with, which is what makes rotating the estate's shared outbox secret a window rather than a flag
day; see the Configuration table. A delivery that verifies against a key other than the first is
logged with its index, never its value (`src/server.ts`).

An event on a topic this service does not subscribe to is **accepted and ignored with a 202**, never
a 4xx: a 4xx would make the producer's relay retry, for ever, an event it is correct to send and we
are correct not to act on (`src/server.ts`).

No route on this service takes an `Idempotency-Key`. The bridge's idempotency is the entitlement id,
carried into `provisions_entitlement_uniq` and out again as the title's key
(`src/titleclient.ts` — **both** in the header, which is what makes the POST retriable at
all since `HttpClient` attempts a non-idempotent method exactly once without one, **and** in the
body, which is what the title stores and dedupes on).

---

## Background work

Leased jobs only. **A key is not a lock across kinds** (`src/jobs.ts`).

| Job | Lease key | Cadence | What two replicas do |
| --- | --- | --- | --- |
| `outbox.relay` | `stream` | 1s | one claims the stream (`src/jobs.ts`) |
| `provision.deliver` | `title:<id>` | on demand | one delivers per title. Row-level claiming inside `claimProvision` is what makes two deliveries of one provision impossible; the key bounds concurrent load on a single title service (`src/jobs.ts`, key at `src/server.ts`) |
| `provision.sweep` | `stream` | 5s | finds outstanding provisions and enqueues them, so a provision left behind by a lost event or a paused deployment is picked up without anybody asking (`src/jobs.ts`) |

The sweep is what makes `WORLDS_PROVISIONING_ENABLED=false` safe: nothing is lost while it is off —
the `provisions` rows sit `pending` and the sweep drains them when it is turned back on
(`.env.example:50-52`).

`provisions_outstanding_idx` is partial on `state in ('pending','provisioning')`, so the sweep's
scan is the size of the backlog rather than the size of every rental ever sold
(`src/migrations.ts`).

---

## The database

`titles`, `player_profiles`, `inventory_items`, `provisions`, `achievements`,
`player_achievements`, `seasons`, `reward_grants`, plus `jobs`/`outbox`/`inbox`.

| Constraint | Refuses | Why it is here rather than in a handler |
| --- | --- | --- |
| `inventory_items_bound_not_listed` — `not (bound and listed_at is not null)` | selling anything that confers power | **the anti-pay-to-win control.** A rule in a route is a rule the next route forgets — and the frozen estate relies on three independent *conventions* instead: a catalogue policy, a trade engine that happens to be type-closed over resources, and the fact that entitlements have no transfer path. **Every one of those is a property of what has not been built yet** (`src/migrations.ts`, reasoning) |
| `seasons_within_budget` — `rewards_granted_shards <= reward_budget_shards` | minting rewards past the season's budget | **rewards are ledger postings, so a game exploit that mints them is a money incident rather than a balance complaint.** Enforced by the database, in the same transaction as the grant, so no application-level cleverness, no second replica and no hand-run UPDATE can spend past it (`src/migrations.ts`, reasoning) |
| `provisions_entitlement_uniq` on `entitlement_id` | provisioning one entitlement twice | **the idempotency of the whole bridge**: one entitlement provisions one thing, for ever, however many times the event is redelivered and however many replicas consume it (`src/migrations.ts`, reasoning) |
| `provisions.title_id` has **NO foreign key** | — | **deliberate, and found by a test.** A FK made the INSERT fail with 23503 → the webhook answered 500 → billing's relay redelivered for ever → **and the purchase was never recorded at all.** That is exactly the class of defect this table exists to end: a customer's money moves and nothing in the platform knows. Recording a purchase must never depend on the registry being up to date; an unregistered title becomes an `unsupported` row an operator can read and act on (`src/migrations.ts`, behaviour at `src/provisioning.ts`) |
| `provisions_provisioned_is_complete` | `state = 'provisioned'` with no `provisioned_urn` | **a row that claims delivery and cannot say of what is exactly the state the frozen estate leaves a customer in** (`src/migrations.ts`) |
| `provisions_failed_says_why` | `state = 'failed'` with no `last_error` | the first question after a failed rental is why (`src/migrations.ts`) |
| `titles_slug_shape` — `slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'` | a slug that is a path traversal or an over-matching scope | **a slug is a URL segment *and* an entitlement scope id**, so it is constrained where both uses read it (`src/migrations.ts`, reasoning) |
| `inventory_items_scope_shape` — `'*'` or a uuid | an arbitrary title scope | `*` is `CROSS_TITLE`; anything else must be a real title id (`src/migrations.ts`) |
| `inventory_items_listing_complete` — `(listed_at is null) = (listing_urn is null)` | a half-recorded listing | "listed" is two columns and one fact (`src/migrations.ts`) |
| `inventory_items_entitlement_uniq`, **partial** `where entitlement_id is not null` | one entitlement granting an item twice | partial, because most items have no entitlement behind them (`src/migrations.ts`) |
| `reward_grants_key_uniq` on `idempotency_key` | a doubled reward | pairs with the derived ledger key so a retry replays rather than posts again (`src/migrations.ts`) |
| `seasons_budget_raise_needs_approval` (trigger) + `seasons_budget_raise_approval_uniq` | **raising** a season's reward budget without naming a fresh approval — including by re-opening the season, and including a hand-run `UPDATE` | since migration 9 a season is funded from `engagement:worlds`, so `reward_budget_shards` is a **spending limit on real platform money**. `docs/ecosystem/21-engagement-treasury.md` §6 makes raising an engagement cap an approved act and lowering one free; §7.7 requires that asymmetry be proven by test; `admin-api/src/migrations.ts` already enforces it on `engagement_policies`. `openSeason`'s ON CONFLICT branch used to assign the budget unconditionally, so the ordinary re-open — the one that corrects a name — silently raised the cap. **A trigger and not a CHECK** because the rule is about the *direction* of a change and a CHECK cannot see the old row. The approval id is `text` with no FK: `approvals` is admin-api's table, so this is a cross-service reference like `reward_grants.journal_entry_id` (`src/migrations.ts`, uniqueness, reasoning — including what it does **not** cover) |
| `seasons_dates_ordered`, `seasons_budget_positive`, `achievements_points_sane` (0–1000) | inverted seasons, a zero budget, absurd point values | (`src/migrations.ts`) |

---

## Configuration

`.env.example` and `src/env.ts` were cross-checked and **agree**: every variable `loadEnv` reads is
present with its real default, and nothing extra is declared — including `OUTBOX_ACCEPT_SECRETS`,
which ships commented out because its default *is* the current behaviour. `OUTBOX_SIGNING_SECRET` and
`WORLDS_IDENTITY_CREDENTIAL` ship **empty**, so a copied file refuses to boot until they are filled
— which is the fail-closed pattern, unlike the estate repositories that ship a long placeholder
that clears the length check.

**`WORLDS_SERVICE_TOKEN` is retired.** It was a service *token*, and a service token expires in 600
seconds (`SERVICE_TTL_SECONDS`, `identity/src/tokens.ts`). This service read one once at boot and
nothing re-minted it, so ten minutes into every deployment the ledger and billing refused every
call. What a container holds at rest is now a *credential*: long-lived, revocable, worth nothing by
itself, exchanged for an ordinary ten-minute token whenever one is needed. Setting the old variable
is logged as ignored at boot rather than silently obeyed. See `src/upstreams.ts` and
`@cloudsforge/auth`.

| Variable | Default | If it is wrong or missing |
| --- | --- | --- |
| `PORT` | `4000` | integer 1–65535 (`src/env.ts`) |
| `NODE_ENV` | `development` | labelling only (`src/env.ts`) |
| `LOG_LEVEL` | `info` | outside the four levels, boot fails (`src/env.ts`) |
| `CLOUDSFORGE_TAG` | `dev` | the reported version is wrong (`src/env.ts`) |
| `WORLDS_DATABASE_URL` | — | **required** (`src/env.ts`). Rule 1 |
| `WORLDS_DATABASE_POOL_MAX` | `10` | 1–100 (`src/env.ts`) |
| `IDENTITY_JWKS_URL` | — | **required**; unreachable → 503, never 401 (`src/env.ts`) |
| `IDENTITY_ISSUER` | — | **required**; wrong → universal 401 (`src/env.ts`) |
| `OUTBOX_SIGNING_SECRET` | — | **required, ≥24 chars.** It signs outbound events, and — unless `OUTBOX_ACCEPT_SECRETS` overrides it — it is also the one key `POST /v1/events` verifies inbound signatures against, so a mismatch with billing's value makes every grant event 401 and **no world is ever provisioned** (`src/env.ts`, signing use at `src/index.ts`) |
| `OUTBOX_ACCEPT_SECRETS` | `[OUTBOX_SIGNING_SECRET]` | **optional; comma-separated, newest first.** Every key `POST /v1/events` will accept a signature from, which is what makes rotating the estate's shared outbox secret possible: a single key cannot be swapped, because whichever end moves first has every delivery between them refused until the other catches up, and a bridge that refuses grant events provisions nothing. Add the new key here, restart, move the producers, then drop the old one. Each entry faces the same ≥24-character and placeholder bar as the signing secret, and a repeated entry is refused — a duplicate makes "which key verified this" ambiguous, and that answer is how you know the rotation finished. A delivery that verifies against anything but the first key is logged with its `keyIndex` (`src/env.ts`, parser, use at `src/server.ts`) |
| `INSTANCE_ID` | hostname | names this replica in `jobs.locked_by` **and in `provisions.lease_owner`** (`src/env.ts`) |
| `LEDGER_URL` | — | **required**. No posting, no reward (`src/env.ts`) |
| `BILLING_URL` | — | **required**. Where `GET /internal/entitlements/:userId` is asked (`src/env.ts`) |
| `WORLDS_IDENTITY_CREDENTIAL` | — | **≥24 chars, `cfsc_…`.** The long-lived credential exchanged at `POST /service-tokens/exchange` for a ten-minute token carrying `ledger:post` and `billing:read`. Technically optional so the image can boot for CI's `/livez` smoke test, but `/readyz` fails hard without it and every peer call 503s |
| `IDENTITY_URL` | `IDENTITY_ISSUER` | where the credential is exchanged. Only set it where the issuer and the dialled address genuinely differ |
| `WORLDS_SERVICE_TOKEN` | — | **retired.** A 600-second token read once at boot. If still set, boot logs that it is ignored |
| `WORLDS_UPSTREAM_DEADLINE_MS` | `5000` | 100–60000, for ledger and billing (`src/env.ts`) |
| `WORLDS_TITLE_DEADLINE_MS` | `20000` | 100–120000, **longer than the estate's other upstream deadlines deliberately**: provisioning a world writes up to four thousand tile rows in the title service, and a deadline shorter than that work **turns every provision into a retry of something that succeeded** (`src/env.ts`, reasoning) |
| `WORLDS_PROVISIONING_ENABLED` | `true` | set `false` to pause provisioning without pausing the service. Nothing is lost: rows sit `pending` and the sweep drains them (`src/env.ts`) |
| `WORLDS_SEASON_REWARD_BUDGET_SHARDS` | `100000` | the budget a new season opens with when nobody names one. **A money control, not a tuning knob** — and deliberately small, because *a budget nobody chose should bind long before it costs anything*. Must be positive or boot fails (`src/env.ts`, `.env.example:85-92`) |
| `WORLDS_TEST_DATABASE_URL` | — | tests only; the name must contain `test` |

---

## What it talks to

| Upstream | Routes called | Verified against | When it is down |
| --- | --- | --- | --- |
| `micro-ledger` | `POST /entries` (`src/ledgerclient.ts`) | `ledger/src/server.ts` ✅ | **fail closed, inside the reward transaction.** The budget increment happens first, under the CHECK, and the posting happens in the same transaction — so a ledger outage rolls all three steps back: no reward, no budget consumed, no orphaned entry |
| `micro-billing` | `GET /internal/entitlements/:userId` (`src/billingclient.ts`) | `billing/src/server.ts` ✅ | fail closed for an entitlement check; the bridge does not depend on it for the event path |
| each registered **title service** | `GET /v1/title`, `POST /v1/provision` at that title's `service_url` (`src/titleclient.ts`) | **❌ no title in the estate implements either** — see Known gaps | three-way: unsupported → terminal, refused → failed, unavailable → **retry with the same entitlement id** |
| `micro-billing` (inbound) | it POSTs `billing.entitlement.granted` to `/v1/events` here | `billing/src/entitlements.ts` ✅ | if billing is down no grants arrive; the sweep has nothing to find, and no state is lost |

---

## Running it

```bash
pnpm install
pnpm typecheck

# Migrations are a one-shot job and are NEVER run by the service process.
WORLDS_DATABASE_URL=postgres://worlds:worlds@127.0.0.1:55437/worlds pnpm migrate
pnpm start
```

The suite needs a real Postgres whose database name contains `test`:

```bash
docker run -d --rm --name worlds-pg \
  -e POSTGRES_USER=worlds -e POSTGRES_PASSWORD=worlds -e POSTGRES_DB=worlds_test \
  -p 55437:5432 postgres:17-alpine

WORLDS_TEST_DATABASE_URL=postgres://worlds:worlds@127.0.0.1:55437/worlds_test pnpm test
```

**119 `test(` declarations**, `node:test` only. Note that `fakeTitleService` is **a real HTTP
server**, not a stubbed client (`src/testsupport.ts`) — so the bridge is exercised over a
socket, including the signature check, the idempotency header and the three failure mappings. The
`title_id`-without-a-foreign-key decision above was found by `provisioning.test.ts`
(`src/migrations.ts`).

CI is the estate's reusable `service-ci.yml` and fails the build if the database-backed suite
skipped.

---

## Known gaps

* **No title implements the provisioning contract, so no private world has actually been created.**
  `src/titleclient.ts` calls `GET /v1/title` and `POST /v1/provision` at a
  registered title's `service_url`. Neither route exists in `micro-emberkin`
  (`emberkin/src/server.ts`, ten routes, none of them these) nor in `micro-nda`
  (`nda/src/server.ts`). Those two titles integrate with this service in the **other** direction
  only — posting achievements with `worlds:write` (`emberkin/src/worldsclient.ts`,
  `nda/src/rules.ts` declares `TITLE_SLUG = 'nda'`).

  **This is the bridge working as designed rather than failing silently**, and the difference
  matters: `driveProvision` checks the capability **before** it calls, so a title registered without
  the `private_world` capability produces a terminal `unsupported` row naming the title and the
  capability (`src/provisioning.ts`), not a blind 404. The machinery, the idempotency, the
  operator view and the refund-starting event are all in place and tested against a real fake title
  service. **What is absent is a title that answers.** Until one does, a private-world entitlement
  ends as a readable `unsupported` row rather than as a world — which is a very large improvement on
  a customer being charged repeatedly for something nothing records, and is still not delivery.
* **Nothing in this repository registers a title.** `titles` is populated by an admin
  `POST /v1/titles` (`src/server.ts`); there is no seed migration and no registration script, so
  a fresh deployment has an empty registry and every provision lands `unsupported` with
  "does not name a registered title" (`src/provisioning.ts`).
* **`/metrics` is unauthenticated** (`src/server.ts`).
* **The refund is an event, not an action.** `worlds.provision.failed` names the entitlement and
  billing owns revocation (`src/provisioning.ts`); nothing here verifies that the refund
  happened, so a failed rental's money is reconciled by billing or not at all.
* **No OpenAPI description**, estate-wide (`docs/ecosystem/18-build-status.md` §3.3d, item 1).

## Heraldry — the entitlement bridge finally carries something across titles

A sealed Aetherholm season POSTs `aetherholm.season.sealed` here, and every victor member receives
a ranked banner on the shared profile: `cf:aetherholm:heraldry:<seasonId>:rank:<n>`, cross-title
(`title_scope '*'`), source `reward`, and **bound — a victory cannot be sold**, enforced by the
`inventory_items_bound_not_listed` CHECK rather than by anybody's restraint.

The dedupe is layered and each layer is load-bearing: the inbox row makes a redelivered seal a
no-op as a whole; the synthetic per-user entitlement id
(`aetherholm:season:<seasonId>:user:<userId>`) makes each member's grant individually idempotent
under the `(entitlement_id, item_urn)` unique index — **per user**, because one season-wide id
would let exactly one alliance member win the insert and hand every other member a silent null.
Grants, inbox claim and the `worlds.inventory.granted` outbox rows commit or vanish together
(`handleSeasonSealed`, `src/heraldry.ts`).

This closes the gap `18-build-status` §3.3p recorded as "an event with no consumer yet".

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
