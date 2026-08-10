/**
 * The HTTP surface.
 *
 * The test that matters most is the signature check on `POST /v1/events`. An unsigned provisioning
 * webhook is a free-worlds endpoint: anyone who can reach the port can assert that a customer
 * bought a private world and get one raised.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before, beforeEach } from 'node:test'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import type postgres from 'postgres'
import { TokenError, VerifierUnavailableError, type Principal } from '@cloudsforge/auth'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { createServer, registerServiceMetrics, type PrincipalVerifier } from './server.ts'
import { signEvent, withOutbox, type Db } from './outbox.ts'
import { grantItem } from './players.ts'
import { openSeason } from './rewards.ts'
import { registerTitle } from './titles.ts'
import { PROVISION_KIND } from './jobs.ts'
import {
  ALICE,
  BOB,
  enabled,
  fakeBilling,
  fakeLedger,
  grantedEnvelope,
  migrateTestDb,
  openDb,
  resetWorlds,
  skip,
  type FakeBilling,
  type FakeLedger,
} from './testsupport.ts'

const SECRET = 'a-real-looking-secret-of-sufficient-length'

/**
 * The key being rotated IN.
 *
 * It leads the accepted list and NOTHING signs with it yet, which is exactly the state a rolling
 * rotation leaves this service in for the length of the cutover window: the new key published on
 * the receiver first, the producers still on the old one. Obviously fake, and long enough to clear
 * the length rule in `env.ts`.
 */
const NEXT_SECRET = 'rotation-fixture-next-key-not-a-real-secret'

const verifier: PrincipalVerifier = {
  async principal(token: string): Promise<Principal> {
    switch (token) {
      case 'alice':
        return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
      case 'bob':
        return { kind: 'user', userId: BOB, handle: 'bob', roles: ['player'] }
      case 'admin':
        return { kind: 'user', userId: 'admin-1', handle: 'ops-jane', roles: ['admin'] }
      case 'svc-title':
        return { kind: 'service', service: 'ashfall', scopes: ['worlds:title', 'worlds:read'] }
      case 'svc-admin':
        return { kind: 'service', service: 'hub', scopes: ['worlds:admin', 'worlds:read'] }
      case 'svc-none':
        return { kind: 'service', service: 'nosy', scopes: ['other:read'] }
      case 'down':
        throw new VerifierUnavailableError('jwks unreachable')
      default:
        throw new TokenError('bad signature', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED')
    }
  },
}

let sql: postgres.Sql
let db: Db
let server: Server
let baseUrl: string
let ledger: FakeLedger
let billing: FakeBilling
let enqueued: Array<{ kind: string; key: string }>

before(async () => {
  if (!enabled) return
  sql = openDb(8)
  db = sql as unknown as Db
  await migrateTestDb(sql)
  ledger = fakeLedger()
  billing = fakeBilling()
  enqueued = []

  const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })
  const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
  server = createServer({
    lifecycle,
    logger: new Logger({ service: 'worlds-test', level: 'fatal', sink: () => {} }),
    metrics,
    verifier,
    sql: db,
    producer: 'worlds',
    rewards: { sql: db, ledger, producer: 'worlds' },
    billing,
    queue: {
      async enqueue(options) {
        enqueued.push({ kind: options.kind, key: options.key })
      },
    },
    eventAcceptSecrets: [NEXT_SECRET, SECRET],
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  lifecycle.markReady()
})

beforeEach(async () => {
  if (!enabled) return
  await resetWorlds(sql)
  enqueued.length = 0
})

after(async () => {
  if (!enabled) return
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await sql.end({ timeout: 5 })
})

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
    headers: response.headers,
  }
}

/** POST a raw, signed body — the shape billing's relay actually sends. */
async function postEvent(
  envelope: Record<string, unknown>,
  options: { secret?: string; signature?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = JSON.stringify(envelope)
  const signature = options.signature ?? signEvent(raw, options.secret ?? SECRET)
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-signature': signature },
    body: raw,
  })
  const text = await response.text()
  return {
    status: response.status,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {},
  }
}

/* ------------------------------------------------------------------ probes */

test('livez, readyz and metrics are served — rule 4', { skip }, async () => {
  assert.equal((await call('/livez')).status, 200)
  assert.equal((await call('/readyz')).status, 200)
  const metrics = await fetch(`${baseUrl}/metrics`)
  assert.equal(metrics.status, 200)
  assert.match(await metrics.text(), /worlds_provisions_total/)
})

/* ------------------------------------------------------------------ THE WEBHOOK */

test('a signed billing.entitlement.granted is accepted and queued for provisioning', { skip }, async () => {
  const res = await postEvent(grantedEnvelope())
  assert.equal(res.status, 202)
  assert.equal(res.body['status'], 'recorded')
  assert.ok(res.body['provisionId'])
  assert.deepEqual(enqueued, [{ kind: PROVISION_KIND, key: 'title:local' }])
})

/**
 * **An unsigned provisioning webhook is a free-worlds endpoint.**
 */
test('an UNSIGNED event is refused and provisions nothing', { skip }, async () => {
  const raw = JSON.stringify(grantedEnvelope())
  const response = await fetch(`${baseUrl}/v1/events`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  })
  assert.equal(response.status, 401)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from provisions`
  assert.equal(rows[0]?.n, 0)
  assert.equal(enqueued.length, 0)
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PROPERTY THE ROTATION DEPENDS ON.**
 *
 * `OUTBOX_SIGNING_SECRET` is one shared key across the estate. If moving to a new one meant this
 * service accepted only the new one, then every producer still on the old key would be 401'd for
 * the length of the rolling deploy and no world would be provisioned in that window. So the
 * receiver accepts a list, and the old key keeps working while the new one leads it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a delivery signed with the OLD key is still accepted while the NEW key leads the list', { skip }, async () => {
  const res = await postEvent(grantedEnvelope(), { secret: SECRET })
  assert.equal(res.status, 202)
  assert.equal(res.body['status'], 'recorded')
  assert.deepEqual(enqueued, [{ kind: PROVISION_KIND, key: 'title:local' }])
})

test('a delivery signed with the NEW key is accepted too — both ends of the window are open', { skip }, async () => {
  const res = await postEvent(grantedEnvelope(), { secret: NEXT_SECRET })
  assert.equal(res.status, 202)
  assert.equal(res.body['status'], 'recorded')
})

test('an event signed with the WRONG key is refused', { skip }, async () => {
  const res = await postEvent(grantedEnvelope(), { secret: 'somebody-elses-secret-of-length-32ch' })
  assert.equal(res.status, 401)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from provisions`
  assert.equal(rows[0]?.n, 0)
})

test('a truncated signature is refused rather than compared partially', { skip }, async () => {
  const raw = JSON.stringify(grantedEnvelope())
  const short = signEvent(raw, SECRET).slice(0, 20)
  const res = await postEvent(grantedEnvelope(), { signature: short })
  assert.equal(res.status, 401)
})

test('a signature over DIFFERENT bytes is refused', { skip }, async () => {
  // The MAC is over the exact bytes received, so an attacker cannot sign a benign body and send a
  // different one.
  const benign = signEvent(JSON.stringify(grantedEnvelope({ sku: 'frame_ember' })), SECRET)
  const res = await postEvent(grantedEnvelope({ sku: 'private_saga' }), { signature: benign })
  assert.equal(res.status, 401)
})

/**
 * The ORDER is the security property, and it is pinned rather than described.
 *
 * `README.md` and `worlds-web/src/lib/worlds.ts` both promise this endpoint is HMAC-checked over
 * the exact bytes received BEFORE `JSON.parse`. Verifying after parsing would put a JSON parser in
 * front of the authentication, reachable by anyone who can open a socket, and would check a MAC
 * over a re-serialisation rather than over what arrived — and `JSON.parse` then `JSON.stringify` is
 * not the identity function, so every honest delivery would be refused too.
 *
 * No database, so this one runs everywhere.
 */
test('POST /v1/events verifies the signature BEFORE it parses the body', () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  const handler = source.indexOf(`define('POST', '/v1/events'`)
  assert.ok(handler > 0, 'the handler was not found; this check is grading nothing')
  // The slice is the handler alone: the next route definition ends it, so a `JSON.parse` belonging
  // to some other route cannot satisfy or break this.
  const end = source.indexOf(`    define(`, handler + 10)
  assert.ok(end > handler, 'the handler slice has no end; this check is grading nothing')
  const body = source.slice(handler, end)

  const verifyAt = body.indexOf('verifyEventSignature(')
  const parseAt = body.indexOf('JSON.parse')
  assert.ok(verifyAt > 0, 'the handler no longer verifies a signature at all')
  assert.ok(parseAt > 0, 'the handler slice contains no parse; the slice is wrong')
  assert.ok(parseAt > verifyAt, 'the body is parsed BEFORE the signature is checked')
  // And the bytes verified are the ones read off the socket, not a re-serialisation of a parse.
  assert.ok(body.indexOf('readRaw(ctx.req)') < verifyAt)
})

test('a topic this service does not subscribe to is accepted and ignored', { skip }, async () => {
  // A 4xx would make the producer's relay retry an event it is correct to send and we are correct
  // not to act on, for ever.
  const res = await postEvent({ ...grantedEnvelope(), topic: 'billing.entitlement.revoked' })
  assert.equal(res.status, 202)
  assert.equal(res.body['status'], 'ignored')
  assert.equal(enqueued.length, 0)
})

test('a redelivered event is a duplicate, and queues nothing a second time', { skip }, async () => {
  await postEvent(grantedEnvelope())
  const second = await postEvent(grantedEnvelope())
  assert.equal(second.status, 202)
  assert.equal(second.body['status'], 'duplicate')
  assert.equal(enqueued.length, 1)
})

test('an event with no uuid id is a 400, not an inbox row', { skip }, async () => {
  const res = await postEvent({ ...grantedEnvelope(), id: 'not-a-uuid' })
  assert.equal(res.status, 400)
})

/* ------------------------------------------------------------------ auth */

test('a missing or bad token is 401, and the reason is never returned', { skip }, async () => {
  assert.equal((await call('/v1/players/me')).status, 401)
  const bad = await call('/v1/players/me', { token: 'forged' })
  assert.equal(bad.status, 401)
  assert.doesNotMatch(JSON.stringify(bad.body), /signature/i)
})

test('an unreachable verifier is 503, NEVER 401', { skip }, async () => {
  assert.equal((await call('/v1/players/me', { token: 'down' })).status, 503)
})

test('an ordinary player cannot register a title', { skip }, async () => {
  // Registering a title says where this service will send a customer's purchase.
  const res = await call('/v1/titles', {
    method: 'POST',
    token: 'alice',
    body: { slug: 'mine', name: 'Mine', serviceUrl: 'http://evil.test' },
  })
  assert.equal(res.status, 403)
})

test('an administrator can register a title, and the registry is public to read', { skip }, async () => {
  const res = await call('/v1/titles', {
    method: 'POST',
    token: 'admin',
    body: {
      slug: 'ashfall',
      name: 'Ashfall',
      serviceUrl: 'http://127.0.0.1:9001',
      capabilities: ['private_world'],
      status: 'live',
    },
  })
  assert.equal(res.status, 201)
  const listed = await call('/v1/titles')
  assert.equal(listed.status, 200)
  assert.equal((listed.body['titles'] as unknown[]).length, 1)
})

test('an unknown capability is refused at registration', { skip }, async () => {
  // A typo in a capability is a purchase that is accepted and never delivered.
  const res = await call('/v1/titles', {
    method: 'POST',
    token: 'admin',
    body: {
      slug: 'typo',
      name: 'Typo',
      serviceUrl: 'http://127.0.0.1:9001',
      capabilities: ['private_worlds'],
    },
  })
  assert.equal(res.status, 400)
  assert.match(JSON.stringify(res.body), /unknown capability/)
})

test('a service_url that is not http is refused', { skip }, async () => {
  const res = await call('/v1/titles', {
    method: 'POST',
    token: 'admin',
    body: { slug: 'weird', name: 'Weird', serviceUrl: 'file:///etc/passwd' },
  })
  assert.equal(res.status, 400)
})

/* ------------------------------------------------------------------ the player */

test('a profile round-trips, account-scoped', { skip }, async () => {
  const put = await call('/v1/players/me', {
    method: 'PUT',
    token: 'alice',
    body: { displayName: 'Ashvale Wanderer', ageBracket: 'adult' },
  })
  assert.equal(put.status, 200)
  const me = await call('/v1/players/me', { token: 'alice' })
  assert.equal((me.body['profile'] as Record<string, unknown>)['displayName'], 'Ashvale Wanderer')
})

/**
 * The fail-open / fail-closed split, carried forward from the frozen service, which gets it right.
 */
test('GET /players/me fails OPEN when billing is down', { skip }, async () => {
  // This runs on every app load, so a billing outage must not be able to break signing in.
  await call('/v1/players/me', { method: 'PUT', token: 'alice', body: { displayName: 'alice' } })
  billing.setUnavailable(true)
  const res = await call('/v1/players/me', { token: 'alice' })
  assert.equal(res.status, 200)
  billing.setUnavailable(false)
})

test('PUT /players/me/cosmetics fails CLOSED when billing is down', { skip }, async () => {
  // "Ask again later", not "wear it anyway". An unverified cosmetic is never persisted.
  await call('/v1/players/me', { method: 'PUT', token: 'alice', body: { displayName: 'alice' } })
  billing.setUnavailable(true)
  const res = await call('/v1/players/me/cosmetics', {
    method: 'PUT',
    token: 'alice',
    body: { slot: 'avatar_frame', itemUrn: 'frame_ember' },
  })
  assert.equal(res.status, 503)
  assert.equal(res.body['error'] && (res.body['error'] as Record<string, unknown>)['code'], 'entitlements_unavailable')
  billing.setUnavailable(false)
})

test('equipping something you do not own is refused', { skip }, async () => {
  await call('/v1/players/me', { method: 'PUT', token: 'alice', body: { displayName: 'alice' } })
  const res = await call('/v1/players/me/cosmetics', {
    method: 'PUT',
    token: 'alice',
    body: { slot: 'avatar_frame', itemUrn: 'frame_ember' },
  })
  assert.equal(res.status, 403)
})

test('equipping something you DO own works', { skip }, async () => {
  await call('/v1/players/me', { method: 'PUT', token: 'alice', body: { displayName: 'alice' } })
  billing.grant(ALICE, { id: 'e1', sku: 'frame_ember', scope: 'platform', active: true })
  const res = await call('/v1/players/me/cosmetics', {
    method: 'PUT',
    token: 'alice',
    body: { slot: 'avatar_frame', itemUrn: 'frame_ember' },
  })
  assert.equal(res.status, 200)
})

test('CLEARING a slot needs no entitlement, even when billing is down', { skip }, async () => {
  // You may always take something off, including something you no longer own.
  await call('/v1/players/me', { method: 'PUT', token: 'alice', body: { displayName: 'alice' } })
  billing.setUnavailable(true)
  const res = await call('/v1/players/me/cosmetics', {
    method: 'PUT',
    token: 'alice',
    body: { slot: 'avatar_frame', itemUrn: null },
  })
  assert.equal(res.status, 200)
  billing.setUnavailable(false)
})

/* ------------------------------------------------------------------ the bound item, over HTTP */

test('listing a BOUND item is a 403 with its own code', { skip }, async () => {
  const item = await withOutbox(db, 'worlds', async (tx, emit) =>
    grantItem(tx, emit, {
      userId: ALICE,
      titleScope: '*',
      itemUrn: 'cf:ashfall:world:1',
      source: 'purchase',
      bound: true,
      actor: 'service:worlds',
      correlationId: 'req-1',
    }),
  )
  const res = await call(`/v1/players/me/inventory/${item!.id}/list`, {
    method: 'POST',
    token: 'alice',
    body: { listingUrn: 'cf:market:listing:1' },
  })
  assert.equal(res.status, 403)
  assert.equal((res.body['error'] as Record<string, unknown>)['code'], 'item_bound')
  // The refusal is counted, because non-zero means a client believes it may.
  assert.match(await (await fetch(`${baseUrl}/metrics`)).text(), /worlds_bound_listing_refusals_total/)
})

test('listing an UNBOUND item works', { skip }, async () => {
  const item = await withOutbox(db, 'worlds', async (tx, emit) =>
    grantItem(tx, emit, {
      userId: ALICE,
      titleScope: '*',
      itemUrn: 'cf:catalogue:item:hat',
      source: 'purchase',
      bound: false,
      actor: 'service:worlds',
      correlationId: 'req-1',
    }),
  )
  const res = await call(`/v1/players/me/inventory/${item!.id}/list`, {
    method: 'POST',
    token: 'alice',
    body: { listingUrn: 'cf:market:listing:1' },
  })
  assert.equal(res.status, 201)
  assert.equal((res.body['item'] as Record<string, unknown>)['bound'], false)
})

/* ------------------------------------------------------------------ rewards, over HTTP */

test('a title service may ask for a reward; the budget is charged here', { skip }, async () => {
  const title = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    status: 'live',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['seasons'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const season = await openSeason(db, {
    titleId: title.id,
    slug: 's1',
    name: 'Season One',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2026-04-01T00:00:00Z'),
    rewardBudgetWei: 100n,
    status: 'active',
  })

  const ok = await call(`/v1/seasons/${season.id}/rewards`, {
    method: 'POST',
    token: 'svc-title',
    body: { userId: ALICE, reason: 'first_blood', amountWei: '60' },
  })
  assert.equal(ok.status, 201)

  // The second exceeds the budget: 422, not 500, so the caller knows it was the cap.
  const refused = await call(`/v1/seasons/${season.id}/rewards`, {
    method: 'POST',
    token: 'svc-title',
    body: { userId: BOB, reason: 'first_blood', amountWei: '60' },
  })
  assert.equal(refused.status, 422)
  assert.equal((refused.body['error'] as Record<string, unknown>)['code'], 'budget_exceeded')
  assert.equal(ledger.entries.length, 1)

  const budget = await call(`/v1/seasons/${season.id}/budget`, { token: 'svc-title' })
  assert.equal(budget.body['grantedWei'], '60')
  assert.equal(budget.body['remainingWei'], '40')
})

test('a TITLE cannot open a season, because that would let it set its own budget', { skip }, async () => {
  const title = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    status: 'live',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['seasons'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const res = await call(`/v1/titles/${title.id}/seasons`, {
    method: 'POST',
    token: 'svc-title',
    body: {
      slug: 's1',
      name: 'Season One',
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-04-01T00:00:00Z',
      rewardBudgetWei: '999999999',
    },
  })
  assert.equal(res.status, 403)
})

test('a wei amount sent as a JSON number is refused rather than rounded', { skip }, async () => {
  const title = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    status: 'live',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['seasons'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const res = await call(`/v1/titles/${title.id}/seasons`, {
    method: 'POST',
    token: 'svc-admin',
    body: {
      slug: 's1',
      name: 'Season One',
      startsAt: '2026-01-01T00:00:00Z',
      endsAt: '2026-04-01T00:00:00Z',
      rewardBudgetWei: 100,
    },
  })
  assert.equal(res.status, 400)
})

test('an ADMIN re-opening a season cannot raise its budget without an approval', { skip }, async () => {
  // The route is the path an operator actually takes, and this is where the silent raise happened:
  // POST the same slug with a bigger number and the cap on `engagement:worlds` moved. 21 §6 makes
  // that an approved act; the refusal gets its own code so an operator is told which of the two
  // money refusals this route can produce they have hit.
  const title = await registerTitle(db, 'worlds', {
    slug: 'ashfall',
    name: 'Ashfall',
    status: 'live',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['seasons'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  const season = {
    slug: 's1',
    name: 'Season One',
    startsAt: '2026-01-01T00:00:00Z',
    endsAt: '2026-04-01T00:00:00Z',
  }
  const opened = await call(`/v1/titles/${title.id}/seasons`, {
    method: 'POST',
    token: 'svc-admin',
    body: { ...season, rewardBudgetWei: '1000' },
  })
  assert.equal(opened.status, 201)

  const raised = await call(`/v1/titles/${title.id}/seasons`, {
    method: 'POST',
    token: 'svc-admin',
    body: { ...season, rewardBudgetWei: '1000000' },
  })
  assert.equal(raised.status, 422)
  assert.equal((raised.body['error'] as Record<string, unknown>)['code'], 'budget_raise_needs_approval')

  // Lowering, from the same caller with the same authority, goes straight through — the asymmetry
  // is about the direction of the change and not about who is asking.
  const lowered = await call(`/v1/titles/${title.id}/seasons`, {
    method: 'POST',
    token: 'svc-admin',
    body: { ...season, rewardBudgetWei: '400' },
  })
  assert.equal(lowered.status, 201)
  const body = lowered.body['season'] as Record<string, unknown>
  assert.equal(body['rewardBudgetWei'], '400')
  assert.equal(body['budgetRaiseApprovalId'], null)

  // And a raise that names an approval lands, with the row saying what authorised it.
  const approved = await call(`/v1/titles/${title.id}/seasons`, {
    method: 'POST',
    token: 'svc-admin',
    body: { ...season, rewardBudgetWei: '1000000', budgetRaiseApprovalId: 'approval-4e1a' },
  })
  assert.equal(approved.status, 201)
  const approvedBody = approved.body['season'] as Record<string, unknown>
  assert.equal(approvedBody['rewardBudgetWei'], '1000000')
  assert.equal(approvedBody['budgetRaiseApprovalId'], 'approval-4e1a')
})

/* ------------------------------------------------------------------ shape */

test('a malformed id is a 404, not a 500 from Postgres', { skip }, async () => {
  const res = await call('/v1/provisions/not-a-uuid', { token: 'alice' })
  assert.equal(res.status, 404)
})

test('every error carries the request id, in the body as well as the header', { skip }, async () => {
  const res = await call('/v1/provisions/00000000-0000-4000-8000-000000000000', { token: 'alice' })
  assert.equal(res.status, 404)
  const error = res.body['error'] as Record<string, unknown>
  assert.equal(error['requestId'], res.headers.get('x-request-id'))
})

test('an unmatched path collapses to one metric label', { skip }, async () => {
  await call('/v1/nope/12345')
  const metrics = await (await fetch(`${baseUrl}/metrics`)).text()
  assert.match(metrics, /route="unmatched"/)
  assert.doesNotMatch(metrics, /route="\/v1\/nope\/12345"/)
})

/* ------------------------------------------------------------------ HERALDRY */

test('a sealed season mints ranked, bound, cross-title heraldry for every victor member', { skip }, async () => {
  const BOB = '22222222-2222-4222-8222-222222222222'
  const CARA = '33333333-3333-4333-8333-333333333333'
  const eventId = '0be5c9a1-6c1a-4b6e-8a5e-9a0d3f1c2b4a'
  const envelope = {
    id: eventId,
    topic: 'aetherholm.season.sealed',
    key: 'season-1',
    occurredAt: new Date().toISOString(),
    producer: 'aetherholm',
    version: '1.0',
    correlationId: 'corr-seal-1',
    payload: {
      seasonId: 'a3d1b0aa-0000-4000-8000-000000000001',
      digest: 'd'.repeat(64),
      victors: [
        // Rank 1: an alliance — the grant fans out to EVERY member on the payload.
        { kind: 'alliance', userIds: [ALICE, BOB] },
        // Rank 2: a lone holder.
        { kind: 'player', userId: CARA, userIds: [CARA] },
      ],
    },
  }
  const first = await postEvent(envelope)
  assert.equal(first.status, 202)
  assert.equal(first.body['status'], 'granted')
  assert.equal(first.body['granted'], 3, 'two alliance members and one solo victor')

  const rows = await sql<{ user_id: string; item_urn: string; bound: boolean; title_scope: string; source: string }[]>`
    select user_id, item_urn, bound, title_scope, source from inventory_items
     where item_urn like 'cf:aetherholm:heraldry:%' order by item_urn, user_id
  `
  assert.equal(rows.length, 3)
  for (const row of rows) {
    assert.equal(row.bound, true, 'a victory cannot be sold')
    assert.equal(row.title_scope, '*', 'heraldry is visible in every title')
    assert.equal(row.source, 'reward')
  }
  assert.match(rows[0]!.item_urn, /rank:1$/)
  assert.match(rows[2]!.item_urn, /rank:2$/)

  // Redelivery: at-least-once means this WILL happen. One inbox row, no new items, no new outbox.
  const again = await postEvent(envelope)
  assert.equal(again.status, 200)
  assert.equal(again.body['status'], 'duplicate')
  const after = await sql<{ n: number }[]>`
    select count(*)::int as n from inventory_items where item_urn like 'cf:aetherholm:heraldry:%'
  `
  assert.equal(after[0]!.n, 3, 'a redelivered seal mints nothing')

  // And the grants left outbox events — the profile change is announced like every other.
  const emitted = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = 'worlds.inventory.granted'
  `
  assert.ok(emitted[0]!.n >= 3, 'each grant announces itself on the bus')
})

test('a second sealed season grants again — the per-user idempotency is per SEASON', { skip }, async () => {
  // Self-contained: its own victor and both seasons inside one test, because the harness resets
  // state between tests and an expectation leaning on a sibling's rows is an expectation about
  // the harness, not the code.
  const DANA = '44444444-4444-4444-8444-444444444444'
  for (const n of [1, 2]) {
    const reply = await postEvent({
      id: `1ce5c9a1-6c1a-4b6e-8a5e-9a0d3f1c2b4${n}`,
      topic: 'aetherholm.season.sealed',
      key: `season-${n}`,
      occurredAt: new Date().toISOString(),
      producer: 'aetherholm',
      version: '1.0',
      payload: {
        seasonId: `a3d1b0aa-0000-4000-8000-00000000000${n}`,
        victors: [{ kind: 'player', userId: DANA, userIds: [DANA] }],
      },
    })
    assert.equal(reply.body['status'], 'granted')
  }
  const mine = await sql<{ n: number }[]>`
    select count(*)::int as n from inventory_items
     where user_id = ${DANA} and item_urn like 'cf:aetherholm:heraldry:%'
  `
  assert.equal(mine[0]!.n, 2, 'one banner per season, not one banner ever')
})

