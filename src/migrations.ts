/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * The service this supersedes has no migration framework at all: `migrate.ts` is a bare loop over
 * a hand-ordered array of idempotent DDL, run on every boot, with no version table, no
 * down-migrations and no transaction. Its own header admits the ordering carries invariants no
 * single statement expresses. That cannot survive one title, let alone N.
 *
 * ---------------------------------------------------------------------------------------------
 * **WHAT IS STRUCTURALLY NEW HERE, AND IT IS THE WHOLE POINT.**
 *
 *   `title_id` EXISTS.       A grep for `game_id|title_id|tenant` across the whole of the frozen
 *                            game service returns nothing. Not a column, not a type, not a route
 *                            parameter. That absence is why a second game is impossible, and every
 *                            table below that could belong to a title carries one.
 *
 *   `player_profile` is      The only account-scoped row in the frozen schema is
 *   ACCOUNT-scoped.          `player_cosmetics(user_id)`; everything else is per-world, which is
 *                            correct for a world and wrong for a player. A reputation, a sanction
 *                            and an age bracket must outlive a season.
 *
 *   `inventory_item.bound`   The anti-pay-to-win control, expressed as a CHECK rather than as a
 *   IS A CONSTRAINT.         policy. `inventory_items_bound_not_listed` makes listing a bound item
 *                            a write that cannot commit. The frozen estate relies on three
 *                            independent layers of convention instead, one of which is a hardcoded
 *                            catalogue that is copied into three repositories.
 *
 *   `provisions` EXISTS.     Billing writes an entitlement and emits `billing.entitlement.granted`.
 *                            Nothing in the frozen estate reads it, and nothing CAN — forge-pay's
 *                            entitlements are Bearer-only, so no background job could ever ask. A
 *                            private world is sold for 1,800-2,500 Shards and no world is raised.
 *                            This table is the record that closes that.
 *
 *   `seasons.rewards_        A budget cap, checked by the database. Rewards are ledger postings,
 *   granted_shards`          so a game exploit that mints rewards is a money incident. The frozen
 *                            service has no cap of any kind.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'outbox',
    up: `
      create table if not exists outbox (
        id             uuid        primary key default gen_random_uuid(),
        topic          text        not null,
        key            text        not null,
        occurred_at    timestamptz not null default now(),
        producer       text        not null,
        version        integer     not null default 1,
        actor          text,
        correlation_id text,
        payload        jsonb       not null default '{}'::jsonb,
        published_at   timestamptz
      );

      create index if not exists outbox_unpublished_idx
        on outbox (occurred_at)
        where published_at is null;

      create table if not exists event_subscriptions (
        id         uuid        primary key default gen_random_uuid(),
        topic      text        not null,
        url        text        not null,
        active     boolean     not null default true,
        created_at timestamptz not null default now(),
        constraint event_subscriptions_topic_url_uniq unique (topic, url)
      );

      create table if not exists outbox_deliveries (
        event_id        uuid        not null references outbox (id) on delete cascade,
        subscription_id uuid        not null references event_subscriptions (id) on delete cascade,
        delivered_at    timestamptz,
        attempts        integer     not null default 0,
        last_error      text,
        primary key (event_id, subscription_id)
      );
    `,
  },
  {
    version: 3,
    name: 'inbox',
    up: `
      -- Delivery is at-least-once, so the consumer is what makes it effectively-once. The primary
      -- key is the dedupe: a redelivered event conflicts and the handler is never re-run. In this
      -- service that is not hygiene — a redelivered 'granted' event must not provision a second
      -- world for one purchase.
      create table if not exists inbox (
        topic       text        not null,
        event_id    uuid        not null,
        received_at timestamptz not null default now(),
        primary key (topic, event_id)
      );
    `,
  },
  {
    version: 4,
    name: 'titles',
    // 04-domain-model §7.1. "Does not exist today, and its absence is why a second game is
    // impossible."
    up: `
      create table if not exists titles (
        id           uuid        primary key default gen_random_uuid(),
        slug         text        not null,
        name         text        not null,
        status       text        not null default 'draft',
        -- Where this title's own service lives. A title service owns simulation state; this
        -- service owns anything that must outlive a season or cross a title.
        service_url  text        not null,
        capabilities text[]      not null default '{}',
        asset_scopes text[]      not null default '{}',
        created_at   timestamptz not null default now(),
        updated_at   timestamptz not null default now(),
        constraint titles_slug_uniq unique (slug),
        constraint titles_status_known check (status in ('draft','beta','live','sunset','retired')),
        -- A slug is a URL segment and an entitlement scope id. Constrained here so it cannot
        -- become a path traversal or a scope that matches more than it should.
        constraint titles_slug_shape check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
      );
    `,
  },
  {
    version: 5,
    name: 'player_profiles',
    // 04-domain-model §7.2. Account-scoped, cross-title.
    up: `
      create table if not exists player_profiles (
        user_id            uuid        primary key,
        display_name       text        not null,
        avatar_asset_urn   text,
        reputation         integer     not null default 0,
        -- Keyed by TITLE, not a flat slot map. The frozen wardrobe is
        -- Partial<Record<CosmeticKind, string>> on one account row, so two titles cannot have
        -- different equipped frames — the moment there is a second title that is a bug with no fix
        -- short of a schema change.
        equipped_cosmetics jsonb       not null default '{}'::jsonb,
        sanctions          jsonb       not null default '[]'::jsonb,
        age_bracket        text        not null default 'unknown',
        parental_controls  jsonb       not null default '{}'::jsonb,
        created_at         timestamptz not null default now(),
        updated_at         timestamptz not null default now(),
        constraint player_profiles_age_bracket_known check (
          age_bracket in ('unknown','under_13','13_to_15','16_to_17','adult')
        ),
        constraint player_profiles_display_name_length check (
          char_length(display_name) between 1 and 40
        )
      );
    `,
  },
  {
    version: 6,
    name: 'inventory',
    // 04-domain-model §7.3. "This is the join between the economy and play."
    up: `
      create table if not exists inventory_items (
        id             uuid        primary key default gen_random_uuid(),
        user_id        uuid        not null,
        -- A title id, or '*' for cross-game. A text column rather than a nullable FK precisely so
        -- '*' is a VALUE with a meaning rather than a null that every query has to remember to
        -- handle. The FK is enforced by application code against the titles table; the wildcard is
        -- what a null could never express unambiguously.
        title_scope    text        not null,
        item_urn       text        not null,
        source         text        not null,
        quantity       integer     not null default 1,
        -- TRUE = non-tradeable. The anti-pay-to-win control.
        bound          boolean     not null default false,
        entitlement_id text,
        listed_at      timestamptz,
        listing_urn    text,
        acquired_at    timestamptz not null default now(),
        constraint inventory_items_source_known check (
          source in ('purchase','reward','craft','market','grant')
        ),
        constraint inventory_items_quantity_positive check (quantity > 0),
        constraint inventory_items_scope_shape check (
          title_scope = '*' or title_scope ~ '^[0-9a-fA-F-]{36}$'
        ),

        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **A BOUND ITEM CANNOT BE LISTED FOR SALE.**
        --
        -- 04-domain-model §7.3: "anything conferring power is bound and cannot enter the market".
        -- Expressed here as a CHECK rather than as a rule in a route, because a rule in a route is
        -- a rule that the next route forgets. The frozen estate has no such column and relies on
        -- three independent conventions instead — a catalogue policy, a trade engine that happens
        -- to be type-closed over resources, and the fact that entitlements have no transfer path.
        -- Every one of those is a property of what has not been built yet.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        constraint inventory_items_bound_not_listed check (not (bound and listed_at is not null)),
        -- A listing has both halves or neither, so "listed" cannot be half-recorded.
        constraint inventory_items_listing_complete check (
          (listed_at is null) = (listing_urn is null)
        )
      );

      create index if not exists inventory_items_user_idx
        on inventory_items (user_id, title_scope, acquired_at desc);
      -- The market's access path: what is on sale. Partial, so it is the size of the market rather
      -- than the size of every inventory in the estate.
      create index if not exists inventory_items_listed_idx
        on inventory_items (listing_urn)
        where listed_at is not null;
      -- An entitlement grants an item at most once. Partial, because most items have none.
      create unique index if not exists inventory_items_entitlement_uniq
        on inventory_items (entitlement_id, item_urn)
        where entitlement_id is not null;
    `,
  },
  {
    version: 7,
    name: 'provisions',
    // THE ENTITLEMENT BRIDGE. See the file header.
    up: `
      create table if not exists provisions (
        id              uuid        primary key default gen_random_uuid(),
        -- **The idempotency of the whole bridge.** One entitlement provisions one thing, for ever,
        -- however many times the event is redelivered and however many replicas consume it. The
        -- frozen private-world purchase has no such key: worlds has no unique column you could
        -- hang one on, which is one of the six things that would have to exist before a
        -- provisioner could be written at all.
        entitlement_id  text        not null,
        subject         text        not null,
        sku             text        not null,
        scope           text        not null,
        -- ══════════════════════════════════════════════════════════════════════════════════════
        -- **NO FOREIGN KEY, DELIBERATELY.** This column names the title the entitlement's scope
        -- points at, and that title may not be registered here — a scope for a title this
        -- deployment has never heard of, or one registered after the sale.
        --
        -- A FK made the INSERT fail with 23503, which made the webhook answer 500, which made
        -- billing's relay redeliver for ever, and the purchase was NEVER RECORDED AT ALL. That is
        -- the exact class of defect this table exists to end: a customer's money moves and nothing
        -- in the platform knows. Recording a purchase must never depend on the registry being up
        -- to date; an unregistered title becomes a state:'unsupported' row an operator can read
        -- and act on, which is what driveProvision writes. Found by provisioning.test.ts.
        -- ══════════════════════════════════════════════════════════════════════════════════════
        title_id        uuid,
        kind            text        not null,
        state           text        not null default 'pending',
        -- What the title service created, as a URN. Null until it has.
        provisioned_urn text,
        metadata        jsonb       not null default '{}'::jsonb,
        attempts        integer     not null default 0,
        last_error      text,
        lease_owner     text,
        lease_until     timestamptz,
        created_at      timestamptz not null default now(),
        updated_at      timestamptz not null default now(),
        provisioned_at  timestamptz,
        constraint provisions_entitlement_uniq unique (entitlement_id),
        constraint provisions_state_known check (
          state in ('pending','provisioning','provisioned','unsupported','failed')
        ),
        constraint provisions_kind_known check (
          kind in ('private_world','cosmetic','season_pass','convenience','unknown')
        ),
        -- A provisioned row names what it made. Anything else is a row that claims delivery and
        -- cannot say of what — which is exactly the state the frozen estate leaves a customer in.
        constraint provisions_provisioned_is_complete check (
          state <> 'provisioned' or (provisioned_urn is not null and provisioned_at is not null)
        ),
        constraint provisions_failed_says_why check (state <> 'failed' or last_error is not null)
      );

      create index if not exists provisions_outstanding_idx
        on provisions (created_at)
        where state in ('pending','provisioning');
      create index if not exists provisions_subject_idx on provisions (subject, created_at desc);
    `,
  },
  {
    version: 8,
    name: 'achievements_and_seasons',
    up: `
      create table if not exists achievements (
        id             uuid        primary key default gen_random_uuid(),
        title_id       uuid        not null references titles (id) on delete cascade,
        key            text        not null,
        name           text        not null,
        description    text        not null default '',
        points         integer     not null default 0,
        -- Zero for most. A non-zero reward makes this achievement a money instrument and it is
        -- paid through the ledger like any other — see reward_grants.
        reward_shards  numeric(78,0) not null default 0,
        created_at     timestamptz not null default now(),
        constraint achievements_key_uniq unique (title_id, key),
        constraint achievements_points_sane check (points between 0 and 1000),
        constraint achievements_reward_non_negative check (reward_shards >= 0)
      );

      create table if not exists player_achievements (
        user_id        uuid        not null,
        achievement_id uuid        not null references achievements (id) on delete cascade,
        unlocked_at    timestamptz not null default now(),
        -- The primary key IS the idempotency: an achievement unlocks once per account, and a tick
        -- that re-evaluates it conflicts rather than paying twice.
        primary key (user_id, achievement_id)
      );

      create table if not exists seasons (
        id                     uuid        primary key default gen_random_uuid(),
        title_id               uuid        not null references titles (id) on delete cascade,
        slug                   text        not null,
        name                   text        not null,
        starts_at              timestamptz not null,
        ends_at                timestamptz not null,
        status                 text        not null default 'upcoming',
        -- ════════════════════════════════════════════════════════════════════════════════════
        -- **THE BUDGET CAP.** Rewards are ledger postings, so a game exploit that mints rewards
        -- is a money incident rather than a balance complaint. The cap is enforced by the
        -- database, in the same transaction as the grant, so no amount of application-level
        -- cleverness can spend past it. The frozen service has no cap of any kind.
        -- ════════════════════════════════════════════════════════════════════════════════════
        reward_budget_shards   numeric(78,0) not null,
        rewards_granted_shards numeric(78,0) not null default 0,
        created_at             timestamptz not null default now(),
        updated_at             timestamptz not null default now(),
        constraint seasons_slug_uniq unique (title_id, slug),
        constraint seasons_status_known check (status in ('upcoming','active','ended','archived')),
        constraint seasons_dates_ordered check (ends_at > starts_at),
        constraint seasons_budget_positive check (reward_budget_shards > 0),
        constraint seasons_within_budget check (
          rewards_granted_shards >= 0 and rewards_granted_shards <= reward_budget_shards
        )
      );

      create table if not exists reward_grants (
        id              uuid        primary key default gen_random_uuid(),
        season_id       uuid        not null references seasons (id) on delete cascade,
        user_id         uuid        not null,
        title_id        uuid        not null references titles (id) on delete cascade,
        reason          text        not null,
        amount_shards   numeric(78,0) not null,
        -- The ledger entry that paid it. NOT NULL, because a reward with no entry is a payment
        -- that exists only in this service's opinion — which is 04-domain-model §11's whole point.
        journal_entry_id text       not null,
        -- Derived from (season, user, reason), so a retry that lands twice pays once.
        idempotency_key text        not null,
        granted_at      timestamptz not null default now(),
        constraint reward_grants_key_uniq unique (idempotency_key),
        constraint reward_grants_amount_positive check (amount_shards > 0)
      );

      create index if not exists reward_grants_season_idx on reward_grants (season_id, granted_at desc);
    `,
  },
]

/**
 * The version this build requires. `index.ts` asserts it at boot and refuses to serve below it.
 * Here that is more than hygiene: below version 6 the bound constraint does not exist, and below
 * version 8 the budget cap does not.
 */
export const SCHEMA_VERSION: number = MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0)

/**
 * A new service leaves this at 0.
 *
 * The frozen game schema is NOT adopted: it has no version table to baseline against, no title
 * dimension, and its only account-scoped row is a three-column wardrobe. Migration is a data copy
 * described in 10-migration-strategy, not a baseline.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns, for the test harness's truncate. Order is child-first. */
export const TABLES: readonly string[] = Object.freeze([
  'reward_grants',
  'seasons',
  'player_achievements',
  'achievements',
  'provisions',
  'inventory_items',
  'player_profiles',
  'titles',
  'inbox',
  'outbox_deliveries',
  'event_subscriptions',
  'outbox',
])
