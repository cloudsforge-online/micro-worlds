/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work and CI greps for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.**
 *
 *   | Work                | Key         | Why                                                    |
 *   |---------------------|-------------|--------------------------------------------------------|
 *   | provision.deliver   | `title:<id>`| **The title service.** Not the entitlement id. Two      |
 *   |                     |             | provisions of DIFFERENT entitlements against one title  |
 *   |                     |             | are independent as far as correctness goes — the        |
 *   |                     |             | entitlement id is the idempotency key and the title     |
 *   |                     |             | honours it — but a title raising a world writes         |
 *   |                     |             | thousands of rows, and fifty concurrent provisions      |
 *   |                     |             | against one title is a denial of service the platform   |
 *   |                     |             | inflicts on its own game. `claimProvision` is what      |
 *   |                     |             | makes two deliveries of ONE entitlement impossible;     |
 *   |                     |             | this key bounds the load on the thing being asked.      |
 *   | provision.sweep     | `stream`    | The backlog. It enqueues and does nothing else, which   |
 *   |                     |             | is the only reason it may share a runner with the       |
 *   |                     |             | deliverer at all.                                       |
 *   | outbox.relay        | `stream`    | The outbox stream. Keying on the event id would let two |
 *   |                     |             | relays deliver one batch to one subscriber twice.       |
 *
 * **A KEY IS NOT A LOCK ACROSS KINDS.** The jobs table is unique on `(kind, key)`, so
 * `provision.sweep / stream` and `outbox.relay / stream` are two rows and two workers may hold
 * them at once. That is fine because neither touches the other's state. **The moment the sweep
 * calls a title it must be merged into `provision.deliver`** rather than given its own key.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The sweep is what makes the entitlement bridge survive a bad day. Without it a provision whose
 * job died would sit `pending` until somebody asked about it — which is precisely the state the
 * frozen estate is in permanently, where the only thing that ever advances an order is a request
 * arriving for it.
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { createRelay, type Db, type RelayDeps } from './outbox.ts'
import { driveProvision, outstandingProvisions, type ProvisionDeps } from './provisioning.ts'

export const RELAY_KIND = 'outbox.relay'
/** The only job that ever calls a title service. */
export const PROVISION_KIND = 'provision.deliver'
/** Finds outstanding provisions and enqueues them. Never calls a title — see the header. */
export const SWEEP_KIND = 'provision.sweep'

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
  readonly payload?: Record<string, unknown>
}

export const RECURRING: readonly Recurring[] = Object.freeze([
  { kind: RELAY_KIND, key: 'stream', everyMs: 1_000, payload: {} },
  { kind: SWEEP_KIND, key: 'stream', everyMs: 5_000, payload: {} },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({
      kind: job.kind,
      key: job.key,
      onConflict: 'keep',
      ...(job.payload ? { payload: job.payload } : {}),
    })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * It cannot re-arm itself from inside its own handler: the runner deletes the row on success
 * *after* the handler returns, so a self-enqueue would be deleted a moment later and the schedule
 * would stop. Doing it from the completion event is the only point at which the row is gone.
 *
 * A dead-lettered recurring job is deliberately **not** re-armed. The row stays, `jobs_dead_total`
 * increments and `jobs_overdue` climbs, which is how an operator finds out.
 */
export function rescheduleRecurring(queue: JobQueue, logger: Logger): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind} ${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind} ${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
        ...(job.payload ? { payload: job.payload } : {}),
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Db
  readonly logger: Logger
  readonly metrics: Metrics
  readonly signingSecret: string
  readonly provision: ProvisionDeps
  /**
   * The queue the sweep enqueues onto.
   *
   * Passed in rather than closed over at module scope. A module-local queue would be exactly the
   * shape of the module-local boolean rule 8 exists to keep out: invisible to a second process,
   * and impossible to substitute in a test.
   */
  readonly queue: Pick<JobQueue, 'enqueue'>
  readonly sweepLimit: number
}

/** The lease key for one provision's delivery: the title it will be asked of. */
export function provisionKey(titleId: string | null): string {
  return `title:${titleId ?? 'local'}`
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const relayDeps: RelayDeps = {
    sql: deps.sql,
    logger: deps.logger.child({ job: RELAY_KIND }),
    signingSecret: deps.signingSecret,
  }
  runner.register(RELAY_KIND, createRelay(relayDeps))

  runner.register<{ provisionId?: string }>(
    PROVISION_KIND,
    async (job: Job<{ provisionId?: string }>, ctx) => {
      const provisionId = job.payload.provisionId
      if (typeof provisionId !== 'string' || provisionId.length === 0) {
        // A payload that cannot be acted on is a permanent fault. Throwing burns the attempt
        // budget and dead-letters it, which is correct — retrying will not make it valid.
        throw new Error(`${PROVISION_KIND} requires a string provisionId`)
      }
      const result = await driveProvision(deps.provision, provisionId)
      if (ctx.signal.aborted) return
      deps.logger.info('provision tick', { provisionId, result })
    },
  )

  runner.register(SWEEP_KIND, async (_job, ctx) => {
    const outstanding = await outstandingProvisions(deps.sql, deps.sweepLimit)
    for (const provision of outstanding) {
      if (ctx.signal.aborted) return
      // `keep`, so a provision already queued is not re-queued: three sweeps before the first
      // delivery job runs must produce one run, not three.
      await deps.queue.enqueue({
        kind: PROVISION_KIND,
        key: provisionKey(provision.titleId),
        payload: { provisionId: provision.id },
        onConflict: 'keep',
      })
    }
    deps.metrics.set('worlds_provisions_outstanding', outstanding.length)
    if (outstanding.length > 0) {
      deps.logger.info('provision sweep', { outstanding: outstanding.length })
    }
  })

  return runner
}
