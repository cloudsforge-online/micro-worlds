/**
 * Boot the REAL service, register a title, grant an entitlement, and show the private world
 * actually provisioned.
 *
 * A real process on a real socket. `createServer` is the production one, `driveProvision` is the
 * production one, and the title client below it is the production one — talking to a REAL HTTP
 * title service on a second socket. Two things are substituted, at the narrowest seam each has:
 * billing (an entitlement reader) and the ledger.
 *
 * The job runner is not started. The provisioning job is driven by an operator side-car, one tick
 * at a time, so the transcript shows the state transition rather than a race against a printer.
 *
 *     WORLDS_TEST_DATABASE_URL=... node --import tsx scripts/verify.ts
 */

import { createServer as createHttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Lifecycle } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import type { Principal } from '@cloudsforge/auth'
import { createServer, registerServiceMetrics } from '../src/server.ts'
import { driveProvision } from '../src/provisioning.ts'
import { httpTitleClient } from '../src/titleclient.ts'
import {
  ALICE,
  fakeBilling,
  fakeLedger,
  fakeTitleService,
  migrateTestDb,
  openDb,
  resetWorlds,
} from '../src/testsupport.ts'
import type { Db } from '../src/outbox.ts'

const SECRET = 'a-real-looking-secret-of-sufficient-length'

const sql = openDb(8)
await migrateTestDb(sql)
await resetWorlds(sql)
const db = sql as unknown as Db

// A REAL title service on its own socket. Only the game behind it is imaginary.
const title = await fakeTitleService({ slug: 'ashfall', token: 'title-token-ashfall' })

const ledger = fakeLedger()
const billing = fakeBilling()
const logger = new Logger({ service: 'worlds-verify', level: 'error' })
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
const lifecycle = new Lifecycle({ drainDelayMs: 0, drainTimeoutMs: 1_000 })

const verifier = {
  async principal(token: string): Promise<Principal> {
    if (token === 'alice') return { kind: 'user', userId: ALICE, handle: 'alice', roles: ['player'] }
    if (token === 'admin') return { kind: 'user', userId: 'ops-1', handle: 'ops', roles: ['admin'] }
    throw new Error('unknown token')
  },
}

const queued: Array<{ provisionId: string }> = []

const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: 'worlds',
  rewards: { sql: db, ledger, producer: 'worlds' },
  billing,
  queue: {
    async enqueue(options) {
      queued.push({ provisionId: String((options.payload ?? {})['provisionId']) })
    },
  },
  // A list of one, which is what an estate with no rotation in progress configures. See `env.ts`.
  eventAcceptSecrets: [SECRET],
})

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
const port = (server.address() as AddressInfo).port
lifecycle.markReady()

const provision = {
  sql: db,
  producer: 'worlds',
  owner: 'verify-replica',
  titles: httpTitleClient({ token: () => title.token, deadlineMs: 10_000 }),
  leaseMs: 60_000,
  maxAttempts: 5,
  enabled: true,
  logger,
  metrics,
}

/** The operator side-car: runs one provisioning tick, which in production is a leased job. */
const control = createHttpServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const send = (body: unknown): void => {
    const payload = `${JSON.stringify(body)}\n`
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
  }
  if (url.pathname === '/tick') {
    const provisionId = url.searchParams.get('provisionId') ?? queued[queued.length - 1]?.provisionId ?? ''
    void driveProvision(provision, provisionId).then((result) =>
      send({ provisionId, result, worldsRaised: title.provisioned.length }),
    )
    return undefined
  }
  return send({ queued, titleUrl: title.baseUrl, worlds: title.provisioned })
})
await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', () => resolve()))
const controlPort = (control.address() as AddressInfo).port

process.stdout.write(
  `${JSON.stringify({ service: port, control: controlPort, title: title.baseUrl, secret: SECRET })}\n`,
)
