/**
 * Local fakes for the upstreams, an in-memory title service, and the database harness.
 *
 * ## `fakeTitleService` is a REAL HTTP SERVER
 *
 * It is not a stubbed client. It is `node:http` implementing the four-route contract in
 * `conformance.ts`, so the conformance suite runs against a socket and the title client's
 * idempotency key, its auth header and its error mapping are all genuinely exercised. A stubbed
 * client would have made the conformance suite a test of the stub — which is exactly the failure
 * mode that lets a contract test pass while nothing implements the contract.
 *
 * Two of them can be started at once, which is what makes "a second game is possible" a
 * demonstration rather than an assertion.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres from 'postgres'
import { migrate, type Sql as DbSql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import { httpTitleClient } from './titleclient.ts'
import type { EntitlementReader, EntitlementWire } from './billingclient.ts'
import type { LedgerClient, PostEntryRequest, PostedEntry } from './ledgerclient.ts'
import type { Db } from './outbox.ts'
import type { ProvisionDeps } from './provisioning.ts'

export const ALICE = '11111111-1111-4111-8111-111111111111'
export const BOB = '22222222-2222-4222-8222-222222222222'

/* ------------------------------------------------------------------ the fake title service */

export interface FakeTitleOptions {
  readonly slug: string
  readonly name?: string
  readonly capabilities?: readonly string[]
  /** SKUs it will provision. Anything else is a 422 `unsupported`. */
  readonly skus?: readonly string[]
  /** The credential it will accept. A conformance run proves it checks one. */
  readonly token?: string
  /**
   * Break the contract on purpose, so the conformance suite can be shown to CATCH a breach rather
   * than merely to pass against something that happens to be right.
   */
  readonly breaks?: {
    /** Ignore the idempotency key and mint a new world every time. THE dangerous one. */
    readonly idempotency?: boolean
    /** Accept anything, from anyone. */
    readonly authentication?: boolean
    /** Answer 200 for an unknown sku instead of 422. */
    readonly unsupported?: boolean
    /** Answer 2xx with no urn. */
    readonly urn?: boolean
  }
}

export interface FakeTitle {
  readonly baseUrl: string
  readonly slug: string
  readonly token: string
  /** Every provision it made. The idempotency test asserts on the length of this. */
  readonly provisioned: ReadonlyArray<{ entitlementId: string; urn: string; sku: string }>
  /** Make the next N provision calls fail with a 503, for the retry tests. */
  failNext(count: number): void
  close(): Promise<void>
}

export async function fakeTitleService(options: FakeTitleOptions): Promise<FakeTitle> {
  const token = options.token ?? `title-token-${options.slug}`
  const skus = new Set(options.skus ?? ['private_skirmish', 'private_saga'])
  const byEntitlement = new Map<string, string>()
  const provisioned: Array<{ entitlementId: string; urn: string; sku: string }> = []
  const breaks = options.breaks ?? {}
  let failures = 0
  let minted = 0

  const server: Server = createServer((req, res) => {
    const reply = (status: number, body: unknown): void => {
      const payload = `${JSON.stringify(body)}\n`
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      })
      res.end(payload)
    }

    const url = new URL(req.url ?? '/', 'http://localhost')

    if (url.pathname === '/livez') return reply(200, { ok: true })

    if (url.pathname === '/v1/title' && req.method === 'GET') {
      return reply(200, {
        slug: options.slug,
        name: options.name ?? options.slug,
        capabilities: options.capabilities ?? ['private_world', 'achievements', 'seasons'],
      })
    }

    if (url.pathname === '/v1/provision' && req.method === 'POST') {
      const presented = req.headers.authorization
      if (!breaks.authentication && presented !== `Bearer ${token}`) {
        return reply(401, { error: { code: 'unauthenticated', message: 'a bearer token is required' } })
      }
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        let body: Record<string, unknown> = {}
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
        } catch {
          return reply(400, { error: { code: 'bad_request', message: 'not json' } })
        }
        if (failures > 0) {
          failures -= 1
          return reply(503, { error: { code: 'unavailable', message: 'restarting' } })
        }
        const entitlementId = String(body['entitlementId'] ?? '')
        const sku = String(body['sku'] ?? '')
        if (!skus.has(sku) && !breaks.unsupported) {
          // An ANSWER, not a fault. Terminal, and distinguishable from an outage.
          return reply(422, { error: { code: 'unsupported', message: `${sku} is not sold here` } })
        }
        const existing = breaks.idempotency ? undefined : byEntitlement.get(entitlementId)
        if (existing) return reply(200, { urn: existing, replayed: true })
        minted += 1
        const urn = `cf:${options.slug}:world:${minted}`
        byEntitlement.set(entitlementId, urn)
        provisioned.push({ entitlementId, urn, sku })
        return reply(201, breaks.urn ? { replayed: false } : { urn, replayed: false })
      })
      return undefined
    }

    return reply(404, { error: { code: 'not_found', message: 'no route' } })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    slug: options.slug,
    token,
    provisioned,
    failNext(count) {
      failures = count
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/* ------------------------------------------------------------------ billing */

export interface FakeBilling extends EntitlementReader {
  grant(userId: string, entitlement: EntitlementWire): void
  setUnavailable(value: boolean): void
}

export function fakeBilling(): FakeBilling {
  const owned = new Map<string, EntitlementWire[]>()
  let unavailable = false
  const reader: FakeBilling = {
    grant(userId, entitlement) {
      owned.set(userId, [...(owned.get(userId) ?? []), entitlement])
    },
    setUnavailable(value) {
      unavailable = value
    },
    async list(userId) {
      if (unavailable) {
        const { BillingUnavailableError } = await import('./billingclient.ts')
        throw new BillingUnavailableError('the fake billing is unavailable')
      }
      return owned.get(userId) ?? []
    },
    async owns(userId, itemUrn, scope) {
      const { skuOf } = await import('./billingclient.ts')
      const sku = skuOf(itemUrn)
      const entitlements = await reader.list(userId)
      return entitlements.some((entitlement) => {
        if (!entitlement.active || entitlement.sku !== sku) return false
        if (!scope || scope === '*') return true
        return entitlement.scope === 'platform' || entitlement.scope === `title:${scope}`
      })
    },
  }
  return reader
}

/* ------------------------------------------------------------------ ledger */

export interface FakeLedger extends LedgerClient {
  readonly entries: readonly PostEntryRequest[]
  readonly keys: readonly string[]
  failNext(err: Error): void
}

export function fakeLedger(): FakeLedger {
  const entries: PostEntryRequest[] = []
  const keys: string[] = []
  const byKey = new Map<string, PostedEntry>()
  let failure: Error | null = null
  let counter = 0
  return {
    entries,
    keys,
    failNext(err) {
      failure = err
    },
    async postEntry(request) {
      keys.push(request.idempotencyKey)
      if (failure) {
        const err = failure
        failure = null
        throw err
      }
      // The replay is what makes a rolled-back local transaction safe to retry: the same derived
      // key gets the same entry id back and the player is paid once.
      const replay = byKey.get(request.idempotencyKey)
      if (replay) return { ...replay, replayed: true }
      counter += 1
      entries.push(request)
      const entry: PostedEntry = {
        id: `entry-${counter}`,
        kind: request.kind,
        recordedAt: new Date(counter).toISOString(),
        replayed: false,
      }
      byKey.set(request.idempotencyKey, entry)
      return entry
    },
  }
}

/* ------------------------------------------------------------------ the database harness */

/**
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetWorlds` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment. This service holds
 * the only record of which purchases were delivered; the wrong connection string here destroys the
 * evidence every undelivered-rental investigation would ever run on.
 *
 * Only a `worlds_test` database is ever created or written by this suite.
 */
const url = process.env['WORLDS_TEST_DATABASE_URL']

export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set WORLDS_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and two
 * of them, `inventory_items_bound_not_listed` and `seasons_within_budget`, are the two most
 * important lines in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as DbSql, MIGRATIONS, { service: 'worlds-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetWorlds(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'worlds-test', sink: () => {} })
}

export interface Harness {
  readonly sql: Db
  readonly ledger: FakeLedger
  readonly billing: FakeBilling
  readonly metrics: Metrics
  readonly provision: ProvisionDeps
}

export interface HarnessOptions {
  readonly owner?: string
  readonly maxAttempts?: number
  readonly enabled?: boolean
  readonly titleToken?: string
}

export function harness(sql: postgres.Sql, options: HarnessOptions = {}): Harness {
  const db = sql as unknown as Db
  const ledger = fakeLedger()
  const billing = fakeBilling()
  const metrics = registerServiceMetrics(new Metrics())
  const logger = quietLogger()
  return {
    sql: db,
    ledger,
    billing,
    metrics,
    provision: {
      sql: db,
      producer: 'worlds',
      owner: options.owner ?? 'replica-a',
      // The REAL http client against the REAL fake server. Only the game behind it is imaginary.
      titles: httpTitleClient({
        token: () => options.titleToken ?? 'title-token-ashfall',
        deadlineMs: 5_000,
      }),
      leaseMs: 60_000,
      maxAttempts: options.maxAttempts ?? 5,
      enabled: options.enabled ?? true,
      logger,
      metrics,
    },
  }
}

/** The envelope billing's relay sends, with a valid signature over the exact bytes. */
export async function signedEvent(
  secret: string,
  envelope: Record<string, unknown>,
): Promise<{ body: string; signature: string }> {
  const { signEvent } = await import('./outbox.ts')
  const body = JSON.stringify(envelope)
  return { body, signature: signEvent(body, secret) }
}

/** A well-formed `billing.entitlement.granted` payload for a private world. */
export function grantedEnvelope(
  overrides: {
    readonly id?: string
    readonly entitlementId?: string
    readonly subject?: string
    readonly sku?: string
    readonly scope?: string
    readonly metadata?: Record<string, unknown>
  } = {},
): Record<string, unknown> {
  return {
    id: overrides.id ?? '33333333-3333-4333-8333-333333333333',
    topic: 'billing.entitlement.granted',
    key: overrides.entitlementId ?? 'ent-1',
    occurredAt: '2026-01-01T00:00:00.000Z',
    producer: 'billing',
    version: '1.0',
    actor: `user:${ALICE}`,
    correlationId: 'req-1',
    payload: {
      entitlementId: overrides.entitlementId ?? 'ent-1',
      subject: overrides.subject ?? `user:${ALICE}`,
      // The estate's own SKU, verbatim, so entitlements already written for it are recognised on
      // the first pass rather than needing a backfill.
      sku: overrides.sku ?? 'private_saga',
      scope: overrides.scope ?? 'platform',
      source: 'purchase',
      quantity: '1',
      grantedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
      // What Pay's `meta` actually carries on a private-world rental.
      metadata: overrides.metadata ?? {
        worldName: 'Ashvale Refuge',
        offerId: 'private_saga',
        seasonDays: 90,
        maxPlayers: 40,
      },
    },
  }
}
