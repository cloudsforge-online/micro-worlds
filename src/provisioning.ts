/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ENTITLEMENT BRIDGE. THIS IS THE FILE THAT FINALLY BUILDS THE PRIVATE WORLD.**
 *
 * The estate sells `private_skirmish` for 1,800 Shards and `private_saga` for 2,500. Pay debits
 * the balance, writes an `entitlements` row with the world name the customer typed in its
 * `meta`, and returns 201. **Nothing then reads that row.** Not the game service, not any of the
 * other eight repositories. The seller's own source says so in a comment —
 *
 *     // The game service later reads this to actually provision the world (out of scope here).
 *
 * — and that consumer has never existed. The only world-creation path in the estate is an
 * operator-only `POST /admin/worlds` which takes no user, no entitlement and no owner, because
 * `worlds` has no column to put one in. The rental is excluded from Pay's own-once unique index
 * and takes no idempotency key, so the same customer can be charged for the same undelivered
 * world as many times as they press the button. The shop's own source calls this "WITHHELD" and
 * the mitigation shipped was to hide the button.
 *
 * Six things had to exist before a provisioner could be written at all. Every one of them now
 * does:
 *
 *   1. A service-readable entitlement API.   billing's `GET /internal/entitlements/:userId`, and
 *                                            the `billing.entitlement.granted` event this file
 *                                            consumes. Pay's is Bearer-only, so no background job
 *                                            could ever ask — which is why no async fulfilment of
 *                                            any kind is possible there.
 *   2. A provisioning marker.                `provisions.state`. Pay's entitlements table has no
 *                                            state column at all; only `meta` is free.
 *   3. Idempotent creation keyed on the      `provisions.entitlement_id UNIQUE`, and the same id
 *      entitlement.                          sent to the title as its idempotency key.
 *   4. Owner, visibility and capacity on     The title's business now, behind `service_url`, and
 *      a world.                              carried to it in `metadata`.
 *   5. An operator view of failed rentals.   `GET /v1/provisions?state=failed`, plus
 *                                            `worlds_provisions_total{outcome}`.
 *   6. A refund path.                        Not this service's to perform — billing owns
 *                                            revocation — but `worlds.provision.failed` is the
 *                                            event that starts one, and it names the entitlement.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Consume, then provision. Never both in one step.
 *
 * The webhook does one thing: `withInbox` plus one INSERT. It does not call the title, because a
 * title that is slow would then make billing's relay time out and redeliver — and a bridge whose
 * delivery pressure is coupled to a title's provisioning latency is a bridge that melts on the day
 * a title is slow. The job does the calling, under a lease, with a bounded attempt budget.
 */

import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { withInbox, withOutbox, type Db, type Emit, type Tx } from './outbox.ts'
import { CROSS_TITLE, grantItem } from './players.ts'
import { findTitle, hasCapability, titleIdFromScope, type TitleRecord } from './titles.ts'
import {
  TitleRefusedError,
  TitleUnavailableError,
  TitleUnsupportedError,
  type TitleClient,
} from './titleclient.ts'

/** The topic billing emits on every grant. 04-domain-model §8.1. */
export const GRANTED_TOPIC = 'billing.entitlement.granted'
export const REVOKED_TOPIC = 'billing.entitlement.revoked'

export const PROVISIONED_TOPIC = 'worlds.provision.completed'
export const PROVISION_FAILED_TOPIC = 'worlds.provision.failed'

export type ProvisionKind =
  | 'private_world'
  | 'cosmetic'
  | 'season_pass'
  | 'convenience'
  | 'unknown'

export type ProvisionState =
  | 'pending'
  | 'provisioning'
  | 'provisioned'
  | 'unsupported'
  | 'failed'

/**
 * What a SKU means, and it is a table rather than a heuristic.
 *
 * The frozen estate's `sku` is one flat global namespace shared by every product in every
 * repository, with no title dimension — so two titles each shipping a `skin_bunker` collide in the
 * one unique index Pay has. This table is where that stops being implicit: a SKU maps to a KIND,
 * and the title comes from the entitlement's SCOPE rather than from the SKU's spelling.
 *
 * The two private-world SKUs are the estate's own, carried across verbatim so the entitlements
 * already written for them are recognised on the first pass rather than needing a backfill.
 */
const SKU_KINDS: Readonly<Record<string, ProvisionKind>> = Object.freeze({
  private_skirmish: 'private_world',
  private_saga: 'private_world',
  season_1_ashfall: 'season_pass',
})

const KIND_PREFIXES: ReadonlyArray<{ readonly prefix: string; readonly kind: ProvisionKind }> =
  Object.freeze([
    { prefix: 'private_', kind: 'private_world' },
    { prefix: 'season_', kind: 'season_pass' },
    { prefix: 'skin_', kind: 'cosmetic' },
    { prefix: 'frame_', kind: 'cosmetic' },
    { prefix: 'crest_', kind: 'cosmetic' },
    { prefix: 'flair_', kind: 'cosmetic' },
  ])

/**
 * The kind a SKU provisions.
 *
 * Falls back to `unknown` rather than to a guess. An `unknown` provision is recorded, counted and
 * left for an operator — which is a customer who paid for something this service does not know how
 * to deliver, and is exactly the state the estate is in today for three whole SKU classes. Naming
 * it is the first step to not being in it.
 */
export function kindForSku(sku: string): ProvisionKind {
  const known = SKU_KINDS[sku]
  if (known) return known
  for (const { prefix, kind } of KIND_PREFIXES) {
    if (sku.startsWith(prefix)) return kind
  }
  return 'unknown'
}

export interface ProvisionRecord {
  readonly id: string
  readonly entitlementId: string
  readonly subject: string
  readonly sku: string
  readonly scope: string
  readonly titleId: string | null
  readonly kind: ProvisionKind
  readonly state: ProvisionState
  readonly provisionedUrn: string | null
  readonly metadata: Readonly<Record<string, unknown>>
  readonly attempts: number
  readonly lastError: string | null
  readonly leaseOwner: string | null
  readonly createdAt: Date
  readonly provisionedAt: Date | null
}

interface ProvisionRow {
  readonly id: string
  readonly entitlement_id: string
  readonly subject: string
  readonly sku: string
  readonly scope: string
  readonly title_id: string | null
  readonly kind: string
  readonly state: string
  readonly provisioned_urn: string | null
  readonly metadata: Record<string, unknown>
  readonly attempts: number
  readonly last_error: string | null
  readonly lease_owner: string | null
  readonly created_at: Date
  readonly provisioned_at: Date | null
}

const COLUMNS = `
  id, entitlement_id, subject, sku, scope, title_id, kind, state, provisioned_urn, metadata,
  attempts, last_error, lease_owner, created_at, provisioned_at
`

function toProvision(row: ProvisionRow): ProvisionRecord {
  return {
    id: row.id,
    entitlementId: row.entitlement_id,
    subject: row.subject,
    sku: row.sku,
    scope: row.scope,
    titleId: row.title_id,
    kind: row.kind as ProvisionKind,
    state: row.state as ProvisionState,
    provisionedUrn: row.provisioned_urn,
    metadata: row.metadata,
    attempts: row.attempts,
    lastError: row.last_error,
    leaseOwner: row.lease_owner,
    createdAt: row.created_at,
    provisionedAt: row.provisioned_at,
  }
}

/** The user id inside a ledger subject. Billing's subject is `user:<id>`; a title wants the id. */
export function userIdOf(subject: string): string {
  return subject.startsWith('user:') ? subject.slice('user:'.length) : subject
}

/* ------------------------------------------------------------------ consuming the event */

/** The shape billing puts on `billing.entitlement.granted`. Read defensively: it is a wire type. */
export interface GrantedPayload {
  readonly entitlementId?: unknown
  readonly subject?: unknown
  readonly sku?: unknown
  readonly scope?: unknown
  readonly source?: unknown
  readonly metadata?: unknown
}

export class MalformedEventError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedEventError'
  }
}

export interface RecordResult {
  readonly status: 'recorded' | 'duplicate'
  readonly provision?: ProvisionRecord
}

/**
 * Consume one `billing.entitlement.granted` and record what it obliges us to provision.
 *
 * `withInbox` inserts `(topic, event_id)` and runs the body only if that insert won, so a
 * redelivered event is a no-op. The `provisions.entitlement_id` unique constraint is the SECOND
 * line: the inbox dedupes a redelivered EVENT, and the constraint dedupes a re-granted
 * ENTITLEMENT even if it arrives under a different event id — which is what happens when billing
 * replays its outbox after a restore.
 *
 * **No title call happens here.** See the file header.
 */
export async function recordGrant(
  sql: Db,
  producer: string,
  input: { readonly eventId: string; readonly payload: GrantedPayload; readonly actor: string },
): Promise<RecordResult> {
  const entitlementId = requireString(input.payload.entitlementId, 'entitlementId')
  const subject = requireString(input.payload.subject, 'subject')
  const sku = requireString(input.payload.sku, 'sku')
  const scope = requireString(input.payload.scope, 'scope')
  const metadata =
    typeof input.payload.metadata === 'object' &&
    input.payload.metadata !== null &&
    !Array.isArray(input.payload.metadata)
      ? (input.payload.metadata as Record<string, unknown>)
      : {}

  const outcome = await withInbox(sql, GRANTED_TOPIC, input.eventId, async (tx) => {
    const titleId = titleIdFromScope(scope)
    const rows = await tx<ProvisionRow[]>`
      insert into provisions (entitlement_id, subject, sku, scope, title_id, kind, metadata)
      values (
        ${entitlementId}, ${subject}, ${sku}, ${scope},
        -- The title is resolved from the SCOPE, not from the SKU's spelling. A SKU namespace
        -- shared by every product in the estate cannot say which title a purchase is for, which is
        -- part of why a private world rented for one title is indistinguishable from one rented
        -- for another today.
        ${titleId}, ${kindForSku(sku)}, ${tx.json(metadata as never)}
      )
      -- The second line of defence. See the docblock.
      on conflict (entitlement_id) do nothing
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    return row ? toProvision(row) : null
  })

  if (outcome.status === 'duplicate' || outcome.value === null) return { status: 'duplicate' }
  return { status: 'recorded', provision: outcome.value }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    // A permanent fault: the event cannot be acted on and no amount of retrying will change it.
    throw new MalformedEventError(`${GRANTED_TOPIC} requires a non-empty ${field}`)
  }
  return value.trim()
}

/* ------------------------------------------------------------------ the lease */

/**
 * Take the exclusive right to provision this entitlement.
 *
 * A single conditional `UPDATE … RETURNING`, the same primitive `forge-mint`'s `claimDeploy` is
 * built on and the one thing the old estate got right about distributed work. Whichever
 * transaction commits first stops the row matching, so the second caller gets nothing back and
 * never reaches the title.
 *
 * `provisioned` and `unsupported` are absent from the claimable set, and `failed` is too. A failed
 * provision is retried by an operator's explicit act — `POST /v1/provisions/:id/retry` — never by
 * a poll. That is the lesson from the frozen deploy claim, whose `DEPLOYABLE` includes `'failed'`
 * and therefore re-runs a failed attempt with no wait at all.
 */
export async function claimProvision(
  sql: Db,
  input: { readonly id: string; readonly owner: string; readonly leaseMs: number },
): Promise<ProvisionRecord | null> {
  const rows = await sql<ProvisionRow[]>`
    update provisions
       set state = 'provisioning',
           lease_owner = ${input.owner},
           lease_until = now() + make_interval(secs => ${input.leaseMs / 1000}),
           attempts = attempts + 1,
           updated_at = now()
     where id = ${input.id}
       and state in ('pending','provisioning')
       and (lease_until is null or lease_until < now())
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toProvision(row) : null
}

export async function releaseProvision(sql: Db, id: string, owner: string): Promise<void> {
  await sql`
    update provisions
       set state = 'pending', lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id} and lease_owner = ${owner} and state = 'provisioning'
  `
}

export async function findProvision(sql: Db, id: string): Promise<ProvisionRecord | null> {
  const rows = await sql<ProvisionRow[]>`
    select ${sql.unsafe(COLUMNS)} from provisions where id = ${id}
  `
  const row = rows[0]
  return row ? toProvision(row) : null
}

export async function findProvisionByEntitlement(
  sql: Db,
  entitlementId: string,
): Promise<ProvisionRecord | null> {
  const rows = await sql<ProvisionRow[]>`
    select ${sql.unsafe(COLUMNS)} from provisions where entitlement_id = ${entitlementId}
  `
  const row = rows[0]
  return row ? toProvision(row) : null
}

export async function outstandingProvisions(sql: Db, limit: number): Promise<ProvisionRecord[]> {
  const rows = await sql<ProvisionRow[]>`
    select ${sql.unsafe(COLUMNS)}
      from provisions
     where state in ('pending','provisioning')
     order by created_at
     limit ${limit}
  `
  return rows.map(toProvision)
}

export async function listProvisions(
  sql: Db,
  query: { readonly subject?: string; readonly state?: ProvisionState; readonly limit?: number },
): Promise<ProvisionRecord[]> {
  const limit = Math.min(query.limit ?? 100, 500)
  if (query.subject && query.state) {
    const rows = await sql<ProvisionRow[]>`
      select ${sql.unsafe(COLUMNS)} from provisions
       where subject = ${query.subject} and state = ${query.state}
       order by created_at desc limit ${limit}
    `
    return rows.map(toProvision)
  }
  if (query.subject) {
    const rows = await sql<ProvisionRow[]>`
      select ${sql.unsafe(COLUMNS)} from provisions
       where subject = ${query.subject} order by created_at desc limit ${limit}
    `
    return rows.map(toProvision)
  }
  if (query.state) {
    const rows = await sql<ProvisionRow[]>`
      select ${sql.unsafe(COLUMNS)} from provisions
       where state = ${query.state} order by created_at desc limit ${limit}
    `
    return rows.map(toProvision)
  }
  const rows = await sql<ProvisionRow[]>`
    select ${sql.unsafe(COLUMNS)} from provisions order by created_at desc limit ${limit}
  `
  return rows.map(toProvision)
}

/* ------------------------------------------------------------------ doing the work */

export interface ProvisionDeps {
  readonly sql: Db
  readonly producer: string
  readonly owner: string
  readonly titles: TitleClient
  readonly leaseMs: number
  /** After this many attempts a provision stops being retried and an operator is told. */
  readonly maxAttempts: number
  readonly enabled: boolean
  readonly logger: Logger
  readonly metrics: Metrics
}

export type DriveResult =
  | 'skipped'
  | 'not_claimed'
  | 'provisioned'
  | 'unsupported'
  | 'failed'
  | 'retry'

/**
 * Provision one entitlement.
 *
 * Returns rather than throws for every outcome the domain has a name for. A throw here is a fault:
 * the runner burns an attempt and backs off, which is what should happen to a bug and emphatically
 * not to "the title is restarting".
 */
export async function driveProvision(deps: ProvisionDeps, id: string): Promise<DriveResult> {
  if (!deps.enabled) return 'skipped'

  const claimed = await claimProvision(deps.sql, {
    id,
    owner: deps.owner,
    leaseMs: deps.leaseMs,
  })
  if (!claimed) return 'not_claimed'

  // A cosmetic or a convenience item is delivered HERE, by putting a row in the account's
  // inventory. It needs no title service, and routing it through one would make every cosmetic
  // purchase depend on a game being up.
  if (claimed.kind === 'cosmetic' || claimed.kind === 'convenience') {
    return grantLocally(deps, claimed)
  }

  if (claimed.kind === 'unknown') {
    // Named rather than swallowed. A customer has paid for something this service does not know
    // how to deliver, and that is an operator's problem now rather than in six months.
    return terminal(deps, claimed, 'unsupported', `no delivery is defined for sku ${claimed.sku}`)
  }

  const title = claimed.titleId ? await findTitle(deps.sql, claimed.titleId) : null
  if (!title) {
    return terminal(
      deps,
      claimed,
      'unsupported',
      `the entitlement's scope ${claimed.scope} does not name a registered title`,
    )
  }
  const capability = claimed.kind === 'private_world' ? 'private_world' : 'seasons'
  if (!hasCapability(title, capability)) {
    // Asked BEFORE the call rather than discovered from a 404. A title that cannot do this is a
    // catalogue mistake, and it deserves a row that says so.
    return terminal(
      deps,
      claimed,
      'unsupported',
      `${title.slug} does not declare the ${capability} capability`,
    )
  }

  try {
    const result = await deps.titles.provision(title.serviceUrl, {
      entitlementId: claimed.entitlementId,
      subject: claimed.subject,
      userId: userIdOf(claimed.subject),
      sku: claimed.sku,
      scope: claimed.scope,
      metadata: claimed.metadata,
      correlationId: claimed.id,
    })
    return await complete(deps, claimed, title, result.urn)
  } catch (err) {
    if (err instanceof TitleUnsupportedError) {
      return terminal(deps, claimed, 'unsupported', err.message)
    }
    if (err instanceof TitleRefusedError) {
      // The title looked at it and said no. Permanent for this request; retrying is a guaranteed
      // second refusal and a second burnt attempt.
      return terminal(deps, claimed, 'failed', `${err.code}: ${err.message}`)
    }
    if (err instanceof TitleUnavailableError) {
      // We do not know whether it provisioned. The row keeps everything it has and the lease is
      // released, so the next tick sends the SAME entitlement id — which the title recognises.
      return retry(deps, claimed, err.message)
    }
    await releaseProvision(deps.sql, claimed.id, deps.owner)
    throw err
  }
}

/** Delivery that does not need a title service: put the item in the account's inventory. */
async function grantLocally(deps: ProvisionDeps, provision: ProvisionRecord): Promise<DriveResult> {
  const urn = `cf:worlds:inventory:${provision.entitlementId}`
  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    await grantItem(tx, emit, {
      userId: userIdOf(provision.subject),
      // A cosmetic bought under a title scope belongs to that title; one bought at platform scope
      // is cross-game and lands under `*`.
      titleScope: provision.titleId ?? CROSS_TITLE,
      itemUrn: `cf:catalogue:item:${provision.sku}`,
      source: 'purchase',
      // **Not bound.** A cosmetic confers no power, so it may be traded — which is the whole
      // reason `bound` is a per-item fact rather than a per-source one.
      bound: false,
      entitlementId: provision.entitlementId,
      actor: `service:${deps.producer}`,
      correlationId: provision.id,
    })
    await markProvisioned(tx, emit, deps, provision, urn)
  })
  deps.metrics.increment('worlds_provisions_total', { kind: provision.kind, outcome: 'provisioned' })
  return 'provisioned'
}

async function complete(
  deps: ProvisionDeps,
  provision: ProvisionRecord,
  title: TitleRecord,
  urn: string,
): Promise<DriveResult> {
  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    // A private world is also an inventory row, `bound`. It confers access to a world the buyer
    // owns and is therefore not something that may be resold — §7.3's rule applied to the thing
    // the estate actually sells.
    await grantItem(tx, emit, {
      userId: userIdOf(provision.subject),
      titleScope: title.id,
      itemUrn: urn,
      source: 'purchase',
      bound: true,
      entitlementId: provision.entitlementId,
      actor: `service:${deps.producer}`,
      correlationId: provision.id,
    })
    await markProvisioned(tx, emit, deps, provision, urn)
  })
  deps.metrics.increment('worlds_provisions_total', { kind: provision.kind, outcome: 'provisioned' })
  deps.logger.info('provisioned', {
    provisionId: provision.id,
    entitlementId: provision.entitlementId,
    sku: provision.sku,
    title: title.slug,
    urn,
  })
  return 'provisioned'
}

async function markProvisioned(
  tx: Tx,
  emit: Emit,
  deps: ProvisionDeps,
  provision: ProvisionRecord,
  urn: string,
): Promise<void> {
  const rows = await tx<ProvisionRow[]>`
    update provisions
       set state = 'provisioned',
           provisioned_urn = ${urn},
           provisioned_at = now(),
           last_error = null,
           lease_owner = null,
           lease_until = null,
           updated_at = now()
     where id = ${provision.id} and lease_owner = ${deps.owner} and state = 'provisioning'
    returning ${tx.unsafe(COLUMNS)}
  `
  if (rows.length === 0) {
    // The lease was taken over while the title call was in the air. Throwing rolls the inventory
    // grant back with it, so the replica that now holds the row does the whole thing — rather than
    // this one leaving half a delivery behind.
    throw new TitleUnavailableError('this replica no longer holds the provisioning lease')
  }
  emit({
    topic: PROVISIONED_TOPIC,
    key: provision.entitlementId,
    payload: {
      provisionId: provision.id,
      entitlementId: provision.entitlementId,
      subject: provision.subject,
      sku: provision.sku,
      scope: provision.scope,
      kind: provision.kind,
      urn,
    },
    actor: `service:${deps.producer}`,
    correlationId: provision.id,
  })
}

/** A terminal non-success, with the event a refund process would start from. */
async function terminal(
  deps: ProvisionDeps,
  provision: ProvisionRecord,
  state: 'unsupported' | 'failed',
  reason: string,
): Promise<DriveResult> {
  await withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    await tx`
      update provisions
         set state = ${state},
             last_error = ${reason.slice(0, 2_000)},
             lease_owner = null,
             lease_until = null,
             updated_at = now()
       where id = ${provision.id} and lease_owner = ${deps.owner}
    `
    emit({
      topic: PROVISION_FAILED_TOPIC,
      key: provision.entitlementId,
      payload: {
        provisionId: provision.id,
        // The entitlement id, so a refund can name what it is reversing. That is the one field a
        // human triaging this cannot do without, and the frozen estate records no link at all
        // between the money and the entitlement in either direction.
        entitlementId: provision.entitlementId,
        subject: provision.subject,
        sku: provision.sku,
        scope: provision.scope,
        state,
        reason,
      },
      actor: `service:${deps.producer}`,
      correlationId: provision.id,
    })
  })
  deps.metrics.increment('worlds_provisions_total', { kind: provision.kind, outcome: state })
  deps.logger.error('provision could not be delivered', {
    provisionId: provision.id,
    entitlementId: provision.entitlementId,
    sku: provision.sku,
    state,
    reason,
  })
  return state === 'unsupported' ? 'unsupported' : 'failed'
}

/** An outage. Keep everything, release the lease, try again — until the attempt budget runs out. */
async function retry(
  deps: ProvisionDeps,
  provision: ProvisionRecord,
  reason: string,
): Promise<DriveResult> {
  if (provision.attempts >= deps.maxAttempts) {
    // Not retried for ever. A title that has been unreachable for N attempts is an incident, and a
    // busy loop against it hides that behind a flat graph.
    return terminal(
      deps,
      provision,
      'failed',
      `gave up after ${provision.attempts} attempts: ${reason}`,
    )
  }
  await deps.sql`
    update provisions
       set state = 'pending',
           last_error = ${reason.slice(0, 2_000)},
           lease_owner = null,
           lease_until = null,
           updated_at = now()
     where id = ${provision.id} and lease_owner = ${deps.owner}
  `
  deps.logger.warn('provision deferred: the title was unavailable', {
    provisionId: provision.id,
    attempts: provision.attempts,
    reason,
  })
  return 'retry'
}

/**
 * An operator's explicit retry of a terminal row.
 *
 * The only way out of `failed`. A background poll must never do this — see the note on
 * `claimProvision` — because a poll that resurrects failures is a poll that repeats whatever
 * caused them, at the rate of the poll.
 */
export async function reopenProvision(sql: Db, id: string): Promise<ProvisionRecord | null> {
  const rows = await sql<ProvisionRow[]>`
    update provisions
       set state = 'pending', attempts = 0, lease_owner = null, lease_until = null, updated_at = now()
     where id = ${id} and state in ('failed','unsupported')
    returning ${sql.unsafe(COLUMNS)}
  `
  const row = rows[0]
  return row ? toProvision(row) : null
}
