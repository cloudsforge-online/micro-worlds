/**
 * Billing, as this service uses it. One question: does this account own that.
 *
 * ---------------------------------------------------------------------------------------------
 * **THIS INTERFACE IS THE FIRST OF THE SIX MISSING PIECES, AND IT IS THE ONE THE OTHER FIVE REST
 * ON.**
 *
 * The service this supersedes cannot ask. `GET /entitlements` on Pay is Bearer-only — there is no
 * service-token route and the frozen client says so in a comment — so the only way to learn what
 * somebody owns is to be holding their token, inside a request they made. That single fact makes
 * every form of asynchronous fulfilment impossible: a background job has no user token, so no job
 * can ever check an entitlement, so nothing can ever provision anything that was bought. It is
 * the mechanical reason the private world is never raised.
 *
 * `GET /internal/entitlements/:userId` with `billing:read` is the route that ends that, and this
 * client is where this service uses it.
 * ---------------------------------------------------------------------------------------------
 *
 * ## Uncached, deliberately
 *
 * Equipping is a rare, interactive act. A refund or a revocation should take effect the next time
 * somebody opens the shop, not whenever a TTL happens to lapse. The frozen client makes the same
 * call for the same reason and it is right.
 *
 * ## `BillingUnavailableError` is a distinct class, and the distinction is the whole point
 *
 * The caller must be able to tell "billing says no" from "billing did not answer", because the
 * first is a 403 and the second is a 503. Collapsing them — which is what the frozen client does,
 * deliberately, to avoid signing users out on a token disagreement — means a Pay outage and a
 * genuine refusal are indistinguishable, and the only safe reading of that is the pessimistic one.
 * Here they are separate, so `GET /players/me` can fail OPEN and `PUT .../cosmetics` can fail
 * CLOSED, which is the split the frozen routes want and cannot express.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'

export const BILLING_SCOPES: readonly string[] = Object.freeze(['billing:read'])

/** Billing could not be reached, or answered 5xx. We do not know what this account owns. */
export class BillingUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BillingUnavailableError'
  }
}

export interface EntitlementWire {
  readonly id: string
  readonly sku: string
  readonly scope: string
  readonly active: boolean
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface EntitlementReader {
  /** Everything the account owns, at the instant billing evaluated it. */
  list(userId: string, scope?: string): Promise<readonly EntitlementWire[]>
  /**
   * Whether the account owns a thing, in a scope.
   *
   * `itemUrn` is matched against the SKU and against `cf:catalogue:item:<sku>`, because an item is
   * named one way in an inventory row and the other in billing's catalogue. Doing the translation
   * here rather than at each call site is what stops two routes disagreeing about what "owns" is.
   */
  owns(userId: string, itemUrn: string, scope?: string): Promise<boolean>
}

export interface BillingClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

/** The SKU inside an item urn, or the string itself when it is already a bare SKU. */
export function skuOf(itemUrn: string): string {
  const prefix = 'cf:catalogue:item:'
  return itemUrn.startsWith(prefix) ? itemUrn.slice(prefix.length) : itemUrn
}

export function httpBillingClient(options: BillingClientOptions): EntitlementReader {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'billing',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const reader: EntitlementReader = {
    async list(userId, scope) {
      try {
        const query = scope && scope !== '*' ? `?scope=title:${encodeURIComponent(scope)}` : ''
        const body = await client.get<{ entitlements?: EntitlementWire[] }>(
          `/internal/entitlements/${encodeURIComponent(userId)}${query}`,
        )
        return body.entitlements ?? []
      } catch (err) {
        // A 404 from this route means the account has nothing, not that billing is broken — but
        // billing answers 200 with an empty list for that, so a 404 here is a routing fault and is
        // treated as one.
        throw new BillingUnavailableError(
          err instanceof HttpError
            ? `billing answered ${err.status}`
            : err instanceof Error
              ? err.message
              : String(err),
        )
      }
    },

    async owns(userId, itemUrn, scope) {
      const sku = skuOf(itemUrn)
      // Asked WITHOUT the scope filter and matched here, so a cross-title (`platform`-scoped)
      // cosmetic is found when a title asks about it. Filtering server-side on `title:<id>` would
      // hide exactly the entitlements that are meant to apply everywhere.
      const entitlements = await reader.list(userId)
      return entitlements.some((entitlement) => {
        if (!entitlement.active) return false
        if (entitlement.sku !== sku) return false
        if (!scope || scope === '*') return true
        return entitlement.scope === 'platform' || entitlement.scope === `title:${scope}`
      })
    },
  }
  return reader
}
