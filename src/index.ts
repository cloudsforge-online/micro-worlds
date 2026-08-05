/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this
 * file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7. Here that matters twice over: below
 * `SCHEMA_VERSION` the `bound` constraint may not exist, and neither may the season budget CHECK.
 * A service that could create them at boot is a service that could start without them, and both
 * of them are controls rather than conveniences.
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql as DbSql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier, serviceTokenProbe } from '@cloudsforge/auth'
import { Lifecycle, httpProbe, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics } from './server.ts'
import { registerHandlers, rescheduleRecurring, seedRecurring } from './jobs.ts'
import { buildUpstreams } from './upstreams.ts'
import type { Db } from './outbox.ts'
import type { ProvisionDeps } from './provisioning.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))
logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  provisioningEnabled: env.provisioningEnabled,
  // Said at boot, because a bridge that is switched off looks exactly like a bridge that is broken
  // until somebody reads the environment.
  seasonRewardBudgetShards: env.seasonRewardBudgetShards.toString(),
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point: a
//    replica running below version 6 has no bound constraint and would let a power item be listed
//    for sale, and one below version 8 has no budget cap.
try {
  await assertSchemaAtLeast(sql as unknown as DbSql, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. The upstreams, and the credential that authenticates every call to them. Constructed before
//    the Lifecycle so its probes can close over them. The wiring itself lives in `./upstreams.ts`
//    and is covered by `servicetoken.test.ts` — it was untestable here, and what was untestable
//    here was wrong for months. See that file.
const { identityTokens, ledger, billing, titles } = buildUpstreams(env, {
  originatingService: SERVICE,
  onEvent: (event) => {
    if (event.kind === 'exchange_failed') {
      // `warn`, not `error`, while a usable token is still held: the 20% slack after the refresh
      // point exists precisely so a few of these are survivable and uninteresting.
      const level = event.hadUsableToken ? 'warn' : 'error'
      logger[level]('service token exchange failed', {
        err: event.err,
        hadUsableToken: event.hadUsableToken,
      })
    } else if (event.kind === 'minted') {
      logger.info('service token minted', {
        service: event.service,
        expiresIn: event.expiresIn,
        refreshInMs: event.refreshInMs,
      })
    } else {
      logger.warn('service token', { event: event.kind, url: event.url })
    }
  },
})

if (!identityTokens) {
  // Not `fatal` and exit: the image must be able to boot without this so CI's startup smoke test
  // can read /livez, and a service that refuses to start is a service whose logs nobody reads.
  // `/readyz` is where the absence is enforced — the `identity-credential` probe below is hard,
  // so an unconfigured replica takes no traffic.
  logger.error('WORLDS_IDENTITY_CREDENTIAL is not set; every call to a peer will fail 503', {
    hint: 'deploy/scripts/estate-bootstrap.sh writes it to compose/estate/tokens.env',
  })
}
if (env.legacyServiceTokenPresent) {
  logger.error('WORLDS_SERVICE_TOKEN is set and is IGNORED', {
    hint: 'it was a 600-second token read once at boot; WORLDS_IDENTITY_CREDENTIAL replaces it',
  })
}

// 6. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  // Generous, because a drain must not cut a provisioning job between a title call and the write
  // that records it — that gap is the one place a world could be raised without a row saying so.
  drainTimeoutMs: 25_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle
  .addProbe(
    postgresProbe('postgres', (signal) =>
      Promise.race([
        sql`select 1`,
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
        }),
      ]),
    ),
  )
  .addProbe(httpProbe('identity-jwks', env.identityJwksUrl, { kind: 'soft' }))
  // HARD, unlike the soft upstream probes below. It does not report a peer having a bad minute —
  // it fails only when no credential is configured at all, which is a deployment that cannot make
  // a single authenticated call and will not fix itself. An identity OUTAGE returns warn,
  // deliberately, so one bad minute in identity does not empty every balancer in the estate.
  .addProbe(serviceTokenProbe(identityTokens))
  // SOFT, both. Billing being down means a cosmetic cannot be equipped — but this service must
  // stay in its balancer to keep serving profiles, inventories and the entitlement webhook, and
  // above all to keep DRAINING the provisioning backlog. Marking either hard would remove the
  // whole game platform from rotation for the duration of somebody else's incident.
  .addProbe(httpProbe('billing', `${env.billingUrl}/livez`, { kind: 'soft' }))
  .addProbe(httpProbe('ledger', `${env.ledgerUrl}/livez`, { kind: 'soft' }))

// 7. The dependency bundles, built once and shared.
const db = sql as unknown as Db
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  // Longer than the default 60 seconds because a provisioning job holds its lease across a title
  // call that writes thousands of rows. The claim is what makes two deliveries of one entitlement
  // impossible; this is the budget for one attempt at it.
  leaseMs: 120_000,
})

const provision: ProvisionDeps = {
  sql: db,
  producer: SERVICE,
  owner: env.instanceId,
  titles,
  leaseMs: 120_000,
  // After this many attempts a provision stops being retried and an operator is told. Not
  // unlimited: a title that has been unreachable for five attempts is an incident, and a busy loop
  // against it hides that behind a flat graph.
  maxAttempts: 5,
  enabled: env.provisioningEnabled,
  logger: logger.child({ component: 'provisioning' }),
  metrics,
}

// 8. Routes. After the Lifecycle so the health handlers report real state, and after the pool so
//    the stores are real rather than a lazily-connected surprise on the first request.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  producer: SERVICE,
  rewards: { sql: db, ledger, producer: SERVICE },
  billing,
  queue,
  // Every key billing's relay may have signed with, newest first — `[OUTBOX_SIGNING_SECRET]` unless
  // a rotation is in progress. See the header of `server.ts`: an unsigned provisioning webhook is a
  // free-worlds endpoint, and a bridge that accepts only the newest key is one that refuses every
  // producer still mid-deploy.
  eventAcceptSecrets: env.outboxAcceptSecrets,
  // Queue depth is sampled at scrape time rather than on a timer. There is no `setInterval` in
  // this repository, and CI greps for one — rule 8.
  beforeScrape: async () => {
    const stats = await queue.stats()
    metrics.set('jobs_pending', stats.pending)
    metrics.set('jobs_overdue', stats.overdue)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: db,
  logger,
  metrics,
  signingSecret: env.outboxSigningSecret,
  provision,
  queue,
  sweepLimit: 100,
})
await seedRecurring(queue)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS, then the pool closes with nothing left to
//     use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(20_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
