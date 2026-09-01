/**
 * Right to erasure, end to end — micro-org#491.
 *
 * The load-bearing test here is `tracesOf`: a sweep of EVERY base table in the schema for the raw
 * uuid, driven off `information_schema` rather than a hand-written list. A per-table assertion only
 * proves the tables somebody remembered; this one fails on the column a future migration adds and
 * nobody wires into `eraseUser` — which is exactly how this service came to store a user id in six
 * places and erase none of them.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { eraseUser, type ErasureOutcome } from './erasure.ts'
import type { Tx } from './outbox.ts'
import { ALICE, BOB, enabled, migrateTestDb, openDb, resetWorlds, skip } from './testsupport.ts'

let sql: postgres.Sql

before(async () => {
  if (!enabled) return
  sql = openDb()
  await migrateTestDb(sql)
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWorlds(sql)
})

/**
 * Every base table still containing the id anywhere in any column.
 *
 * `t::text` casts the whole row — jsonb included — so this finds the id in a payload as readily as
 * in a `uuid` column, and the table list comes from the catalogue so a table added tomorrow is
 * swept without anybody remembering to add it here.
 */
async function tracesOf(userId: string): Promise<string[]> {
  const tables = await sql<{ table_name: string }[]>`
    select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'
     order by table_name
  `
  const found: string[] = []
  for (const table of tables) {
    const rows = await sql.unsafe<{ n: number }[]>(
      `select count(*)::int as n from "${table.table_name}" t where t::text like $1`,
      [`%${userId}%`],
    )
    if ((rows[0]?.n ?? 0) > 0) found.push(table.table_name)
  }
  return found
}

/** The handler, in its own transaction — the shape `withInbox` gives it. */
async function erase(userId: string): Promise<ErasureOutcome> {
  const wrapped = await sql.begin(async (tx) => ({
    value: await eraseUser(tx as unknown as Tx, userId),
  }))
  return (wrapped as unknown as { value: ErasureOutcome }).value
}

/** One of everything this service can hold about a person, for two people. */
async function seed(): Promise<{ titleId: string; seasonId: string; achievementId: string }> {
  // `titles_slug_shape` is `^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$` — three characters minimum. A
  // one-letter fixture slug is the kind of thing that only fails where the database is, which is
  // why this file is worth running against a real one.
  const [title] = await sql<{ id: string }[]>`
    insert into titles (slug, name, service_url)
    values ('erasure-title', 'Erasure', 'http://erasure.invalid') returning id
  `
  const titleId = title!.id
  const [season] = await sql<{ id: string }[]>`
    insert into seasons (title_id, slug, name, starts_at, ends_at, reward_budget_wei)
    values (${titleId}, 'erasure-season', 'Erasure', now(), now() + interval '30 days', 1000)
    returning id
  `
  const seasonId = season!.id
  const [achievement] = await sql<{ id: string }[]>`
    insert into achievements (title_id, key, name)
    values (${titleId}, 'erasure-key', 'Erasure') returning id
  `
  const achievementId = achievement!.id

  for (const user of [ALICE, BOB]) {
    await sql`insert into player_profiles (user_id, display_name) values (${user}, 'name')`
    await sql`insert into player_achievements (user_id, achievement_id) values (${user}, ${achievementId})`
    await sql`
      insert into inventory_items (user_id, title_scope, item_urn, source)
      values (${user}, '*', 'urn:item:1', 'reward')
    `
    await sql`
      insert into reward_grants (season_id, user_id, title_id, reason, amount_wei, journal_entry_id, idempotency_key)
      values (${seasonId}, ${user}, ${titleId}, 'season', 10, ${'journal-' + user.slice(0, 4)},
              ${`worlds:reward:${seasonId}:${user}:season`})
    `
    await sql`
      insert into provisions (entitlement_id, subject, sku, scope, kind, metadata)
      values (${'ent-' + user.slice(0, 4)}, ${'user:' + user}, 'sku', '*', 'cosmetic',
              ${sql.json({ buyer: user })})
    `
    await sql`
      insert into outbox (topic, key, producer, actor, payload)
      values ('worlds.profile.updated', ${'player:' + user}, 'worlds', ${'user:' + user},
              ${sql.json({ userId: user })})
    `
  }
  return { titleId, seasonId, achievementId }
}

test('ERASURE: the whole footprint goes, and the sweep finds the id in no column of any table', { skip }, async () => {
  await seed()

  // Before: the id is genuinely present, so a passing sweep afterwards means something.
  assert.deepEqual(
    (await tracesOf(ALICE)).sort(),
    ['inventory_items', 'outbox', 'player_achievements', 'player_profiles', 'provisions', 'reward_grants'],
  )

  const outcome = await erase(ALICE)
  assert.deepEqual(outcome, {
    profiles: 1,
    achievements: 1,
    inventory: 1,
    grants: 1,
    provisions: 1,
    outbox: 1,
  })

  // THE ASSERTION THIS FILE EXISTS FOR.
  assert.deepEqual(await tracesOf(ALICE), [])
})

test('ERASURE: it touches nobody else', { skip }, async () => {
  await seed()
  await erase(ALICE)

  // Bob is untouched in every table, including the two that were rewritten rather than emptied.
  assert.deepEqual(
    (await tracesOf(BOB)).sort(),
    ['inventory_items', 'outbox', 'player_achievements', 'player_profiles', 'provisions', 'reward_grants'],
  )
})

test('ERASURE: the retained rows keep the facts they are retained FOR', { skip }, async () => {
  await seed()
  await erase(ALICE)

  // reward_grants is kept for the ledger link and the double-grant guard. Both must survive, or
  // retaining the row bought nothing and the erasure should have deleted it.
  const [grant] = await sql<{ journal_entry_id: string; idempotency_key: string; amount_wei: string }[]>`
    select journal_entry_id, idempotency_key, amount_wei from reward_grants
     where journal_entry_id = ${'journal-' + ALICE.slice(0, 4)}
  `
  assert.equal(grant?.journal_entry_id, 'journal-' + ALICE.slice(0, 4))
  assert.equal(grant?.amount_wei, '10')

  // provisions is kept so one purchase cannot become two. The entitlement is the uniqueness key.
  const [provision] = await sql<{ entitlement_id: string; sku: string; subject: string }[]>`
    select entitlement_id, sku, subject from provisions where entitlement_id = ${'ent-' + ALICE.slice(0, 4)}
  `
  assert.equal(provision?.sku, 'sku')
  // The erased spelling, never a bare uuid and never null — `subject` is `not null`.
  assert.match(provision?.subject ?? '', /^erased:[0-9a-f-]{36}$/)
})

test('ERASURE: an undelivered outbox row is redacted, not dropped', { skip }, async () => {
  await seed()
  const before = await sql<{ n: number }[]>`select count(*)::int as n from outbox`
  await erase(ALICE)
  const after = await sql<{ n: number }[]>`select count(*)::int as n from outbox`

  // Same number of rows. Dropping an unpublished row would lose an event that still has to be
  // delivered — every other subscriber is erasing the same person on the same signal.
  assert.equal(after[0]?.n, before[0]?.n)
})

test('ERASURE: erasing a user this service has never seen is a no-op, not an error', { skip }, async () => {
  await seed()
  const outcome = await erase('33333333-3333-4333-8333-333333333333')
  assert.deepEqual(outcome, { profiles: 0, achievements: 0, inventory: 0, grants: 0, provisions: 0, outbox: 0 })
  // And it did not disturb the people who ARE here.
  assert.equal((await tracesOf(ALICE)).length, 6)
})
