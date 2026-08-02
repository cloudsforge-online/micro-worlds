/**
 * The schema, and the constraints that make three defects unrepresentable rather than unlikely.
 *
 * These run the REAL `MIGRATIONS` through the real migrator, on the real database, exactly as a
 * deploy does. A fixture schema would let the constraints drift out of the tests that are supposed
 * to prove they fire.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
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
test('seasons_within_budget: a season cannot be spent past, by anybody', { skip }, async () => {
  const titleId = await aTitle()
  const rows = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_shards)
    values (${titleId}, 's1', 'Season One', now(), now() + interval '90 days', 1000)
    returning id
  `
  const id = rows[0]!.id
  // Even a direct UPDATE — the hand-run one at three in the morning — cannot exceed it.
  await assert.rejects(
    () => sql`update seasons set rewards_granted_shards = 1001 where id = ${id}`,
    /seasons_within_budget/,
  )
  await sql`update seasons set rewards_granted_shards = 1000 where id = ${id}`
  const after = await sql<{ rewards_granted_shards: string }[]>`
    select rewards_granted_shards from seasons where id = ${id}
  `
  assert.equal(after[0]?.rewards_granted_shards, '1000')
})

/**
 * **RAISING A SPENDING LIMIT NEEDS AN APPROVAL; LOWERING ONE DOES NOT.** 21 §7.7, fire-tested.
 *
 * Since migration 9 a season is funded from `engagement:worlds` and its rewards debit that
 * account, so `reward_budget_shards` is a spending limit on real platform money rather than a
 * game-balance number. 21 §6 makes raising an engagement cap an approved act and lowering one
 * free, and `admin-api/src/migrations.ts:512` already enforces that asymmetry on
 * `engagement_policies` with a trigger of its own.
 *
 * This asserts against raw SQL on purpose. `openSeason` translates the refusal into a decent
 * error, but the control has to survive the hand-run UPDATE at three in the morning and the
 * second replica — the same standard `seasons_within_budget` is held to directly above.
 */
test('seasons_budget_raise_needs_approval: a raise needs one, a cut does not', { skip }, async () => {
  const titleId = await aTitle()
  const rows = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_shards)
    values (${titleId}, 's1', 'Season One', now(), now() + interval '90 days', 1000)
    returning id
  `
  const id = rows[0]!.id

  // 1. A bare raise is refused, however it arrives.
  await assert.rejects(
    () => sql`update seasons set reward_budget_shards = 5000 where id = ${id}`,
    /seasons_budget_raise_needs_approval/,
  )

  // 2. A cut lands with nothing named. This is the half the asymmetry exists for: an operator who
  //    wants to spend LESS of the treasury's money must never need a meeting to do it.
  await sql`update seasons set reward_budget_shards = 800 where id = ${id}`

  // 3. A raise that names an approval lands, and the row records what authorised it.
  await sql`
    update seasons set reward_budget_shards = 5000, budget_raise_approval_id = 'approval-a'
     where id = ${id}
  `
  const raised = await sql<{ reward_budget_shards: string; budget_raise_approval_id: string }[]>`
    select reward_budget_shards, budget_raise_approval_id from seasons where id = ${id}
  `
  assert.equal(raised[0]?.reward_budget_shards, '5000')
  assert.equal(raised[0]?.budget_raise_approval_id, 'approval-a')

  // 4. That approval is spent. Re-presenting it, or presenting nothing, raises nothing further —
  //    otherwise one approval would be a standing licence to raise the cap for ever.
  await assert.rejects(
    () => sql`update seasons set reward_budget_shards = 9000 where id = ${id}`,
    /seasons_budget_raise_needs_approval/,
  )
  await assert.rejects(
    () => sql`
      update seasons set reward_budget_shards = 9000, budget_raise_approval_id = 'approval-a'
       where id = ${id}
    `,
    /seasons_budget_raise_needs_approval/,
  )

  // 5. Nor may it be spent on a DIFFERENT season. One approval, one raise, anywhere.
  const other = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_shards)
    values (${titleId}, 's2', 'Season Two', now(), now() + interval '90 days', 100)
    returning id
  `
  await assert.rejects(
    () => sql`
      update seasons set reward_budget_shards = 200, budget_raise_approval_id = 'approval-a'
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
      insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_shards)
      values (${titleId}, 's2', 'Season Two', now(), now() + interval '1 day', 0)
    `,
    /seasons_budget_positive/,
  )
  await assert.rejects(
    () => sql`
      insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_shards)
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
      insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_shards)
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
