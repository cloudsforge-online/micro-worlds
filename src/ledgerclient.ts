/**
 * The ledger, as this service uses it.
 *
 * **This service holds no balance, and a reward is not a column.**
 *
 * 04-domain-model §11: "no 'user balance' column anywhere outside the ledger's projection". The
 * service this supersedes keeps XP, levels, skill points and `tokens` as plain integer columns on
 * `player_progress`, incremented in place with no entry anywhere. That is tolerable only because
 * its `tokens` are a dead currency — nothing spends them, and their sole consumer is a single
 * achievement trigger. The moment a reward is worth anything it has to be a posting, because a
 * game exploit that mints rewards is then a MONEY INCIDENT and the ledger is the only place that
 * can be reconciled.
 *
 * ## One grant, one entry, for ever
 *
 * The idempotency key is derived from `(season, user, reason)` rather than random, so a retried
 * grant posts once: the ledger recognises the key and replays its stored answer, and the local
 * `reward_grants.idempotency_key UNIQUE` refuses the second row. Two independent defences, and
 * they fail in the same direction.
 */


import { HttpClient, HttpError } from '@cloudsforge/http'
import { engagementAccount } from '@cloudsforge/contracts-money'
import type { Actor, EntryKind, LedgerAssetCode } from '@cloudsforge/contracts-money'
import type { LiveScope } from '@cloudsforge/contracts-auth'

/**
 * The scopes this service's token must carry to call this peer.
 *
 * ── THIS IS AN OUTBOUND DEMAND, AND THAT DIRECTION WAS UNCHECKED ─────────────────────────────
 *
 * `readonly LiveScope[]`, not `readonly string[]`. `micro-org`'s `service-ci.yml` proves that
 * every scope a repository's route GATES demand is registered — the INBOUND direction. This
 * constant is the other one: what this service PRESENTS to a peer. Nothing had ever checked it,
 * which is how `micro-market` came to declare `policy:evaluate` and `micro-wallet`
 * `custody:address` — neither of which has ever been a registry key — for the life of both
 * services.
 *
 * The consequence is not a 403 on one call. `micro-deploy`'s `derive-grants.mjs` reads this
 * constant into `IDENTITY_SERVICE_TOKEN_GRANTS`, and identity validates that list against the
 * registry at import and REFUSES TO START on a name it does not know
 * (`parseServiceGrants`, identity/src/env.ts:169). An unregistered demand here is a dead identity
 * container, and therefore no tokens for anybody.
 *
 * ── AND `LiveScope` RATHER THAN `Scope` ───────────────────────────────────────────────────────
 *
 * `Scope` is `keyof typeof SCOPES` — every registered key, DEPRECATED ones included. It would
 * catch `policy:evaluate`, which is not a key, and wave through `wallet:provision`, which is.
 * Identity will not mint a deprecated scope either, so that is the same failure by a quieter
 * route: satisfies the compiler, dies at runtime.
 *
 * `LiveScope = Exclude<Scope, DeprecatedScope>`, and `DeprecatedScope` is computed FROM `SCOPES`
 * by a conditional type over the `deprecated` field rather than hand-listed
 * (`contracts/packages/auth/src/index.ts:527`), so it cannot drift from the registry — a
 * hand-written companion list is the failure that package keeps catching.
 *
 * `Scope` deliberately keeps its wide meaning and this does not narrow it: a token arriving from
 * anywhere may carry a scope that has since died, so reading is wide and demanding is narrow.
 * This is the demanding direction.
 */
export const LEDGER_SCOPES: readonly LiveScope[] = Object.freeze(['ledger:post'])

/**
 * The ledger refused on the state of the world — most often an insufficient balance, which is a
 * 402 to the customer and not an error at all. Never retried with the same request.
 */
export class LedgerRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'LedgerRefusedError'
    this.code = code
    this.status = status
  }
}

/** The ledger could not be reached, or answered 5xx. Retry with the same idempotency key. */
export class LedgerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LedgerUnavailableError'
  }
}

export interface AccountRef {
  readonly subject: string
  readonly assetCode: LedgerAssetCode
  readonly purpose: 'available' | 'reserved' | 'escrow' | 'treasury' | 'fees' | 'payout_due' | 'suspense'
  readonly type: 'liability' | 'asset' | 'revenue' | 'expense' | 'equity' | 'clearing'
}

export interface PostingRequest {
  readonly direction: 'debit' | 'credit'
  readonly amount: bigint
  readonly assetCode: LedgerAssetCode
  readonly sequence: number
  readonly account: AccountRef
}

export interface PostEntryRequest {
  readonly kind: EntryKind
  readonly actor: Actor
  readonly correlationId: string
  readonly idempotencyKey: string
  readonly description?: string
  readonly postings: readonly PostingRequest[]
}

export interface PostedEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
  /** True when the ledger answered from a stored response rather than by posting. */
  readonly replayed: boolean
}

export interface LedgerClient {
  postEntry(request: PostEntryRequest): Promise<PostedEntry>
}

/**
 * The two postings that pay a reward: the platform's promotional expense out, the player's balance
 * in.
 *
 * The direction is the opposite of a purchase and that is the point — this is the platform GIVING
 * a customer money, so it must show up as a spend the platform can be asked about rather than as
 * a number that appeared in a player's row. Balanced by construction because it is the same
 * number on both sides.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DEBIT SIDE IS `engagement:worlds`, AND IT FIXED A LIVE COLLISION.**
 *
 * docs/ecosystem/21 §4: "every grant a service pays out references its engagement account as the
 * debit side", so that an auditor reconstructs the programme from the ledger alone. §1 names this
 * service's gap exactly — `seasons.reward_budget_shards` is required positive but "nothing
 * anywhere says who funds it". This posting is the answer: the budget is an allowance against
 * `engagement:worlds`, and the money leaves that account when a reward is paid.
 *
 * It also removes a defect that would have failed in production the first time both services ran.
 * This function used to debit `(platform, SHARD, fees)` as type `expense`, while `micro-market`
 * and `micro-trade` credit the SAME account key as type `revenue`
 * (market/src/ledgerclient.ts:135). The ledger's account key is `(subject, asset_code, purpose)`
 * and `ensureAccount` THROWS `AccountConflictError` when a caller's type disagrees with the
 * existing row (ledger/src/accounts.ts:125) — so whichever service posted second would have had
 * every entry refused. Nothing caught it because each suite uses its own fake ledger.
 *
 * `equity` is load-bearing beyond the collision: the ledger's overdraft trigger exempts
 * `clearing` and `suspense`, NOT `equity`, so a reward that would take the engagement account
 * negative is refused BY THE LEDGER. "Who funds this budget" stops being unanswerable and starts
 * being enforced.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function rewardPostings(input: {
  readonly subject: string
  readonly amount: bigint
}): readonly PostingRequest[] {
  return [
    {
      // Spelled by @cloudsforge/contracts-money, never here: the account key is
      // (subject, asset_code, purpose), so a second spelling would be a second account and would
      // split the programme's ledger in half.
      account: {
        subject: engagementAccount('worlds', 'SHARD').subject,
        assetCode: 'SHARD',
        purpose: 'treasury',
        type: 'equity',
      },
      direction: 'debit',
      amount: input.amount,
      assetCode: 'SHARD',
      sequence: 0,
    },
    {
      account: { subject: input.subject, assetCode: 'SHARD', purpose: 'available', type: 'liability' },
      direction: 'credit',
      amount: input.amount,
      assetCode: 'SHARD',
      sequence: 1,
    },
  ]
}

/**
 * The key one reward is posted under, for ever.
 *
 * `(season, user, reason)` — DERIVED, so a retry after a lost response replays rather than paying
 * a second time. `reason` is the achievement key or the objective id, which is what makes "the
 * same reward" a well-defined thing across two attempts.
 */
export function rewardIdempotencyKey(
  seasonId: string,
  userId: string,
  reason: string,
): string {
  return `worlds:reward:${seasonId}:${userId}:${reason}`
}

export interface LedgerClientOptions {
  readonly baseUrl: string
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly originatingService: string
  readonly fetch?: typeof globalThis.fetch
}

interface RawEntry {
  readonly id: string
  readonly kind: string
  readonly recordedAt: string
}

export function httpLedgerClient(options: LedgerClientOptions): LedgerClient {
  const client = new HttpClient({
    baseUrl: options.baseUrl,
    name: 'ledger',
    defaultDeadlineMs: options.deadlineMs,
    token: options.token,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  return {
    async postEntry(request) {
      try {
        // The key is in the body AND on the request, and both matter. In the body it is what the
        // ledger stores and dedupes on; on the request it is what makes the POST retriable at all,
        // because `HttpClient` attempts a non-idempotent method exactly once without one.
        const body = await client.request<{ entry: RawEntry; replayed: boolean }>('/entries', {
          method: 'POST',
          body: {
            kind: request.kind,
            originatingService: options.originatingService,
            actor: request.actor,
            correlationId: request.correlationId,
            idempotencyKey: request.idempotencyKey,
            ...(request.description !== undefined ? { description: request.description } : {}),
            postings: request.postings.map((posting) => ({
              direction: posting.direction,
              // Smallest units as a decimal STRING, in both directions. A JSON number is an IEEE
              // 754 double, and a large amount does not survive one — it does not fail either, it
              // comes back subtly wrong.
              amount: posting.amount.toString(),
              assetCode: posting.assetCode,
              sequence: posting.sequence,
              account: posting.account,
            })),
          },
          idempotencyKey: request.idempotencyKey,
        })
        return {
          id: body.entry.id,
          kind: body.entry.kind,
          recordedAt: body.entry.recordedAt,
          replayed: body.replayed,
        }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * `HttpError.peerDecided` is the discriminator: a 4xx means the ledger looked at the request and
 * said no, which is a permanent fact about it. Anything else means we do not know whether the
 * entry posted, and the only safe response is to retry with the same key.
 */
function translate(err: unknown): Error {
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    return new LedgerRefusedError(err.status, parsed.code, parsed.message)
  }
  if (err instanceof LedgerRefusedError || err instanceof LedgerUnavailableError) return err
  return new LedgerUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'ledger_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'ledger_error', message: body.slice(0, 500) }
  }
}
