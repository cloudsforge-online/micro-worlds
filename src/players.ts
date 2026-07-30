/**
 * The player, and what the player owns. 04-domain-model §7.2 and §7.3.
 *
 * ---------------------------------------------------------------------------------------------
 * **A PLAYER IS AN ACCOUNT, NOT A PARTICIPANT IN A WORLD.**
 *
 * The frozen schema has exactly one account-scoped row — `player_cosmetics(user_id)`, three
 * columns — and everything else is per-world. That is correct for a world and wrong for a player:
 * a reputation, a sanction and an age bracket must outlive a season, and an age bracket in
 * particular is a safeguarding fact that cannot be re-established every time somebody joins a
 * lobby.
 *
 * `equipped_cosmetics` is keyed BY TITLE here, where the frozen wardrobe is a single flat
 * `Partial<Record<CosmeticKind, string>>` on one account row. With one game the difference is
 * invisible; with two it is the difference between "my frame in each game" and "my frame", and
 * there is no migration from the second to the first that does not throw information away. The
 * cross-title default lives under the `*` key, so a title with no preference set still renders
 * something.
 * ---------------------------------------------------------------------------------------------
 */

import { withOutbox, type Db, type Tx } from './outbox.ts'

/* ------------------------------------------------------------------ profiles */

export type AgeBracket = 'unknown' | 'under_13' | '13_to_15' | '16_to_17' | 'adult'

export const AGE_BRACKETS: readonly AgeBracket[] = Object.freeze([
  'unknown',
  'under_13',
  '13_to_15',
  '16_to_17',
  'adult',
])

export class ProfileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileError'
  }
}

export interface Sanction {
  readonly kind: string
  readonly reason: string
  readonly appliedAt: string
  readonly expiresAt: string | null
  /** A title id, or `*` when the sanction is estate-wide. */
  readonly scope: string
}

export interface PlayerProfile {
  readonly userId: string
  readonly displayName: string
  readonly avatarAssetUrn: string | null
  readonly reputation: number
  /** `titleId | '*'` → `{ slot: cosmeticUrn }`. See the file header for why this is nested. */
  readonly equippedCosmetics: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly sanctions: readonly Sanction[]
  readonly ageBracket: AgeBracket
  readonly parentalControls: Readonly<Record<string, unknown>>
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface ProfileRow {
  readonly user_id: string
  readonly display_name: string
  readonly avatar_asset_urn: string | null
  readonly reputation: number
  readonly equipped_cosmetics: Record<string, Record<string, string>>
  readonly sanctions: Sanction[]
  readonly age_bracket: string
  readonly parental_controls: Record<string, unknown>
  readonly created_at: Date
  readonly updated_at: Date
}

const PROFILE_COLUMNS = `
  user_id, display_name, avatar_asset_urn, reputation, equipped_cosmetics, sanctions,
  age_bracket, parental_controls, created_at, updated_at
`

function toProfile(row: ProfileRow): PlayerProfile {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    avatarAssetUrn: row.avatar_asset_urn,
    reputation: row.reputation,
    equippedCosmetics: row.equipped_cosmetics,
    sanctions: row.sanctions,
    ageBracket: row.age_bracket as AgeBracket,
    parentalControls: row.parental_controls,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function findProfile(sql: Db, userId: string): Promise<PlayerProfile | null> {
  const rows = await sql<ProfileRow[]>`
    select ${sql.unsafe(PROFILE_COLUMNS)} from player_profiles where user_id = ${userId}
  `
  const row = rows[0]
  return row ? toProfile(row) : null
}

export interface UpsertProfile {
  readonly userId: string
  readonly displayName: string
  readonly avatarAssetUrn?: string | null
  readonly ageBracket?: AgeBracket
  readonly parentalControls?: Record<string, unknown>
}

export async function upsertProfile(sql: Db, input: UpsertProfile): Promise<PlayerProfile> {
  const name = input.displayName.trim()
  if (name.length === 0 || name.length > 40) {
    throw new ProfileError('display name must be 1 to 40 characters')
  }
  const rows = await sql<ProfileRow[]>`
    insert into player_profiles (
      user_id, display_name, avatar_asset_urn, age_bracket, parental_controls
    ) values (
      ${input.userId}, ${name}, ${input.avatarAssetUrn ?? null},
      ${input.ageBracket ?? 'unknown'}, ${sql.json((input.parentalControls ?? {}) as never)}
    )
    on conflict (user_id) do update set
      display_name = excluded.display_name,
      avatar_asset_urn = excluded.avatar_asset_urn,
      -- The age bracket is NOT overwritten with 'unknown' by a caller that did not send one.
      -- Downgrading a known bracket to unknown is a safeguarding control quietly switching off.
      age_bracket = case
        when excluded.age_bracket = 'unknown' then player_profiles.age_bracket
        else excluded.age_bracket
      end,
      parental_controls = excluded.parental_controls,
      updated_at = now()
    returning ${sql.unsafe(PROFILE_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('upsert returned no row')
  return toProfile(row)
}

/**
 * Equip a cosmetic in one slot, for one title (or `*` for every title).
 *
 * A read-modify-write of one JSON column under a row lock. The frozen service does the same and
 * explains why: each request names only the slots it is changing, so two of them would otherwise
 * both read the old map and the later write would drop the earlier slot. The row lock makes the
 * pair serial instead. That reasoning is carried forward verbatim; what is new is the title key.
 *
 * **The caller must have already checked the entitlement.** This function moves a row; it does not
 * decide whether the player owns the thing. That decision is in `server.ts`, where a billing
 * outage becomes a 503 rather than an unverified cosmetic being persisted — the frozen service's
 * `PUT /cosmetics` fails CLOSED for exactly that reason and it is right to.
 */
export async function equipCosmetic(
  sql: Db,
  input: {
    readonly userId: string
    readonly titleScope: string
    readonly slot: string
    /** Null clears the slot. Clearing needs no entitlement: you may always take something off. */
    readonly itemUrn: string | null
  },
): Promise<PlayerProfile> {
  const outcome = await sql.begin(async (tx) => {
    const rows = await tx<ProfileRow[]>`
      select ${tx.unsafe(PROFILE_COLUMNS)} from player_profiles
       where user_id = ${input.userId}
         for update
    `
    const row = rows[0]
    if (!row) throw new ProfileError('no profile for this account')

    const equipped: Record<string, Record<string, string>> = {
      ...(row.equipped_cosmetics ?? {}),
    }
    const forTitle = { ...(equipped[input.titleScope] ?? {}) }
    if (input.itemUrn === null) delete forTitle[input.slot]
    else forTitle[input.slot] = input.itemUrn
    if (Object.keys(forTitle).length === 0) delete equipped[input.titleScope]
    else equipped[input.titleScope] = forTitle

    const updated = await tx<ProfileRow[]>`
      update player_profiles
         set equipped_cosmetics = ${tx.json(equipped as never)}, updated_at = now()
       where user_id = ${input.userId}
      returning ${tx.unsafe(PROFILE_COLUMNS)}
    `
    const next = updated[0]
    if (!next) throw new Error('update returned no row')
    return { value: toProfile(next) }
  })
  return outcome.value
}

/* ------------------------------------------------------------------ inventory */

export type ItemSource = 'purchase' | 'reward' | 'craft' | 'market' | 'grant'

export const ITEM_SOURCES: readonly ItemSource[] = Object.freeze([
  'purchase',
  'reward',
  'craft',
  'market',
  'grant',
])

export function isItemSource(value: string): value is ItemSource {
  return (ITEM_SOURCES as readonly string[]).includes(value)
}

/** The cross-game scope. A value with a meaning, deliberately not a null. */
export const CROSS_TITLE = '*'

export class InventoryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryError'
  }
}

/** A bound item was offered to the market. Distinct, because it is the one refusal that is a POLICY. */
export class BoundItemError extends InventoryError {
  constructor(message: string) {
    super(message)
    this.name = 'BoundItemError'
  }
}

export interface InventoryItem {
  readonly id: string
  readonly userId: string
  /** A title id, or `*`. */
  readonly titleScope: string
  readonly itemUrn: string
  readonly source: ItemSource
  readonly quantity: number
  /** True = non-tradeable. **The anti-pay-to-win control.** */
  readonly bound: boolean
  readonly entitlementId: string | null
  readonly listedAt: Date | null
  readonly listingUrn: string | null
  readonly acquiredAt: Date
}

interface ItemRow {
  readonly id: string
  readonly user_id: string
  readonly title_scope: string
  readonly item_urn: string
  readonly source: string
  readonly quantity: number
  readonly bound: boolean
  readonly entitlement_id: string | null
  readonly listed_at: Date | null
  readonly listing_urn: string | null
  readonly acquired_at: Date
}

const ITEM_COLUMNS = `
  id, user_id, title_scope, item_urn, source, quantity, bound, entitlement_id, listed_at,
  listing_urn, acquired_at
`

function toItem(row: ItemRow): InventoryItem {
  return {
    id: row.id,
    userId: row.user_id,
    titleScope: row.title_scope,
    itemUrn: row.item_urn,
    source: row.source as ItemSource,
    quantity: row.quantity,
    bound: row.bound,
    entitlementId: row.entitlement_id,
    listedAt: row.listed_at,
    listingUrn: row.listing_urn,
    acquiredAt: row.acquired_at,
  }
}

export const ITEM_GRANTED_TOPIC = 'worlds.inventory.granted'
export const ITEM_LISTED_TOPIC = 'worlds.inventory.listed'

export interface GrantItem {
  readonly userId: string
  readonly titleScope: string
  readonly itemUrn: string
  readonly source: ItemSource
  readonly quantity?: number
  readonly bound: boolean
  readonly entitlementId?: string | null
  readonly actor: string
  readonly correlationId: string
}

/**
 * Put an item in an account's inventory.
 *
 * Takes a `Tx` so it can be called from inside the provisioning transaction — an item granted by
 * an entitlement and the provision row that records it must commit together, or a redelivery
 * grants a second copy.
 */
export async function grantItem(
  tx: Tx,
  emit: (event: {
    topic: string
    key: string
    payload: Record<string, unknown>
    actor?: string
    correlationId?: string
  }) => void,
  input: GrantItem,
): Promise<InventoryItem | null> {
  const rows = await tx<ItemRow[]>`
    insert into inventory_items (
      user_id, title_scope, item_urn, source, quantity, bound, entitlement_id
    ) values (
      ${input.userId}, ${input.titleScope}, ${input.itemUrn}, ${input.source},
      ${input.quantity ?? 1}, ${input.bound}, ${input.entitlementId ?? null}
    )
    -- An entitlement grants an item at most once. A redelivered 'granted' event therefore inserts
    -- nothing and this returns null, which the caller reads as "already done" rather than as an
    -- error. The partial unique index is what makes that true across replicas.
    on conflict do nothing
    returning ${tx.unsafe(ITEM_COLUMNS)}
  `
  const row = rows[0]
  if (!row) return null
  const item = toItem(row)
  emit({
    topic: ITEM_GRANTED_TOPIC,
    key: item.id,
    payload: {
      itemId: item.id,
      userId: item.userId,
      titleScope: item.titleScope,
      itemUrn: item.itemUrn,
      source: item.source,
      // On the event because a marketplace consuming this must know before it offers to list it.
      bound: item.bound,
      entitlementId: item.entitlementId,
    },
    actor: input.actor,
    correlationId: input.correlationId,
  })
  return item
}

export async function listInventory(
  sql: Db,
  query: { readonly userId: string; readonly titleScope?: string; readonly limit?: number },
): Promise<InventoryItem[]> {
  const limit = Math.min(query.limit ?? 200, 1_000)
  // A title's inventory is the title's own items PLUS the cross-game ones. Omitting `*` would make
  // a cross-game item invisible everywhere, which is the opposite of what it is for.
  const rows = query.titleScope
    ? await sql<ItemRow[]>`
        select ${sql.unsafe(ITEM_COLUMNS)}
          from inventory_items
         where user_id = ${query.userId}
           and title_scope in (${query.titleScope}, ${CROSS_TITLE})
         order by acquired_at desc
         limit ${limit}
      `
    : await sql<ItemRow[]>`
        select ${sql.unsafe(ITEM_COLUMNS)}
          from inventory_items
         where user_id = ${query.userId}
         order by acquired_at desc
         limit ${limit}
      `
  return rows.map(toItem)
}

export async function findItem(sql: Db, id: string): Promise<InventoryItem | null> {
  const rows = await sql<ItemRow[]>`
    select ${sql.unsafe(ITEM_COLUMNS)} from inventory_items where id = ${id}
  `
  const row = rows[0]
  return row ? toItem(row) : null
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **LIST AN ITEM FOR SALE. A BOUND ITEM CANNOT BE.**
 *
 * 04-domain-model §7.3: "`bound` is the anti-pay-to-win control: anything conferring power is
 * bound and cannot enter the market."
 *
 * The guard is in the WHERE clause AND in a CHECK constraint, and both are deliberate. The WHERE
 * clause is what produces a legible refusal for a caller. The constraint is what makes it true for
 * every other write in this service and every write by anything else that ever reaches this
 * database — including a hand-run UPDATE at three in the morning, which is exactly the shape of
 * the incident a policy in a route does not survive.
 *
 * The frozen estate has no such column. It relies on three independent conventions: a catalogue
 * policy stated in a comment, a trade engine that happens to be type-closed over resource names,
 * and the fact that entitlements have no transfer path because nobody has written one. Every one
 * of those is a property of what has NOT been built yet, and every one of them stops holding the
 * day somebody builds it.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function listForSale(
  sql: Db,
  producer: string,
  input: {
    readonly itemId: string
    readonly userId: string
    readonly listingUrn: string
    readonly actor: string
    readonly correlationId: string
  },
): Promise<InventoryItem> {
  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<ItemRow[]>`
      update inventory_items
         set listed_at = now(), listing_urn = ${input.listingUrn}
       where id = ${input.itemId}
         and user_id = ${input.userId}
         and listed_at is null
         and bound = false
      returning ${tx.unsafe(ITEM_COLUMNS)}
    `
    const row = rows[0]
    if (!row) {
      // Nothing matched. Read the row to say WHICH of the three reasons it was, because "you may
      // not sell this" and "you are already selling this" are different problems for the seller.
      const existing = await tx<ItemRow[]>`
        select ${tx.unsafe(ITEM_COLUMNS)} from inventory_items
         where id = ${input.itemId} and user_id = ${input.userId}
      `
      const item = existing[0]
      if (!item) throw new InventoryError('no such item')
      if (item.bound) {
        throw new BoundItemError(
          'this item is bound to your account and cannot be listed for sale',
        )
      }
      throw new InventoryError('this item is already listed')
    }
    const item = toItem(row)
    emit({
      topic: ITEM_LISTED_TOPIC,
      key: item.id,
      payload: {
        itemId: item.id,
        userId: item.userId,
        titleScope: item.titleScope,
        itemUrn: item.itemUrn,
        listingUrn: item.listingUrn,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return item
  })
}

/** Withdraw a listing. Always permitted: taking something off sale needs no authority. */
export async function unlist(sql: Db, itemId: string, userId: string): Promise<InventoryItem | null> {
  const rows = await sql<ItemRow[]>`
    update inventory_items
       set listed_at = null, listing_urn = null
     where id = ${itemId} and user_id = ${userId} and listed_at is not null
    returning ${sql.unsafe(ITEM_COLUMNS)}
  `
  const row = rows[0]
  return row ? toItem(row) : null
}
