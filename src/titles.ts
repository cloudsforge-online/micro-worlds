/**
 * The title registry — 04-domain-model §7.1.
 *
 * "Does not exist today, and its absence is why a second game is impossible."
 *
 * A grep for `game_id|gameId|title_id|titleId|tenant` across the whole of the frozen game service
 * returns nothing at all: not a column, not a type, not a route parameter. There is one game, so
 * every table is implicitly its, and the second game has nowhere to go. This table is where it
 * goes.
 *
 * ## What a title IS, and what it is not
 *
 * A title owns SIMULATION. Worlds, tiles, players, ticks, combat, the map — all of it lives behind
 * `service_url` and this service never touches it. What this service owns is anything that must
 * outlive a season or cross a title: who the player is, what they own, what they have achieved,
 * and what they were sold. That boundary is 04-domain-model §7.4 and it is the only reason a
 * second title is a row rather than a rewrite.
 *
 * `capabilities` is how a title declares what it can be asked to do. The bridge reads it before
 * asking: a title with no `private_world` capability is told so at provisioning time, in a row an
 * operator can read, rather than being sent a request it will answer 404 to.
 */

import { withOutbox, type Db } from './outbox.ts'

export type TitleStatus = 'draft' | 'beta' | 'live' | 'sunset' | 'retired'

export const TITLE_STATUSES: readonly TitleStatus[] = Object.freeze([
  'draft',
  'beta',
  'live',
  'sunset',
  'retired',
])

/**
 * What a title can be asked for.
 *
 * A closed set rather than free text, because these are read by the provisioning bridge to decide
 * whether a purchase can be delivered at all. Free text would make a typo in a registration into
 * a purchase that is accepted and never provisioned — which is precisely the defect being fixed.
 */
export type Capability = 'private_world' | 'cosmetics' | 'achievements' | 'seasons' | 'inventory'

export const CAPABILITIES: readonly Capability[] = Object.freeze([
  'private_world',
  'cosmetics',
  'achievements',
  'seasons',
  'inventory',
])

export function isCapability(value: string): value is Capability {
  return (CAPABILITIES as readonly string[]).includes(value)
}

export class TitleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TitleError'
  }
}

export interface TitleRecord {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly status: TitleStatus
  readonly serviceUrl: string
  readonly capabilities: readonly Capability[]
  readonly assetScopes: readonly string[]
  readonly createdAt: Date
  readonly updatedAt: Date
}

interface TitleRow {
  readonly id: string
  readonly slug: string
  readonly name: string
  readonly status: string
  readonly service_url: string
  readonly capabilities: string[]
  readonly asset_scopes: string[]
  readonly created_at: Date
  readonly updated_at: Date
}

const COLUMNS = `id, slug, name, status, service_url, capabilities, asset_scopes, created_at, updated_at`

function toTitle(row: TitleRow): TitleRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    status: row.status as TitleStatus,
    serviceUrl: row.service_url,
    capabilities: row.capabilities as Capability[],
    assetScopes: row.asset_scopes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export const TITLE_REGISTERED_TOPIC = 'worlds.title.registered'

export interface RegisterTitle {
  readonly slug: string
  readonly name: string
  readonly serviceUrl: string
  readonly capabilities: readonly Capability[]
  readonly assetScopes: readonly string[]
  readonly status?: TitleStatus
  readonly actor: string
  readonly correlationId: string
}

/**
 * Register a title, or update the one with this slug.
 *
 * Idempotent on the slug, so a deploy that re-registers its title on every boot — which is the
 * obvious way for a title to declare itself — produces one row rather than a conflict an operator
 * has to go and clear.
 */
export async function registerTitle(
  sql: Db,
  producer: string,
  input: RegisterTitle,
): Promise<TitleRecord> {
  // Validated here rather than left to the CHECK, so the message names the rule rather than the
  // constraint. The CHECK stays: a row inserted by hand obeys it too.
  if (!/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/.test(input.slug)) {
    throw new TitleError(
      'a title slug must be 3 to 64 lowercase letters, digits or hyphens, and may not start or end with a hyphen',
    )
  }
  let url: URL
  try {
    url = new URL(input.serviceUrl)
  } catch {
    throw new TitleError('service_url must be an absolute URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // The bridge makes requests to this URL with the platform's own service credential. A `file:`
    // or a `gopher:` here would be a request this service makes on somebody else's behalf to
    // somewhere nobody intended.
    throw new TitleError('service_url must be http or https')
  }

  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<TitleRow[]>`
      insert into titles (slug, name, status, service_url, capabilities, asset_scopes)
      values (
        ${input.slug}, ${input.name}, ${input.status ?? 'draft'}, ${input.serviceUrl},
        ${input.capabilities as string[]}, ${input.assetScopes as string[]}
      )
      on conflict (slug) do update set
        name = excluded.name,
        status = excluded.status,
        service_url = excluded.service_url,
        capabilities = excluded.capabilities,
        asset_scopes = excluded.asset_scopes,
        updated_at = now()
      returning ${tx.unsafe(COLUMNS)}
    `
    const row = rows[0]
    if (!row) throw new Error('upsert returned no row')
    const title = toTitle(row)
    emit({
      topic: TITLE_REGISTERED_TOPIC,
      key: title.id,
      payload: {
        titleId: title.id,
        slug: title.slug,
        name: title.name,
        status: title.status,
        capabilities: title.capabilities,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return title
  })
}

export async function findTitle(sql: Db, id: string): Promise<TitleRecord | null> {
  const rows = await sql<TitleRow[]>`select ${sql.unsafe(COLUMNS)} from titles where id = ${id}`
  const row = rows[0]
  return row ? toTitle(row) : null
}

export async function findTitleBySlug(sql: Db, slug: string): Promise<TitleRecord | null> {
  const rows = await sql<TitleRow[]>`select ${sql.unsafe(COLUMNS)} from titles where slug = ${slug}`
  const row = rows[0]
  return row ? toTitle(row) : null
}

export async function listTitles(sql: Db, includeRetired = false): Promise<TitleRecord[]> {
  const rows = includeRetired
    ? await sql<TitleRow[]>`select ${sql.unsafe(COLUMNS)} from titles order by slug`
    : await sql<TitleRow[]>`
        select ${sql.unsafe(COLUMNS)} from titles where status <> 'retired' order by slug
      `
  return rows.map(toTitle)
}

/**
 * The scope a title's entitlements carry, which is billing's spelling and not ours.
 *
 * `title:<id>`, matching `EntitlementScope` in contracts-money exactly. Derived rather than stored
 * so the two cannot drift: a scope that this service composes differently from the one billing
 * validates is a purchase that is never matched to a title.
 */
export function titleScope(titleId: string): `title:${string}` {
  return `title:${titleId}`
}

/** The title id inside a `title:<id>` scope, or null for any other scope shape. */
export function titleIdFromScope(scope: string): string | null {
  return scope.startsWith('title:') ? scope.slice('title:'.length) : null
}

export function hasCapability(title: TitleRecord, capability: Capability): boolean {
  return title.capabilities.includes(capability)
}

/** A title that can be sold to. `draft` and `retired` cannot: a purchase would never be delivered. */
export function isSellable(title: TitleRecord): boolean {
  return title.status === 'beta' || title.status === 'live'
}
