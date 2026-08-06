/**
 * Heraldry: what a sealed Aetherholm season leaves on the shared player profile.
 *
 * `docs/ecosystem/20-aetherholm.md` §2: "Victors receive heraldry — cosmetic entitlements on the
 * **shared Worlds player profile**, visible in every title." The game's side has existed since its
 * phase 2 — `aetherholm.season.sealed` carries the ranked victors with every member userId on the
 * payload — and this file is the other half, which `18-build-status` §3.3p recorded as "an event
 * with no consumer yet".
 *
 * ## The decisions, spelled out
 *
 * - **`title_scope: '*'`** — cross-game, because visible-in-every-title is the entire point of
 *   putting heraldry here rather than inside the game that awarded it.
 * - **`bound: true`** — a victory cannot be sold. Heraldry confers no power, so the
 *   anti-pay-to-win rule does not force this; what forces it is honesty about what the item IS.
 *   A banner that can be bought second-hand stops meaning "this player held the Spires", and the
 *   `inventory_items_bound_not_listed` CHECK makes the refusal structural.
 * - **`entitlement_id: 'aetherholm:season:<seasonId>:user:<userId>'`** — synthetic, PER USER,
 *   and the per-user part is load-bearing: the dedupe index is
 *   `inventory_items_entitlement_uniq (entitlement_id, item_urn)` (`src/migrations.ts`),
 *   so one season-wide entitlement id would let exactly ONE alliance member win the insert and
 *   hand every other member a silent null. Per-user ids give per-user idempotency across
 *   redeliveries and replicas; `grantItem` returning null is "already done" for that member.
 * - **The urn carries the rank** (`cf:aetherholm:heraldry:<seasonId>:rank:<n>`), so first place
 *   and fifth place are different artwork, decided by the asset pipeline later — the urn is an
 *   identity, not a file path.
 *
 * Alliance victories fan out to every member on the payload (`victor.userIds`). The producer
 * carries the membership deliberately — this service holds no alliance table and must not grow
 * one to render a reward (the same reasoning notify records for its spire rule).
 */
import { withInbox, type Db, type DomainEvent, type Emit, type Tx } from './outbox.ts'
import { grantItem, type InventoryItem } from './players.ts'

export const SEASON_SEALED_TOPIC = 'aetherholm.season.sealed'

/** One ranked victor as `aetherholm/src/sealing.ts` puts it on the wire. Read defensively. */
interface WireVictor {
  readonly userIds?: readonly unknown[]
  readonly userId?: unknown
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/** Every uuid the victor names, whichever spelling carried it. */
function membersOf(victor: WireVictor): string[] {
  const out = new Set<string>()
  if (typeof victor.userId === 'string' && UUID.test(victor.userId)) out.add(victor.userId)
  for (const id of victor.userIds ?? []) {
    if (typeof id === 'string' && UUID.test(id)) out.add(id)
  }
  return [...out]
}

export interface HeraldryOutcome {
  readonly granted: number
  readonly alreadyGranted: number
}

/**
 * Grant ranked heraldry to every victor member. Runs inside the inbox transaction, so the event
 * dedupe, the grants, and the outbox rows they emit commit or vanish together.
 */
export async function grantHeraldry(
  tx: Tx,
  emit: Parameters<typeof grantItem>[1],
  input: {
    readonly seasonId: string
    readonly victors: readonly WireVictor[]
    readonly correlationId: string
  },
): Promise<HeraldryOutcome> {
  let granted = 0
  let alreadyGranted = 0
  for (const [index, victor] of input.victors.entries()) {
    const rank = index + 1
    for (const userId of membersOf(victor)) {
      const item: InventoryItem | null = await grantItem(tx, emit, {
        userId,
        titleScope: '*',
        itemUrn: `cf:aetherholm:heraldry:${input.seasonId}:rank:${rank}`,
        source: 'reward',
        bound: true,
        entitlementId: `aetherholm:season:${input.seasonId}:user:${userId}`,
        actor: 'service:aetherholm',
        correlationId: input.correlationId,
      })
      if (item) granted += 1
      else alreadyGranted += 1
    }
  }
  return { granted, alreadyGranted }
}

/**
 * The inbox half and the outbox half, in ONE transaction.
 *
 * `withInbox` dedupes but hands its body only `tx`; `withOutbox` emits but opens its own
 * transaction — composing them by nesting would double-begin. So this buffers emits exactly the
 * way `withOutbox` does and writes the rows itself in the same transaction as the inbox claim and
 * the grants: a redelivered seal event inserts no inbox row, no items, and no outbox rows, as one
 * fact rather than three.
 */
export async function handleSeasonSealed(
  sql: Db,
  producer: string,
  eventId: string,
  input: { readonly seasonId: string; readonly victors: readonly WireVictor[]; readonly correlationId: string },
): Promise<{ status: 'processed'; outcome: HeraldryOutcome } | { status: 'duplicate' }> {
  const result = await withInbox(sql, SEASON_SEALED_TOPIC, eventId, async (tx) => {
    const pending: DomainEvent[] = []
    const emit: Emit = (event) => {
      pending.push(event)
    }
    const outcome = await grantHeraldry(tx, emit, input)
    for (const event of pending) {
      await tx`
        insert into outbox (topic, key, producer, version, actor, correlation_id, payload)
        values (
          ${event.topic},
          ${event.key},
          ${producer},
          ${event.version ?? 1},
          ${event.actor ?? null},
          ${event.correlationId ?? null},
          ${tx.json(event.payload as Record<string, never>)}
        )
      `
    }
    return outcome
  })
  if (result.status === 'duplicate') return { status: 'duplicate' }
  return { status: 'processed', outcome: result.value }
}
