/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ENTITLEMENT BRIDGE, END TO END.**
 *
 * The estate sells a private world for 1,800-2,500 Shards, writes an entitlement, and raises no
 * world. These tests are the proof that it now does — against a REAL title service over a real
 * socket, with the real HTTP client, so the idempotency key, the auth header and the error mapping
 * are all genuinely exercised.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import {
  claimProvision,
  driveProvision,
  findProvisionByEntitlement,
  kindForSku,
  recordGrant,
  reopenProvision,
  userIdOf,
} from './provisioning.ts'
import { listInventory } from './players.ts'
import { registerTitle, titleScope } from './titles.ts'
import type { Db } from './outbox.ts'
import {
  ALICE,
  enabled,
  fakeTitleService,
  grantedEnvelope,
  harness,
  migrateTestDb,
  openDb,
  resetWorlds,
  skip,
  type FakeTitle,
  type Harness,
} from './testsupport.ts'

let sql: postgres.Sql
let db: Db
let title: FakeTitle

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
  title = await fakeTitleService({ slug: 'ashfall', token: 'title-token-ashfall' })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWorlds(sql)
})

after(async () => {
  if (!enabled) return
  await title.close()
  await sql.end({ timeout: 5 })
})

async function registerAshfall(): Promise<string> {
  const record = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    status: 'live',
    serviceUrl: title.baseUrl,
    capabilities: ['private_world', 'achievements', 'seasons'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  return record.id
}

async function deliver(
  h: Harness,
  options: { titleId?: string; sku?: string; entitlementId?: string; eventId?: string } = {},
): Promise<string> {
  const envelope = grantedEnvelope({
    ...(options.eventId ? { id: options.eventId } : {}),
    ...(options.entitlementId ? { entitlementId: options.entitlementId } : {}),
    ...(options.sku ? { sku: options.sku } : {}),
    scope: options.titleId ? titleScope(options.titleId) : 'platform',
  })
  const result = await recordGrant(db, 'worlds', {
    eventId: envelope['id'] as string,
    payload: envelope['payload'] as Record<string, unknown>,
    actor: 'service:billing',
  })
  assert.equal(result.status, 'recorded')
  return result.provision!.id
}

/* ------------------------------------------------------------------ the SKU table */

test('the estate\'s own private-world SKUs are recognised, verbatim', { skip: false }, () => {
  // Carried across so entitlements already written for them are recognised on the first pass
  // rather than needing a backfill.
  assert.equal(kindForSku('private_skirmish'), 'private_world')
  assert.equal(kindForSku('private_saga'), 'private_world')
  assert.equal(kindForSku('season_1_ashfall'), 'season_pass')
  assert.equal(kindForSku('frame_ember'), 'cosmetic')
})

test('an unrecognised SKU is `unknown`, not a guess', { skip: false }, () => {
  // A customer who paid for something this service does not know how to deliver is an operator's
  // problem NOW rather than in six months.
  assert.equal(kindForSku('mystery_box'), 'unknown')
})

test('a ledger subject yields the bare user id a title expects', { skip: false }, () => {
  assert.equal(userIdOf(`user:${ALICE}`), ALICE)
})

/* ------------------------------------------------------------------ THE HEADLINE */

/**
 * The whole point of this service, in one test.
 */
test('a granted private-world entitlement PROVISIONS A WORLD', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })

  assert.equal(await driveProvision(h.provision, provisionId), 'provisioned')

  // The title actually raised one.
  assert.equal(title.provisioned.length, 1)
  assert.equal(title.provisioned[0]?.sku, 'private_saga')

  // The row records what was made.
  const provision = await findProvisionByEntitlement(db, 'ent-1')
  assert.equal(provision?.state, 'provisioned')
  assert.ok(provision?.provisionedUrn)
  assert.ok(provision?.provisionedAt)

  // The customer's inventory names it, BOUND — a world you own is not something you may resell.
  const inventory = await listInventory(db, { userId: ALICE })
  assert.equal(inventory.length, 1)
  assert.equal(inventory[0]?.itemUrn, provision?.provisionedUrn)
  assert.equal(inventory[0]?.bound, true)
  assert.equal(inventory[0]?.entitlementId, 'ent-1')

  // And an event says so, naming the entitlement that paid for it.
  const events = await sql<{ topic: string; payload: Record<string, unknown> }[]>`
    select topic, payload from outbox where topic = 'worlds.provision.completed'
  `
  assert.equal(events[0]?.payload['entitlementId'], 'ent-1')
  assert.equal(events[0]?.payload['urn'], provision?.provisionedUrn)
})

test('the world name the customer typed reaches the title', { skip }, async () => {
  // Pay's `meta` carries it and nothing has ever read it. This is that field arriving somewhere
  // that can use it.
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  await driveProvision(h.provision, provisionId)
  const provision = await findProvisionByEntitlement(db, 'ent-1')
  assert.equal(provision?.metadata['worldName'], 'Ashvale Refuge')
  assert.equal(provision?.metadata['maxPlayers'], 40)
})

/* ------------------------------------------------------------------ idempotency */

test('a redelivered event provisions nothing a second time', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const envelope = grantedEnvelope({ scope: titleScope(titleId) })
  const first = await recordGrant(db, 'worlds', {
    eventId: envelope['id'] as string,
    payload: envelope['payload'] as Record<string, unknown>,
    actor: 'service:billing',
  })
  const second = await recordGrant(db, 'worlds', {
    eventId: envelope['id'] as string,
    payload: envelope['payload'] as Record<string, unknown>,
    actor: 'service:billing',
  })
  assert.equal(first.status, 'recorded')
  assert.equal(second.status, 'duplicate', 'the inbox deduped the redelivery')

  await driveProvision(h.provision, first.provision!.id)
  assert.equal(title.provisioned.length, 1)
})

test('the same entitlement under a DIFFERENT event id is still deduped', { skip }, async () => {
  // What happens when billing replays its outbox after a restore: new event ids, same
  // entitlements. The inbox cannot help there; `provisions_entitlement_uniq` is the second line.
  const h = harness(sql)
  const titleId = await registerAshfall()
  await deliver(h, { titleId, eventId: '44444444-4444-4444-8444-444444444444' })
  const replay = await recordGrant(db, 'worlds', {
    eventId: '55555555-5555-4555-8555-555555555555',
    payload: (grantedEnvelope({ scope: titleScope(titleId) })['payload']) as Record<string, unknown>,
    actor: 'service:billing',
  })
  assert.equal(replay.status, 'duplicate')
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from provisions`
  assert.equal(rows[0]?.n, 1)
})

test('two replicas racing one provision raise ONE world', { skip }, async () => {
  const titleId = await registerAshfall()
  const a = harness(sql, { owner: 'replica-a' })
  const b = harness(sql, { owner: 'replica-b' })
  const provisionId = await deliver(a, { titleId })

  const results = await Promise.all([
    driveProvision(a.provision, provisionId),
    driveProvision(b.provision, provisionId),
  ])
  assert.equal(results.filter((r) => r === 'provisioned').length, 1)
  assert.equal(results.filter((r) => r === 'not_claimed').length, 1)
  assert.equal(title.provisioned.length, 1, 'exactly one world was raised')
})

test('the lease is a single conditional UPDATE: two claims, one winner', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  const [a, b] = await Promise.all([
    claimProvision(db, { id: provisionId, owner: 'a', leaseMs: 60_000 }),
    claimProvision(db, { id: provisionId, owner: 'b', leaseMs: 60_000 }),
  ])
  assert.equal([a, b].filter(Boolean).length, 1)
})

/* ------------------------------------------------------------------ failure paths */

/**
 * A brief 5xx is absorbed by the HTTP client, not by the job.
 *
 * `HttpClient` retries a POST that carries an idempotency key — three attempts by default — so a
 * title that drops one request never reaches `driveProvision`'s failure path at all. That is the
 * right layering and this test pins it: a restart of a second or two is invisible, and the job's
 * retry budget is reserved for outages that outlast the request.
 */
test('a title that drops one request is retried transparently by the client', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  title.failNext(1)

  assert.equal(await driveProvision(h.provision, provisionId), 'provisioned')
  assert.equal(title.provisioned.length, 1)
})

test('a title that is down for a whole request is RETRIED by the job, not failed', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  // Enough to exhaust the client's own attempts, so the failure reaches the job.
  title.failNext(3)

  assert.equal(await driveProvision(h.provision, provisionId), 'retry')
  const deferred = await findProvisionByEntitlement(db, 'ent-1')
  assert.equal(deferred?.state, 'pending', 'the row is claimable again immediately')
  assert.ok(deferred?.lastError)

  // The next tick sends the SAME entitlement id, which the title recognises.
  assert.equal(await driveProvision(h.provision, provisionId), 'provisioned')
  assert.equal(title.provisioned.length, 1)
})

test('a title that is unreachable for the whole attempt budget FAILS, and says so', { skip }, async () => {
  // Not retried for ever: a title unreachable for N attempts is an incident, and a busy loop
  // against it hides that behind a flat graph.
  const h = harness(sql, { maxAttempts: 2 })
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  title.failNext(30)

  assert.equal(await driveProvision(h.provision, provisionId), 'retry')
  assert.equal(await driveProvision(h.provision, provisionId), 'failed')

  const provision = await findProvisionByEntitlement(db, 'ent-1')
  assert.equal(provision?.state, 'failed')
  assert.match(provision?.lastError ?? '', /gave up after/)
  title.failNext(0)
})

test('a failed provision emits the event a refund starts from', { skip }, async () => {
  const h = harness(sql, { maxAttempts: 1 })
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  title.failNext(30)
  await driveProvision(h.provision, provisionId)

  const events = await sql<{ payload: Record<string, unknown> }[]>`
    select payload from outbox where topic = 'worlds.provision.failed'
  `
  // The entitlement id is the one field a human triaging this cannot do without, and the frozen
  // estate records no link between the money and the entitlement in either direction.
  assert.equal(events[0]?.payload['entitlementId'], 'ent-1')
  assert.equal(events[0]?.payload['sku'], 'private_saga')
  title.failNext(0)
})

test('a failed provision is NOT retried by a background poll', { skip }, async () => {
  const h = harness(sql, { maxAttempts: 1 })
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  title.failNext(30)
  await driveProvision(h.provision, provisionId)
  title.failNext(0)

  // A poll that resurrects failures repeats whatever caused them, at the rate of the poll.
  assert.equal(await driveProvision(h.provision, provisionId), 'not_claimed')
  assert.equal(await claimProvision(db, { id: provisionId, owner: 'x', leaseMs: 1_000 }), null)
})

test('an operator\'s explicit retry is the only way out of failed', { skip }, async () => {
  const h = harness(sql, { maxAttempts: 1 })
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  title.failNext(30)
  await driveProvision(h.provision, provisionId)
  title.failNext(0)

  const reopened = await reopenProvision(db, provisionId)
  assert.equal(reopened?.state, 'pending')
  assert.equal(reopened?.attempts, 0)
  assert.equal(await driveProvision(h.provision, provisionId), 'provisioned')
})

test('a SKU the title does not sell is `unsupported`, and terminal', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId, sku: 'private_luxury', entitlementId: 'ent-2' })
  assert.equal(await driveProvision(h.provision, provisionId), 'unsupported')
  const provision = await findProvisionByEntitlement(db, 'ent-2')
  assert.equal(provision?.state, 'unsupported')
})

test('a scope that names no registered title is `unsupported`, with the reason on the row', { skip }, async () => {
  const h = harness(sql)
  const provisionId = await deliver(h, {
    titleId: '99999999-9999-4999-8999-999999999999',
    entitlementId: 'ent-3',
  })
  assert.equal(await driveProvision(h.provision, provisionId), 'unsupported')
  const provision = await findProvisionByEntitlement(db, 'ent-3')
  assert.match(provision?.lastError ?? '', /does not name a registered title/)
})

test('a title that does not declare the capability is asked NOTHING', { skip }, async () => {
  // Checked before the call rather than discovered from a 404, so a catalogue mistake produces a
  // row an operator can read instead of a retry loop.
  const h = harness(sql)
  const record = await registerTitle(db, 'worlds', {
    slug: 'emberfall',
    name: 'Emberfall',
    status: 'live',
    serviceUrl: title.baseUrl,
    capabilities: ['cosmetics'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const before = title.provisioned.length
  const provisionId = await deliver(h, { titleId: record.id, entitlementId: 'ent-4' })
  assert.equal(await driveProvision(h.provision, provisionId), 'unsupported')
  assert.equal(title.provisioned.length, before, 'the title was never called')
})

test('an unknown SKU is recorded and named rather than swallowed', { skip }, async () => {
  const h = harness(sql)
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId, sku: 'mystery_box', entitlementId: 'ent-5' })
  assert.equal(await driveProvision(h.provision, provisionId), 'unsupported')
  const provision = await findProvisionByEntitlement(db, 'ent-5')
  assert.equal(provision?.kind, 'unknown')
  assert.match(provision?.lastError ?? '', /no delivery is defined/)
})

/* ------------------------------------------------------------------ local delivery */

test('a cosmetic is delivered without a title service, and is NOT bound', { skip }, async () => {
  // A cosmetic confers no power, so it may be traded — which is the whole reason `bound` is a
  // per-item fact rather than a per-source one.
  const h = harness(sql)
  const provisionId = await deliver(h, { sku: 'frame_ember', entitlementId: 'ent-6' })
  assert.equal(await driveProvision(h.provision, provisionId), 'provisioned')
  const items = await listInventory(db, { userId: ALICE })
  assert.equal(items.length, 1)
  assert.equal(items[0]?.bound, false)
  assert.equal(items[0]?.titleScope, '*', 'a platform-scoped cosmetic is cross-game')
})

test('provisioning can be turned off without losing anything', { skip }, async () => {
  const h = harness(sql, { enabled: false })
  const titleId = await registerAshfall()
  const provisionId = await deliver(h, { titleId })
  assert.equal(await driveProvision(h.provision, provisionId), 'skipped')
  const provision = await findProvisionByEntitlement(db, 'ent-1')
  assert.equal(provision?.state, 'pending', 'the row is waiting, not lost')
})

/* ------------------------------------------------------------------ malformed events */

test('an event with no entitlement id is a permanent fault, not a retry', { skip }, async () => {
  await assert.rejects(
    () =>
      recordGrant(db, 'worlds', {
        eventId: '66666666-6666-4666-8666-666666666666',
        payload: { subject: `user:${ALICE}`, sku: 'private_saga', scope: 'platform' },
        actor: 'service:billing',
      }),
    /requires a non-empty entitlementId/,
  )
})
