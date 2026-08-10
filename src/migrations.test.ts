/**
 * The schema, and the constraints that make three defects unrepresentable rather than unlikely.
 *
 * These run the REAL `MIGRATIONS` through the real migrator, on the real database, exactly as a
 * deploy does. A fixture schema would let the constraints drift out of the tests that are supposed
 * to prove they fire.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { ALICE, enabled, migrateTestDb, openDb, resetWorlds, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetWorlds(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

async function aTitle(slug = 'ashfall'): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    insert into titles (slug, name, status, service_url, capabilities)
    values (${slug}, 'Ashfall', 'live', 'http://127.0.0.1:9000', array['private_world'])
    returning id
  `
  return rows[0]!.id
}

test('the migrator brings an empty database to SCHEMA_VERSION', { skip }, async () => {
  const rows = await sql<{ version: number }[]>`select max(version)::int as version from schema_migrations`
  assert.equal(rows[0]?.version, SCHEMA_VERSION)
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length)
})

test('every table the harness truncates actually exists', { skip }, async () => {
  for (const table of TABLES) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.tables
       where table_schema = 'public' and table_name = ${table}
    `
    assert.equal(rows[0]?.n, 1, table)
  }
})

test('title_id EXISTS — the column whose absence makes a second game impossible', { skip }, async () => {
  // A grep for game_id|title_id across the whole frozen game service returns nothing at all. This
  // asserts the opposite is now true, on the tables that could belong to a title.
  for (const [table, column] of [
    ['achievements', 'title_id'],
    ['seasons', 'title_id'],
    ['reward_grants', 'title_id'],
    ['provisions', 'title_id'],
    ['inventory_items', 'title_scope'],
  ] as const) {
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from information_schema.columns
       where table_name = ${table} and column_name = ${column}
    `
    assert.equal(rows[0]?.n, 1, `${table}.${column}`)
  }
})

/* ------------------------------------------------------------------ the bound constraint */

/**
 * **THE ANTI-PAY-TO-WIN CONTROL, AS A CONSTRAINT.**
 *
 * A rule in a route is a rule the next route forgets, and a rule in a comment is a rule a hand-run
 * UPDATE at three in the morning does not know about. This is the one that survives both.
 */
test('inventory_items_bound_not_listed: a bound item CANNOT be listed for sale', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into inventory_items (user_id, title_scope, item_urn, source, bound, listed_at, listing_urn)
      values (${ALICE}, '*', 'cf:catalogue:item:sword', 'purchase', true, now(), 'cf:market:listing:1')
    `,
    /inventory_items_bound_not_listed/,
  )
})

test('inventory_items_bound_not_listed fires on an UPDATE too, not only on the insert', { skip }, async () => {
  const rows = await sql<{ id: string }[]>`
    insert into inventory_items (user_id, title_scope, item_urn, source, bound)
    values (${ALICE}, '*', 'cf:catalogue:item:sword', 'reward', true)
    returning id
  `
  const id = rows[0]!.id
  await assert.rejects(
    () => sql`update inventory_items set listed_at = now(), listing_urn = 'x' where id = ${id}`,
    /inventory_items_bound_not_listed/,
  )
})

test('an UNBOUND item may be listed', { skip }, async () => {
  const rows = await sql<{ id: string }[]>`
    insert into inventory_items (user_id, title_scope, item_urn, source, bound, listed_at, listing_urn)
    values (${ALICE}, '*', 'cf:catalogue:item:hat', 'purchase', false, now(), 'cf:market:listing:2')
    returning id
  `
  assert.ok(rows[0]?.id)
})

test('a listing is recorded whole or not at all', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into inventory_items (user_id, title_scope, item_urn, source, bound, listed_at)
      values (${ALICE}, '*', 'cf:catalogue:item:hat', 'purchase', false, now())
    `,
    /inventory_items_listing_complete/,
  )
})

test('one entitlement grants one item, once', { skip }, async () => {
  const insert = () => sql`
    insert into inventory_items (user_id, title_scope, item_urn, source, bound, entitlement_id)
    values (${ALICE}, '*', 'cf:catalogue:item:hat', 'purchase', false, 'ent-1')
  `
  await insert()
  await assert.rejects(insert, /inventory_items_entitlement_uniq/)
})

test('a title_scope that is neither a uuid nor the wildcard is refused', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into inventory_items (user_id, title_scope, item_urn, source)
      values (${ALICE}, 'ashfall', 'cf:catalogue:item:hat', 'purchase')
    `,
    /inventory_items_scope_shape/,
  )
})

/* ------------------------------------------------------------------ the budget cap */

/**
 * **REWARDS ARE MONEY, SO THE CAP IS A DATABASE CHECK.**
 *
 * The service this supersedes has no cap of any kind — no daily, weekly, seasonal or global
 * issuance budget, no counter, no alert. A bug that grants an objective twice per tick grants it
 * for ever, bounded only by how long somebody takes to notice.
 */
test('seasons_within_budget_wei: a season cannot be spent past, by anybody', { skip }, async () => {
  const titleId = await aTitle()
  const rows = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
    values (${titleId}, 's1', 'Season One', now(), now() + interval '90 days', 1000)
    returning id
  `
  const id = rows[0]!.id
  // Even a direct UPDATE — the hand-run one at three in the morning — cannot exceed it.
  await assert.rejects(
    () => sql`update seasons set rewards_granted_wei = 1001 where id = ${id}`,
    /seasons_within_budget_wei/,
  )
  await sql`update seasons set rewards_granted_wei = 1000 where id = ${id}`
  const after = await sql<{ rewards_granted_wei: string }[]>`
    select rewards_granted_wei from seasons where id = ${id}
  `
  assert.equal(after[0]?.rewards_granted_wei, '1000')
})

/**
 * **RAISING A SPENDING LIMIT NEEDS AN APPROVAL; LOWERING ONE DOES NOT.** 21 §7.7, fire-tested.
 *
 * Since migration 9 a season is funded from `engagement:worlds` and its rewards debit that
 * account, so `reward_budget_wei` is a spending limit on real platform money rather than a
 * game-balance number. 21 §6 makes raising an engagement cap an approved act and lowering one
 * free, and `admin-api/src/migrations.ts:512` already enforces that asymmetry on
 * `engagement_policies` with a trigger of its own.
 *
 * This asserts against raw SQL on purpose. `openSeason` translates the refusal into a decent
 * error, but the control has to survive the hand-run UPDATE at three in the morning and the
 * second replica — the same standard `seasons_within_budget_wei` is held to directly above.
 */
test('seasons_budget_raise_needs_approval: a raise needs one, a cut does not', { skip }, async () => {
  const titleId = await aTitle()
  const rows = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
    values (${titleId}, 's1', 'Season One', now(), now() + interval '90 days', 1000)
    returning id
  `
  const id = rows[0]!.id

  // 1. A bare raise is refused, however it arrives.
  await assert.rejects(
    () => sql`update seasons set reward_budget_wei = 5000 where id = ${id}`,
    /seasons_budget_raise_needs_approval/,
  )

  // 2. A cut lands with nothing named. This is the half the asymmetry exists for: an operator who
  //    wants to spend LESS of the treasury's money must never need a meeting to do it.
  await sql`update seasons set reward_budget_wei = 800 where id = ${id}`

  // 3. A raise that names an approval lands, and the row records what authorised it.
  await sql`
    update seasons set reward_budget_wei = 5000, budget_raise_approval_id = 'approval-a'
     where id = ${id}
  `
  const raised = await sql<{ reward_budget_wei: string; budget_raise_approval_id: string }[]>`
    select reward_budget_wei, budget_raise_approval_id from seasons where id = ${id}
  `
  assert.equal(raised[0]?.reward_budget_wei, '5000')
  assert.equal(raised[0]?.budget_raise_approval_id, 'approval-a')

  // 4. That approval is spent. Re-presenting it, or presenting nothing, raises nothing further —
  //    otherwise one approval would be a standing licence to raise the cap for ever.
  await assert.rejects(
    () => sql`update seasons set reward_budget_wei = 9000 where id = ${id}`,
    /seasons_budget_raise_needs_approval/,
  )
  await assert.rejects(
    () => sql`
      update seasons set reward_budget_wei = 9000, budget_raise_approval_id = 'approval-a'
       where id = ${id}
    `,
    /seasons_budget_raise_needs_approval/,
  )

  // 5. Nor may it be spent on a DIFFERENT season. One approval, one raise, anywhere.
  const other = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
    values (${titleId}, 's2', 'Season Two', now(), now() + interval '90 days', 100)
    returning id
  `
  await assert.rejects(
    () => sql`
      update seasons set reward_budget_wei = 200, budget_raise_approval_id = 'approval-a'
       where id = ${other[0]!.id}
    `,
    /seasons_budget_raise_approval_uniq/,
  )

  // 6. An update that is not about the budget needs no approval and cannot lose the one on record.
  await sql`update seasons set status = 'active' where id = ${id}`
  const untouched = await sql<{ budget_raise_approval_id: string }[]>`
    select budget_raise_approval_id from seasons where id = ${id}
  `
  assert.equal(untouched[0]?.budget_raise_approval_id, 'approval-a')
})

test('a season needs a positive budget and an end after its start', { skip }, async () => {
  const titleId = await aTitle()
  await assert.rejects(
    () => sql`
      insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
      values (${titleId}, 's2', 'Season Two', now(), now() + interval '1 day', 0)
    `,
    /seasons_budget_wei_positive/,
  )
  await assert.rejects(
    () => sql`
      insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
      values (${titleId}, 's3', 'Season Three', now(), now() - interval '1 day', 100)
    `,
    /seasons_dates_ordered/,
  )
})

test('two titles may both ship a season called s1', { skip }, async () => {
  // The frozen "Season 1" is one hardcoded object in a shared package with no title dimension, so
  // a second title's season is a republish of that package.
  const a = await aTitle('ashfall')
  const b = await aTitle('emberfall')
  for (const titleId of [a, b]) {
    await sql`
      insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
      values (${titleId}, 's1', 'Season One', now(), now() + interval '1 day', 100)
    `
  }
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from seasons where slug = 's1'`
  assert.equal(rows[0]?.n, 2)
})

test('two titles may both ship an achievement called first_blood', { skip }, async () => {
  const a = await aTitle('ashfall')
  const b = await aTitle('emberfall')
  for (const titleId of [a, b]) {
    await sql`
      insert into achievements (title_id, key, name) values (${titleId}, 'first_blood', 'First Blood')
    `
  }
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from achievements`
  assert.equal(rows[0]?.n, 2)
})

/* ------------------------------------------------------------------ provisions */

test('provisions_entitlement_uniq: one entitlement provisions one thing, for ever', { skip }, async () => {
  const insert = () => sql`
    insert into provisions (entitlement_id, subject, sku, scope, kind)
    values ('ent-1', ${'user:' + ALICE}, 'private_saga', 'platform', 'private_world')
  `
  await insert()
  await assert.rejects(insert, /provisions_entitlement_uniq/)
})

test('a provisioned row must name what it made', { skip }, async () => {
  // Anything else is a row that claims delivery and cannot say of what — which is exactly the
  // state a customer is left in today.
  await assert.rejects(
    () => sql`
      insert into provisions (entitlement_id, subject, sku, scope, kind, state)
      values ('ent-2', ${'user:' + ALICE}, 'private_saga', 'platform', 'private_world', 'provisioned')
    `,
    /provisions_provisioned_is_complete/,
  )
})

test('a failed row must say why', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into provisions (entitlement_id, subject, sku, scope, kind, state)
      values ('ent-3', ${'user:' + ALICE}, 'private_saga', 'platform', 'private_world', 'failed')
    `,
    /provisions_failed_says_why/,
  )
})

/* ------------------------------------------------------------------ profiles and titles */

test('a title slug must be a safe URL segment and scope id', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into titles (slug, name, service_url) values ('../etc', 'Bad', 'http://127.0.0.1')
    `,
    /titles_slug_shape/,
  )
})

test('an age bracket outside the known set is refused', { skip }, async () => {
  await assert.rejects(
    () => sql`
      insert into player_profiles (user_id, display_name, age_bracket)
      values (${ALICE}, 'alice', 'probably_fine')
    `,
    /player_profiles_age_bracket_known/,
  )
})

/* --------------------------------------------------- migration 11: Shards become EMBER wei */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE RENAME IS A CONVERSION, AND A CONVERSION HAS TO BE REPLAYED TO BE BELIEVED.**
 *
 * micro-org#226. Every other test in this file runs against a database the migrator brought
 * straight to the head version, so it can only ever see the world AFTER migration 11 — which
 * means it cannot see the one thing that migration does beyond renaming: multiply Shard-era
 * figures by 4e16 so they mean the same money in a unit with eighteen decimals instead of none.
 *
 * This test replays the upgrade. It brings a scratch schema to version 10, writes the rows a
 * pre-#226 database would hold, and then applies 11 and reads them back. On mainnet the same
 * statements touch 47 zeroes and move nothing (measured 2026-08-10, see migrations.ts); a
 * development database with real Shard figures is the case this proves.
 *
 * The trigger is asserted for a second reason. plpgsql binds column names LATE, at first
 * execution, so a body that still said `reward_budget_shards` would survive the migration
 * silently and then raise `record "new" has no field ...` on the first budget change somebody
 * made — a schema error dressed as a runtime one, arriving whenever the next raise happened
 * rather than at deploy. Recreating the function is only proven by running it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('migration 11 converts Shard figures at 4e16 and rebinds the budget trigger', { skip }, async () => {
  const SCHEMA = 'mig11_replay'
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`)
  await sql.unsafe(`create schema ${SCHEMA}`)
  // A separate connection whose search_path is the scratch schema: every statement in MIGRATIONS
  // names its tables unqualified, so this is what makes the replay land beside the real schema
  // instead of on top of it.
  const scratch = postgres(process.env['WORLDS_TEST_DATABASE_URL']!, {
    max: 1,
    onnotice: () => {},
    connection: { search_path: SCHEMA },
  })
  try {
    const upTo = (version: number) => MIGRATIONS.filter((m) => m.version <= version)
    await migrate(scratch as unknown as DbSql, upTo(10), { service: 'worlds-mig11-replay' })

    const titles = await scratch<{ id: string }[]>`
      insert into titles (slug, name, status, service_url, capabilities)
      values ('ashfall', 'Ashfall', 'live', 'http://127.0.0.1:9000', array['private_world'])
      returning id
    `
    const titleId = titles[0]!.id
    // 25 Shards is 25 US cents is 1 EMBER, at the two rates migration 11 freezes.
    await scratch`
      insert into achievements (title_id, key, name, reward_shards)
      values (${titleId}, 'first_blood', 'First Blood', 25)
    `
    const seasons = await scratch<{ id: string }[]>`
      insert into seasons (title_id, slug, name, starts_at, ends_at,
                           reward_budget_shards, rewards_granted_shards)
      values (${titleId}, 's1', 'Season One', now(), now() + interval '90 days', 1000, 25)
      returning id
    `
    const seasonId = seasons[0]!.id
    await scratch`
      insert into reward_grants (season_id, user_id, title_id, reason, amount_shards,
                                 journal_entry_id, idempotency_key)
      values (${seasonId}, ${ALICE}, ${titleId}, 'first_blood', 25, 'entry-1', 'key-1')
    `

    await migrate(scratch as unknown as DbSql, MIGRATIONS, { service: 'worlds-mig11-replay' })

    const WEI_PER_SHARD = 40_000_000_000_000_000n
    const achievement = await scratch<{ reward_wei: string }[]>`select reward_wei from achievements`
    assert.equal(BigInt(achievement[0]!.reward_wei), 25n * WEI_PER_SHARD, '1 EMBER, not 25 wei')
    const season = await scratch<{ reward_budget_wei: string; rewards_granted_wei: string }[]>`
      select reward_budget_wei, rewards_granted_wei from seasons where id = ${seasonId}
    `
    assert.equal(BigInt(season[0]!.reward_budget_wei), 1_000n * WEI_PER_SHARD)
    assert.equal(BigInt(season[0]!.rewards_granted_wei), 25n * WEI_PER_SHARD)
    const grant = await scratch<{ amount_wei: string }[]>`select amount_wei from reward_grants`
    assert.equal(BigInt(grant[0]!.amount_wei), 25n * WEI_PER_SHARD)

    // The converted budget and the converted spend still satisfy the renamed CHECK — a conversion
    // that scaled one and not the other would have failed here rather than at the next grant.
    await assert.rejects(
      () => scratch`
        update seasons set rewards_granted_wei = reward_budget_wei + 1 where id = ${seasonId}
      `,
      /seasons_within_budget_wei/,
    )

    // And the trigger runs on the new column names.
    await assert.rejects(
      () => scratch`update seasons set reward_budget_wei = reward_budget_wei * 2 where id = ${seasonId}`,
      /seasons_budget_raise_needs_approval/,
    )
    await scratch`
      update seasons set reward_budget_wei = reward_budget_wei * 2,
                         budget_raise_approval_id = 'approval-mig11'
       where id = ${seasonId}
    `
    const raised = await scratch<{ reward_budget_wei: string }[]>`
      select reward_budget_wei from seasons where id = ${seasonId}
    `
    assert.equal(BigInt(raised[0]!.reward_budget_wei), 2_000n * WEI_PER_SHARD)
  } finally {
    await scratch.end({ timeout: 5 })
    await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`)
  }
})
