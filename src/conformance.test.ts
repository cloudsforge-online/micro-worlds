/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **"A SECOND GAME IS POSSIBLE" — AS A TEST RATHER THAN A CLAIM.**
 *
 * Two title services are started, on two sockets, with different slugs. Both are registered, both
 * pass the conformance suite, and both provision a private world through the same bridge with no
 * change to this service. That is the demonstration.
 *
 * The other half is that the suite CATCHES a breach. A conformance suite that only ever passes
 * against something that happens to be right is a suite nobody can trust, so each check is also
 * exercised against a title that breaks it on purpose — most importantly the idempotency one,
 * whose failure mode is raising a second world for one purchase.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import { formatReport, runConformance } from './conformance.ts'
import { driveProvision, recordGrant } from './provisioning.ts'
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
} from './testsupport.ts'

let sql: postgres.Sql
let db: Db
let ashfall: FakeTitle
let emberfall: FakeTitle

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
  ashfall = await fakeTitleService({ slug: 'ashfall', token: 'title-token-ashfall' })
  // A SECOND, INDEPENDENT TITLE. Different slug, different socket, different SKU set.
  emberfall = await fakeTitleService({
    slug: 'emberfall',
    token: 'title-token-ashfall',
    capabilities: ['private_world', 'cosmetics'],
    skus: ['private_saga'],
  })
})

beforeEach(async () => {
  if (!enabled) return
  await resetWorlds(sql)
})

after(async () => {
  if (!enabled) return
  await ashfall.close()
  await emberfall.close()
  await sql.end({ timeout: 5 })
})

/* ------------------------------------------------------------------ the suite passes */

for (const which of ['ashfall', 'emberfall'] as const) {
  test(`${which} passes every conformance check`, { skip }, async () => {
    const title = which === 'ashfall' ? ashfall : emberfall
    const report = await runConformance({
      baseUrl: title.baseUrl,
      token: title.token,
      sku: 'private_saga',
    })
    // The formatted report is in the assertion message, so a failure names which check and why
    // rather than saying `false !== true`.
    assert.equal(report.passed, true, formatReport(report))
    assert.equal(report.slug, which)
    assert.equal(report.checks.length, 9)
  })
}

/* ------------------------------------------------------------------ the suite catches a breach */

test('a title that IGNORES the idempotency key fails — the check that matters most', { skip }, async () => {
  // The bridge is at-least-once by construction. A title that ignores the key raises a second
  // world for one purchase, which is the mirror image of the defect the bridge exists to fix.
  const broken = await fakeTitleService({
    slug: 'careless',
    breaks: { idempotency: true },
  })
  try {
    const report = await runConformance({
      baseUrl: broken.baseUrl,
      token: broken.token,
      sku: 'private_saga',
    })
    assert.equal(report.passed, false)
    const check = report.checks.find((c) => c.id === 'idempotency')
    assert.equal(check?.passed, false)
    assert.match(check?.detail ?? '', /SECOND world for one purchase/)
    // And it is the ONLY thing wrong with it, which is what makes this a targeted check rather
    // than a suite that fails everything when anything is off.
    assert.deepEqual(
      report.checks.filter((c) => !c.passed).map((c) => c.id),
      ['idempotency'],
    )
  } finally {
    await broken.close()
  }
})

test('a title that provisions for ANYONE fails the authentication checks', { skip }, async () => {
  // A provisioning endpoint that anybody can reach is a free-worlds endpoint.
  const broken = await fakeTitleService({ slug: 'wideopen', breaks: { authentication: true } })
  try {
    const report = await runConformance({
      baseUrl: broken.baseUrl,
      token: broken.token,
      sku: 'private_saga',
    })
    assert.equal(report.passed, false)
    const failed = report.checks.filter((c) => !c.passed).map((c) => c.id)
    assert.ok(failed.includes('authentication'), formatReport(report))
    assert.ok(failed.includes('credential'), 'a token this platform did not issue must be refused')
  } finally {
    await broken.close()
  }
})

test('a title that answers 200 for an unknown SKU fails', { skip }, async () => {
  // `unsupported` must be terminal and distinguishable from an outage, or a catalogue mistake is
  // retried until an attempt budget runs out and then reported as a title failure.
  const broken = await fakeTitleService({ slug: 'agreeable', breaks: { unsupported: true } })
  try {
    const report = await runConformance({
      baseUrl: broken.baseUrl,
      token: broken.token,
      sku: 'private_saga',
    })
    assert.equal(report.checks.find((c) => c.id === 'unsupported')?.passed, false)
  } finally {
    await broken.close()
  }
})

test('a title that answers 2xx with no urn fails', { skip }, async () => {
  // A title claiming a success it cannot name. Recording `provisioned` with no urn would break
  // the schema constraint anyway, and would deserve to.
  const broken = await fakeTitleService({ slug: 'vague', breaks: { urn: true } })
  try {
    const report = await runConformance({
      baseUrl: broken.baseUrl,
      token: broken.token,
      sku: 'private_saga',
    })
    assert.equal(report.checks.find((c) => c.id === 'provision')?.passed, false)
  } finally {
    await broken.close()
  }
})

test('an unreachable title produces a report, never a thrown exception', { skip: false }, async () => {
  // A thrown exception here would tell an operator less than a list of nine falses.
  const report = await runConformance({
    baseUrl: 'http://127.0.0.1:1',
    token: 'x',
    sku: 'private_saga',
    deadlineMs: 500,
  })
  assert.equal(report.passed, false)
  assert.equal(report.checks.length, 9)
  assert.ok(report.checks.every((c) => !c.passed))
})

test('an ill-formed slug fails, because a slug is a URL segment and a scope id', { skip }, async () => {
  const broken = await fakeTitleService({ slug: '../etc/passwd' })
  try {
    const report = await runConformance({
      baseUrl: broken.baseUrl,
      token: broken.token,
      sku: 'private_saga',
    })
    assert.equal(report.checks.find((c) => c.id === 'slug')?.passed, false)
  } finally {
    await broken.close()
  }
})

test('a capability this platform does not know fails, because a typo is an undelivered purchase', { skip }, async () => {
  const broken = await fakeTitleService({
    slug: 'typo',
    capabilities: ['private_worlds'],
  })
  try {
    const report = await runConformance({
      baseUrl: broken.baseUrl,
      token: broken.token,
      sku: 'private_saga',
    })
    const check = report.checks.find((c) => c.id === 'capabilities')
    assert.equal(check?.passed, false)
    assert.match(check?.detail ?? '', /private_worlds/)
  } finally {
    await broken.close()
  }
})

/* ------------------------------------------------------------------ THE DEMONSTRATION */

/**
 * Two titles, one bridge, no code change.
 */
test('TWO independent titles both provision through the same bridge', { skip }, async () => {
  const h = harness(sql)
  // The fake titles live for the whole file and the conformance runs above already provisioned
  // against them, so the counts are taken as a DELTA rather than absolutely. Resetting them
  // between tests would be tidier and would also hide a title that provisioned when it should
  // not have.
  const before = { ashfall: ashfall.provisioned.length, emberfall: emberfall.provisioned.length }
  const registered = await Promise.all(
    [ashfall, emberfall].map((title) =>
      registerTitle(db, 'worlds', {
        slug: title.slug,
        name: title.slug,
        status: 'live',
        serviceUrl: title.baseUrl,
        capabilities: ['private_world'],
        assetScopes: [],
        actor: 'operator:test',
        correlationId: 'req-1',
      }),
    ),
  )

  const urns: string[] = []
  for (const [index, title] of registered.entries()) {
    const envelope = grantedEnvelope({
      id: `7777777${index}-7777-4777-8777-777777777777`,
      entitlementId: `ent-${title.slug}`,
      scope: titleScope(title.id),
    })
    const recorded = await recordGrant(db, 'worlds', {
      eventId: envelope['id'] as string,
      payload: envelope['payload'] as Record<string, unknown>,
      actor: 'service:billing',
    })
    assert.equal(recorded.status, 'recorded')
    assert.equal(await driveProvision(h.provision, recorded.provision!.id), 'provisioned')
    urns.push(recorded.provision!.id)
  }

  // Each title raised exactly one world, and they are different worlds.
  assert.equal(ashfall.provisioned.length - before.ashfall, 1)
  assert.equal(emberfall.provisioned.length - before.emberfall, 1)
  assert.notEqual(
    ashfall.provisioned[ashfall.provisioned.length - 1]?.urn,
    emberfall.provisioned[emberfall.provisioned.length - 1]?.urn,
  )

  // The account holds both, each scoped to its own title, both bound.
  const inventory = await listInventory(db, { userId: ALICE })
  assert.equal(inventory.length, 2)
  assert.equal(new Set(inventory.map((item) => item.titleScope)).size, 2)
  assert.ok(inventory.every((item) => item.bound))
  assert.equal(urns.length, 2)
})

test('a title that has not passed conformance can still be registered, and its failure is a ROW', { skip }, async () => {
  // Registration does not run the suite. That is deliberate: an operator runs it, reads the
  // report, and decides. A title registered without passing produces a `failed` or `unsupported`
  // provision an operator can see — never a silent loss.
  const broken = await fakeTitleService({ slug: 'careless', breaks: { unsupported: true } })
  try {
    const h = harness(sql, { titleToken: broken.token })
    const title = await registerTitle(db, 'worlds', {
      slug: 'careless',
      name: 'Careless',
      status: 'live',
      serviceUrl: broken.baseUrl,
      // It does NOT declare private_world, so the bridge refuses before calling it.
      capabilities: ['cosmetics'],
      assetScopes: [],
      actor: 'operator:test',
      correlationId: 'req-1',
    })
    const envelope = grantedEnvelope({ scope: titleScope(title.id) })
    const recorded = await recordGrant(db, 'worlds', {
      eventId: envelope['id'] as string,
      payload: envelope['payload'] as Record<string, unknown>,
      actor: 'service:billing',
    })
    assert.equal(await driveProvision(h.provision, recorded.provision!.id), 'unsupported')
    assert.equal(broken.provisioned.length, 0)
  } finally {
    await broken.close()
  }
})
