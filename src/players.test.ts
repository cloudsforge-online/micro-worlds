/**
 * The player, the wardrobe, and the bound item.
 *
 * The test this file exists for is `a bound item cannot be listed for sale`. Everything else here
 * is the account-scoping that makes a second title possible.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import {
  BoundItemError,
  CROSS_TITLE,
  InventoryError,
  equipCosmetic,
  findItem,
  findProfile,
  listForSale,
  listInventory,
  unlist,
  upsertProfile,
} from './players.ts'
import { withOutbox, type Db } from './outbox.ts'
import { grantItem } from './players.ts'
import { registerTitle } from './titles.ts'
import { ALICE, BOB, enabled, migrateTestDb, openDb, resetWorlds, skip } from './testsupport.ts'

let sql: postgres.Sql
let db: Db

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
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

async function grant(
  overrides: { bound?: boolean; titleScope?: string; itemUrn?: string; userId?: string } = {},
): Promise<string> {
  const item = await withOutbox(db, 'worlds', async (tx, emit) =>
    grantItem(tx, emit, {
      userId: overrides.userId ?? ALICE,
      titleScope: overrides.titleScope ?? CROSS_TITLE,
      itemUrn: overrides.itemUrn ?? 'cf:catalogue:item:hat',
      source: 'purchase',
      bound: overrides.bound ?? false,
      actor: `user:${ALICE}`,
      correlationId: 'req-1',
    }),
  )
  assert.ok(item)
  return item.id
}

/* ------------------------------------------------------------------ THE BOUND CONTROL */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A BOUND ITEM CANNOT BE LISTED FOR SALE.** 04-domain-model §7.3.
 *
 * The frozen estate has no such column. It relies on three independent conventions: a catalogue
 * policy stated in a comment, a trade engine that happens to be type-closed over resource names,
 * and the fact that entitlements have no transfer path because nobody has written one. Every one
 * of those is a property of what has NOT been built yet.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a bound item cannot be listed for sale', { skip }, async () => {
  const id = await grant({ bound: true, itemUrn: 'cf:ashfall:world:1' })
  await assert.rejects(
    () =>
      listForSale(db, 'worlds', {
        itemId: id,
        userId: ALICE,
        listingUrn: 'cf:market:listing:1',
        actor: `user:${ALICE}`,
        correlationId: 'req-2',
      }),
    BoundItemError,
  )
  const item = await findItem(db, id)
  assert.equal(item?.listedAt, null, 'nothing was written')
  assert.equal(item?.listingUrn, null)
})

test('the refusal names the reason, because "never" and "not now" are different sentences', { skip }, async () => {
  const id = await grant({ bound: true })
  await assert.rejects(
    () =>
      listForSale(db, 'worlds', {
        itemId: id,
        userId: ALICE,
        listingUrn: 'cf:market:listing:1',
        actor: `user:${ALICE}`,
        correlationId: 'req-2',
      }),
    /bound to your account/,
  )
})

test('an unbound item lists, and emits the event a market consumes', { skip }, async () => {
  const id = await grant({ bound: false })
  const item = await listForSale(db, 'worlds', {
    itemId: id,
    userId: ALICE,
    listingUrn: 'cf:market:listing:1',
    actor: `user:${ALICE}`,
    correlationId: 'req-2',
  })
  assert.ok(item.listedAt)
  assert.equal(item.listingUrn, 'cf:market:listing:1')
  const events = await sql<{ topic: string }[]>`
    select topic from outbox where key = ${id} order by occurred_at
  `
  assert.deepEqual(events.map((e) => e.topic), ['worlds.inventory.granted', 'worlds.inventory.listed'])
})

test('the granted event carries `bound`, so a market knows before it offers a sell button', { skip }, async () => {
  const id = await grant({ bound: true })
  const events = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where key = ${id}
  `
  assert.equal(events[0]?.payload['bound'], true)
})

test('listing an item twice is a state conflict, not a second listing', { skip }, async () => {
  const id = await grant()
  await listForSale(db, 'worlds', {
    itemId: id,
    userId: ALICE,
    listingUrn: 'cf:market:listing:1',
    actor: `user:${ALICE}`,
    correlationId: 'req-2',
  })
  await assert.rejects(
    () =>
      listForSale(db, 'worlds', {
        itemId: id,
        userId: ALICE,
        listingUrn: 'cf:market:listing:2',
        actor: `user:${ALICE}`,
        correlationId: 'req-3',
      }),
    /already listed/,
  )
})

test('somebody else\'s item is a not-found, never a bound refusal', { skip }, async () => {
  // A distinct answer for "exists but is not yours" is an oracle that lets a caller enumerate
  // which item ids exist — and, worse here, which of them are bound.
  const id = await grant({ bound: true })
  await assert.rejects(
    () =>
      listForSale(db, 'worlds', {
        itemId: id,
        userId: BOB,
        listingUrn: 'cf:market:listing:1',
        actor: `user:${BOB}`,
        correlationId: 'req-2',
      }),
    (err: unknown) => err instanceof InventoryError && !(err instanceof BoundItemError),
  )
})

test('withdrawing a listing is always permitted', { skip }, async () => {
  const id = await grant()
  await listForSale(db, 'worlds', {
    itemId: id,
    userId: ALICE,
    listingUrn: 'cf:market:listing:1',
    actor: `user:${ALICE}`,
    correlationId: 'req-2',
  })
  const item = await unlist(db, id, ALICE)
  assert.equal(item?.listedAt, null)
})

/* ------------------------------------------------------------------ account scoping */

test('a profile is ACCOUNT-scoped and outlives any world', { skip }, async () => {
  const profile = await upsertProfile(db, {
    userId: ALICE,
    displayName: 'Ashvale Wanderer',
    ageBracket: '16_to_17',
  })
  assert.equal(profile.userId, ALICE)
  assert.equal(profile.ageBracket, '16_to_17')
  assert.equal(profile.reputation, 0)
})

test('a caller that omits an age bracket does not downgrade a known one to unknown', { skip }, async () => {
  // A safeguarding control quietly switching off because a client sent a partial update is
  // exactly the sort of thing nobody notices until it matters.
  await upsertProfile(db, { userId: ALICE, displayName: 'alice', ageBracket: 'under_13' })
  await upsertProfile(db, { userId: ALICE, displayName: 'alice renamed' })
  const profile = await findProfile(db, ALICE)
  assert.equal(profile?.ageBracket, 'under_13')
  assert.equal(profile?.displayName, 'alice renamed')
})

test('a display name is bounded, in the application and in the database', { skip }, async () => {
  await assert.rejects(() => upsertProfile(db, { userId: ALICE, displayName: '' }), /1 to 40/)
  await assert.rejects(
    () => upsertProfile(db, { userId: ALICE, displayName: 'x'.repeat(41) }),
    /1 to 40/,
  )
})

/* ------------------------------------------------------------------ the wardrobe */

test('the wardrobe is keyed by TITLE, so two titles hold different frames', { skip }, async () => {
  // The frozen wardrobe is one flat Partial<Record<CosmeticKind, string>> per account, so with a
  // second title this is a bug with no fix short of a schema change.
  await upsertProfile(db, { userId: ALICE, displayName: 'alice' })
  const ashfall = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['cosmetics'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const emberfall = await registerTitle(db, 'worlds', {
    slug: 'emberfall',
    name: 'Emberfall',
    serviceUrl: 'http://127.0.0.1:9002',
    capabilities: ['cosmetics'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })

  await equipCosmetic(db, {
    userId: ALICE,
    titleScope: ashfall.id,
    slot: 'avatar_frame',
    itemUrn: 'frame_ember',
  })
  const profile = await equipCosmetic(db, {
    userId: ALICE,
    titleScope: emberfall.id,
    slot: 'avatar_frame',
    itemUrn: 'frame_ash',
  })

  assert.equal(profile.equippedCosmetics[ashfall.id]?.['avatar_frame'], 'frame_ember')
  assert.equal(profile.equippedCosmetics[emberfall.id]?.['avatar_frame'], 'frame_ash')
})

test('clearing a slot removes it, and removes the title key when it is the last one', { skip }, async () => {
  await upsertProfile(db, { userId: ALICE, displayName: 'alice' })
  await equipCosmetic(db, {
    userId: ALICE,
    titleScope: CROSS_TITLE,
    slot: 'avatar_frame',
    itemUrn: 'frame_ember',
  })
  const profile = await equipCosmetic(db, {
    userId: ALICE,
    titleScope: CROSS_TITLE,
    slot: 'avatar_frame',
    itemUrn: null,
  })
  assert.deepEqual(profile.equippedCosmetics, {})
})

test('two slots equipped in the same second do not drop each other', { skip }, async () => {
  // Each request names only the slots it changes, so without the row lock both would read the old
  // map and the later write would drop the earlier slot. Carried forward from the frozen service,
  // which explains this defect in its own comment.
  await upsertProfile(db, { userId: ALICE, displayName: 'alice' })
  await Promise.all([
    equipCosmetic(db, { userId: ALICE, titleScope: CROSS_TITLE, slot: 'avatar_frame', itemUrn: 'a' }),
    equipCosmetic(db, { userId: ALICE, titleScope: CROSS_TITLE, slot: 'name_color', itemUrn: 'b' }),
  ])
  const profile = await findProfile(db, ALICE)
  assert.deepEqual(profile?.equippedCosmetics[CROSS_TITLE], { avatar_frame: 'a', name_color: 'b' })
})

/* ------------------------------------------------------------------ inventory scoping */

test('a title sees its own items AND the cross-game ones', { skip }, async () => {
  const title = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['inventory'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  await grant({ titleScope: title.id, itemUrn: 'cf:ashfall:item:1' })
  await grant({ titleScope: CROSS_TITLE, itemUrn: 'cf:catalogue:item:hat' })

  const scoped = await listInventory(db, { userId: ALICE, titleScope: title.id })
  assert.equal(scoped.length, 2, 'a cross-game item is visible inside a title')

  const everything = await listInventory(db, { userId: ALICE })
  assert.equal(everything.length, 2)
})

test('one title does not see another title\'s items', { skip }, async () => {
  const a = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: [],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const b = await registerTitle(db, 'worlds', {
    slug: 'emberfall',
    name: 'Emberfall',
    serviceUrl: 'http://127.0.0.1:9002',
    capabilities: [],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  await grant({ titleScope: a.id, itemUrn: 'cf:ashfall:item:1' })
  const scoped = await listInventory(db, { userId: ALICE, titleScope: b.id })
  assert.equal(scoped.length, 0)
})

test('an entitlement grants an item once, however many times the event arrives', { skip }, async () => {
  const first = await withOutbox(db, 'worlds', async (tx, emit) =>
    grantItem(tx, emit, {
      userId: ALICE,
      titleScope: CROSS_TITLE,
      itemUrn: 'cf:catalogue:item:hat',
      source: 'purchase',
      bound: false,
      entitlementId: 'ent-1',
      actor: 'service:worlds',
      correlationId: 'req-1',
    }),
  )
  const second = await withOutbox(db, 'worlds', async (tx, emit) =>
    grantItem(tx, emit, {
      userId: ALICE,
      titleScope: CROSS_TITLE,
      itemUrn: 'cf:catalogue:item:hat',
      source: 'purchase',
      bound: false,
      entitlementId: 'ent-1',
      actor: 'service:worlds',
      correlationId: 'req-2',
    }),
  )
  assert.ok(first)
  assert.equal(second, null, 'the redelivery granted nothing')
  const items = await listInventory(db, { userId: ALICE })
  assert.equal(items.length, 1)
})
