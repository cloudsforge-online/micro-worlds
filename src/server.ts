/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`POST /v1/events` IS THE ENTITLEMENT BRIDGE'S FRONT DOOR, AND IT IS SIGNATURE-CHECKED BEFORE
 * IT IS PARSED.**
 *
 * A provisioning webhook with no MAC is a free-worlds endpoint: anyone who can reach the port can
 * assert that a customer bought a private world and get one raised. So the body is verified
 * against `OUTBOX_ACCEPT_SECRETS` over the exact bytes received, with a timing-safe comparison,
 * BEFORE `JSON.parse` is called on it — verifying after parsing would make the parser reachable by
 * an unauthenticated caller, and would sign a re-serialisation rather than what arrived.
 *
 * `OUTBOX_ACCEPT_SECRETS` is a LIST and defaults to `[OUTBOX_SIGNING_SECRET]`. A single shared key
 * across 24 services cannot be rotated by swapping it: whichever end moves first has every
 * delivery between them refused until the other catches up, and a bridge that refuses grant events
 * provisions no worlds. Accepting more than one key for the length of the cutover is what makes
 * the ordering of a rolling deploy stop mattering. Signing stays one key.
 *
 * The handler then does one thing: `withInbox` plus one INSERT. It does not call a title. A slow
 * title would otherwise make billing's relay time out and redeliver, and a bridge whose delivery
 * pressure is coupled to a game's provisioning latency melts on the day the game is slow.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The other decision that is easy to get backwards is the fail-open / fail-closed split on
 * cosmetics, and it is carried forward from the frozen service, which gets it right:
 *
 *   `GET  /v1/players/me` fails OPEN.   It runs on every app load, so a billing outage must not be
 *                                       able to break signing in. What someone is already wearing
 *                                       is ours to answer.
 *   `PUT  /v1/players/me/cosmetics`     A billing outage means "ask again later", not "wear it
 *        fails CLOSED, with a 503.      anyway". An unverified cosmetic is never persisted.
 */

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import {
  ForbiddenError,
  TokenError,
  bearerFrom,
  isAdmin,
  requireScope,
  statusFor,
  subjectUserId,
  type Principal,
} from '@cloudsforge/auth'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import type { JobQueue } from '@cloudsforge/jobs'
import { SEASON_SEALED_TOPIC, handleSeasonSealed } from './heraldry.ts'
import { SIGNATURE_HEADER, verifyEventSignature, type Db } from './outbox.ts'
import {
  isCapability,
  listTitles,
  registerTitle,
  TitleError,
  type Capability,
} from './titles.ts'
import {
  BoundItemError,
  CROSS_TITLE,
  InventoryError,
  ProfileError,
  equipCosmetic,
  findProfile,
  listForSale,
  listInventory,
  unlist,
  upsertProfile,
} from './players.ts'
import {
  GRANTED_TOPIC,
  MalformedEventError,
  findProvision,
  listProvisions,
  recordGrant,
  reopenProvision,
  type ProvisionState,
} from './provisioning.ts'
import { PROVISION_KIND, provisionKey } from './jobs.ts'
import {
  BudgetExceededError,
  BudgetRaiseNeedsApprovalError,
  RewardError,
  defineAchievement,
  grantReward,
  listAchievements,
  listSeasons,
  listUnlocked,
  openSeason,
  seasonBudget,
  unlockAchievement,
  type RewardDeps,
} from './rewards.ts'
import type { EntitlementReader } from './billingclient.ts'

/** The verifier as this file needs it. An interface, so a test does not need a JWKS. */
export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export const READ_SCOPE = 'worlds:read'
export const WRITE_SCOPE = 'worlds:write'
/** A title service's own authority: it may report achievements and ask for rewards. */
export const TITLE_SCOPE = 'worlds:title'
/** An administrator's authority over the registry. Held by nothing that plays a game. */
export const ADMIN_SCOPE = 'worlds:admin'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Db
  readonly producer: string
  readonly rewards: RewardDeps
  readonly billing: EntitlementReader
  readonly queue: Pick<JobQueue, 'enqueue'>
  /**
   * Every key an inbound event signature may be verified against, newest first. See the file
   * header, and `env.ts`'s `outboxAcceptSecrets` for why it is a list.
   *
   * Named for ACCEPTING rather than for signing, because that is all it does: outbound events are
   * signed by the relay from `OUTBOX_SIGNING_SECRET` (`index.ts`), which stays a single key.
   */
  readonly eventAcceptSecrets: readonly string[]
  readonly beforeScrape?: () => Promise<void>
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return metrics
    .register({
      name: 'worlds_provisions_total',
      help: 'Entitlements provisioned, by kind and outcome. `unsupported` is a customer who paid for something undeliverable.',
      kind: 'counter',
      labels: ['kind', 'outcome'],
    })
    .register({
      name: 'worlds_provisions_outstanding',
      help: 'Provisions not yet terminal. Sampled by the sweep, which is what recovers them.',
      kind: 'gauge',
      labels: [],
    })
    .register({
      name: 'worlds_events_rejected_total',
      help: 'Inbound events refused, by reason. A climbing `bad_signature` is somebody probing the bridge.',
      kind: 'counter',
      labels: ['reason'],
    })
    .register({
      name: 'worlds_rewards_granted_total',
      help: 'Reward grants, by outcome. `budget_exceeded` is the cap doing its job, and a spike is an exploit.',
      kind: 'counter',
      labels: ['outcome'],
    })
    .register({
      name: 'worlds_bound_listing_refusals_total',
      help: 'Attempts to list a bound item for sale. Non-zero means a client believes it may.',
      kind: 'counter',
      labels: [],
    })
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 256 * 1024
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
  readonly headers?: Record<string, string>
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  /** Used verbatim as the metric label, so cardinality is bounded by the number of routes. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

/**
 * Compile `/v1/titles/:id` into a matcher. The segment pattern excludes `/` so a parameter cannot
 * swallow the rest of the path and make one route answer for another.
 */
function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()

    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

/**
 * Map every failure onto a status, grouped by what the caller should do about it.
 *
 *   * **400** — the request could not be legal. Fix it; retrying will not help.
 *   * **403** — a scope, a role, or a BOUND ITEM. The last is the anti-pay-to-win control saying
 *     no, and it gets its own code so a client can show the right sentence.
 *   * **404** — something named does not exist, or belongs to somebody else. The same answer on
 *     purpose: a distinct 403 for the second is an enumeration oracle.
 *   * **409** — well formed, but the state refuses it: an item already listed.
 *   * **422** — a reward that would exceed its season's budget. Not a 500: the cap did its job,
 *     and the caller needs to know it was the budget rather than a fault.
 *   * **503** — an upstream is unreachable, or a signature could not be checked.
 */
async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid bearer token is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      ctx.log.info('forbidden request', { required })
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof BoundItemError) {
      deps.metrics.increment('worlds_bound_listing_refusals_total')
      // Its own code, because "you may not sell this, ever" is a different sentence from "you may
      // not do this right now" and a client should be able to say so.
      return errorReply(403, 'item_bound', err.message, ctx.requestId)
    }
    if (err instanceof BudgetExceededError) {
      deps.metrics.increment('worlds_rewards_granted_total', { outcome: 'budget_exceeded' })
      ctx.log.error('a reward was refused by its season budget', {
        seasonId: err.seasonId,
        remaining: err.remaining.toString(),
      })
      return errorReply(422, 'budget_exceeded', err.message, ctx.requestId)
    }
    if (err instanceof BudgetRaiseNeedsApprovalError) {
      // Its own code, and logged at error, because a silent raise of a spending limit is what this
      // refusal exists to prevent — an operator who tried one should be able to find the attempt.
      // 422 rather than 403: the caller's authority is not the problem, the missing approval is.
      ctx.log.error('a season budget raise was refused for want of an approval', {
        titleId: err.titleId,
        slug: err.slug,
      })
      return errorReply(422, 'budget_raise_needs_approval', err.message, ctx.requestId)
    }
    if (err instanceof InventoryError) {
      return errorReply(409, 'inventory_state', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) {
      return errorReply(404, 'not_found', err.message, ctx.requestId)
    }
    if (
      err instanceof BadRequestError ||
      err instanceof TitleError ||
      err instanceof ProfileError ||
      err instanceof RewardError ||
      err instanceof MalformedEventError ||
      err instanceof RangeError
    ) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    if (err instanceof Error && err.name === 'LedgerUnavailableError') {
      ctx.log.error('the ledger could not be reached', { err })
      return errorReply(503, 'ledger_unavailable', 'the reward could not be paid; retry', ctx.requestId)
    }
    if (err instanceof Error && err.name === 'BillingUnavailableError') {
      // FAIL CLOSED. "Ask again later", not "wear it anyway".
      return errorReply(
        503,
        'entitlements_unavailable',
        'we cannot check your purchases right now — try again shortly',
        ctx.requestId,
      )
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /* ------------------------------------------------------------------ the bridge */

    /**
     * **The entitlement bridge's front door.** Signature-checked before it is parsed; see the file
     * header.
     */
    define('POST', '/v1/events', async (ctx, deps) => {
      // THE RAW BYTES, AND THE SIGNATURE OVER THEM, BEFORE ANYTHING PARSES ANYTHING.
      const raw = await readRaw(ctx.req)
      const presented = headerOf(ctx.req, SIGNATURE_HEADER)
      const verified = presented
        ? verifyEventSignature(raw.toString('utf8'), deps.eventAcceptSecrets, presented)
        : ({ ok: false, reason: 'malformed_header' } as const)
      if (!verified.ok) {
        deps.metrics.increment('worlds_events_rejected_total', { reason: 'bad_signature' })
        // 401 rather than 403: the caller failed to authenticate at all. The message says nothing
        // about which half was wrong.
        ctx.log.warn('an inbound event failed its signature check')
        return errorReply(401, 'bad_signature', 'the event signature did not verify', ctx.requestId)
      }
      if (verified.keyIndex > 0) {
        // The index, never the key. A producer still signing with a rotated-out secret is the one
        // thing standing between "the new key is deployed" and "the old key can be deleted", and
        // without this line the only way to find out is to delete it and see what breaks.
        ctx.log.warn('an event verified against a rotated-out signing key', {
          keyIndex: verified.keyIndex,
        })
      }

      // ONLY NOW is the body parsed.
      let envelope: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(raw.toString('utf8'))
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new BadRequestError('an event envelope must be a JSON object')
        }
        envelope = parsed as Record<string, unknown>
      } catch {
        deps.metrics.increment('worlds_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('the event body is not valid JSON')
      }

      const topic = typeof envelope['topic'] === 'string' ? envelope['topic'] : ''
      const eventId = typeof envelope['id'] === 'string' ? envelope['id'] : ''
      if (!UUID.test(eventId)) {
        deps.metrics.increment('worlds_events_rejected_total', { reason: 'malformed' })
        throw new BadRequestError('an event envelope must carry a uuid id')
      }
      if (topic === SEASON_SEALED_TOPIC) {
        // A sealed Aetherholm season: mint the victors' heraldry onto the shared profile. The
        // event this consumer was missing for a full phase — §3.3p's "an event with no consumer
        // yet" — and the reason the entitlement bridge finally carries something across titles.
        const raw = envelope['payload']
        const payload =
          typeof raw === 'object' && raw !== null && !Array.isArray(raw)
            ? (raw as Record<string, unknown>)
            : {}
        const seasonId = typeof payload['seasonId'] === 'string' ? payload['seasonId'] : ''
        const victors = Array.isArray(payload['victors']) ? payload['victors'] : []
        if (!seasonId) throw new BadRequestError('season.sealed must carry seasonId')
        const done = deps.lifecycle.track()
        try {
          const result = await handleSeasonSealed(deps.sql, deps.producer, eventId, {
            seasonId,
            victors: victors as never,
            correlationId:
              typeof envelope['correlationId'] === 'string' ? envelope['correlationId'] : eventId,
          })
          if (result.status === 'duplicate') {
            return { status: 200, body: { status: 'duplicate', eventId } }
          }
          ctx.log.info('heraldry granted', { seasonId, ...result.outcome })
          return { status: 202, body: { status: 'granted', ...result.outcome } }
        } finally {
          done()
        }
      }
      if (topic !== GRANTED_TOPIC) {
        // Accepted and ignored, with a 202. A 4xx would make the producer's relay retry an event
        // it is correct to send and we are correct not to act on, for ever.
        deps.metrics.increment('worlds_events_rejected_total', { reason: 'not_subscribed' })
        return { status: 202, body: { status: 'ignored', topic } }
      }

      const payload =
        typeof envelope['payload'] === 'object' && envelope['payload'] !== null
          ? (envelope['payload'] as Record<string, unknown>)
          : {}

      const done = deps.lifecycle.track()
      try {
        const result = await recordGrant(deps.sql, deps.producer, {
          eventId,
          payload,
          actor: typeof envelope['actor'] === 'string' ? envelope['actor'] : 'service:billing',
        })
        if (result.status === 'recorded' && result.provision) {
          // Enqueued rather than provisioned here. See the file header: coupling delivery pressure
          // to a title's latency is what melts the bridge on the day a title is slow.
          await deps.queue.enqueue({
            kind: PROVISION_KIND,
            key: provisionKey(result.provision.titleId),
            payload: { provisionId: result.provision.id },
            onConflict: 'keep',
          })
          ctx.log.info('entitlement recorded for provisioning', {
            entitlementId: result.provision.entitlementId,
            sku: result.provision.sku,
            kind: result.provision.kind,
          })
        }
        return {
          status: 202,
          body: {
            status: result.status,
            ...(result.provision ? { provisionId: result.provision.id } : {}),
          },
        }
      } finally {
        done()
      }
    }),

    /* ------------------------------------------------------------------ titles */

    /** The registry. Public: a launcher listing games cannot require a token to do it. */
    define('GET', '/v1/titles', async (ctx, deps) => {
      const titles = await listTitles(deps.sql, ctx.url.searchParams.get('includeRetired') === 'true')
      return {
        status: 200,
        body: {
          titles: titles.map((title) => ({
            id: title.id,
            slug: title.slug,
            name: title.name,
            status: title.status,
            capabilities: title.capabilities,
            assetScopes: title.assetScopes,
          })),
        },
      }
    }),

    define('POST', '/v1/titles', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      // Registering a title says where this service will send a customer's purchase. An ordinary
      // player token must never be able to do that.
      if (principal.kind === 'service') requireScope(principal, ADMIN_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${ADMIN_SCOPE} or role:admin`)

      const body = await readJson(ctx.req)
      const capabilities: Capability[] = []
      for (const item of Array.isArray(body['capabilities']) ? body['capabilities'] : []) {
        if (typeof item !== 'string' || !isCapability(item)) {
          throw new BadRequestError(`unknown capability: ${String(item)}`)
        }
        if (!capabilities.includes(item)) capabilities.push(item)
      }
      const title = await registerTitle(deps.sql, deps.producer, {
        slug: requireString(body, 'slug'),
        name: requireString(body, 'name'),
        serviceUrl: requireString(body, 'serviceUrl'),
        capabilities,
        assetScopes: (Array.isArray(body['assetScopes']) ? body['assetScopes'] : []).filter(
          (item): item is string => typeof item === 'string',
        ),
        ...(typeof body['status'] === 'string'
          ? { status: body['status'] as 'draft' | 'beta' | 'live' | 'sunset' | 'retired' }
          : {}),
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      return { status: 201, body: { title } }
    }),

    /* ------------------------------------------------------------------ the player */

    /**
     * The account-scoped profile, plus everything it owns.
     *
     * **Fails OPEN.** This runs on every app load, so a billing outage must not be able to break
     * signing in. What someone is already wearing is ours to answer.
     */
    define('GET', '/v1/players/me', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const userId = subjectUserId(principal, undefined)
      const titleScope = ctx.url.searchParams.get('titleId') ?? undefined

      const profile = await findProfile(deps.sql, userId)
      const inventory = await listInventory(deps.sql, {
        userId,
        ...(titleScope ? { titleScope } : {}),
      })
      return {
        status: 200,
        body: {
          profile,
          inventory: inventory.map(toItemWire),
          achievements: (await listUnlocked(deps.sql, userId, titleScope)).map((row) => ({
            key: row.achievement.key,
            titleId: row.achievement.titleId,
            name: row.achievement.name,
            points: row.achievement.points,
            unlockedAt: row.unlockedAt.toISOString(),
          })),
        },
      }
    }),

    define('PUT', '/v1/players/me', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const profile = await upsertProfile(deps.sql, {
        userId: subjectUserId(principal, undefined),
        displayName: requireString(body, 'displayName'),
        avatarAssetUrn: typeof body['avatarAssetUrn'] === 'string' ? body['avatarAssetUrn'] : null,
        ...(typeof body['ageBracket'] === 'string'
          ? { ageBracket: body['ageBracket'] as 'unknown' }
          : {}),
        ...(typeof body['parentalControls'] === 'object' && body['parentalControls'] !== null
          ? { parentalControls: body['parentalControls'] as Record<string, unknown> }
          : {}),
      })
      return { status: 200, body: { profile } }
    }),

    /**
     * Equip a cosmetic, for one title or across all of them.
     *
     * **Fails CLOSED.** A billing outage means "ask again later", not "wear it anyway", and an
     * unverified cosmetic is never persisted. Carried forward from the frozen `PUT /cosmetics`,
     * which is right about this.
     */
    define('PUT', '/v1/players/me/cosmetics', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const userId = subjectUserId(principal, undefined)
      const body = await readJson(ctx.req)
      const slot = requireString(body, 'slot')
      const titleScope = typeof body['titleId'] === 'string' ? body['titleId'] : CROSS_TITLE
      const itemUrn = typeof body['itemUrn'] === 'string' ? body['itemUrn'] : null

      if (itemUrn !== null) {
        // Clearing a slot needs no entitlement — you may always take something off, including
        // something you no longer own. Only SETTING one is checked.
        const owned = await deps.billing.owns(userId, itemUrn, titleScope)
        if (!owned) throw new ForbiddenError('an entitlement for that cosmetic')
      }

      const profile = await equipCosmetic(deps.sql, { userId, titleScope, slot, itemUrn })
      return { status: 200, body: { profile } }
    }),

    /* ------------------------------------------------------------------ inventory */

    define('GET', '/v1/players/me/inventory', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const titleScope = ctx.url.searchParams.get('titleId') ?? undefined
      const items = await listInventory(deps.sql, {
        userId: subjectUserId(principal, undefined),
        ...(titleScope ? { titleScope } : {}),
      })
      return { status: 200, body: { items: items.map(toItemWire) } }
    }),

    /**
     * Offer an item to the market.
     *
     * **A bound item cannot be listed.** The refusal is a 403 `item_bound`, and it is produced by a
     * WHERE clause and backstopped by a CHECK constraint — see `players.ts`. This route is the
     * thing the constraint exists to make unnecessary; it is here because a legible refusal is
     * better than a constraint violation, not because it is the control.
     */
    define('POST', '/v1/players/me/inventory/:id/list', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const item = await listForSale(deps.sql, deps.producer, {
        itemId: itemIdOf(ctx),
        userId: subjectUserId(principal, undefined),
        listingUrn: requireString(body, 'listingUrn'),
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      return { status: 201, body: { item: toItemWire(item) } }
    }),

    define('DELETE', '/v1/players/me/inventory/:id/list', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, WRITE_SCOPE)
      const item = await unlist(deps.sql, itemIdOf(ctx), subjectUserId(principal, undefined))
      if (!item) throw new NotFoundError('no such listing')
      return { status: 200, body: { item: toItemWire(item) } }
    }),

    /* ------------------------------------------------------------------ provisions */

    /** What a customer has been sold and whether it was delivered. */
    define('GET', '/v1/provisions', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      const state = ctx.url.searchParams.get('state') ?? undefined
      // An operator may read the whole backlog — which is the fifth of the six missing pieces:
      // there is no view of failed rentals anywhere in the estate today.
      if (isAdmin(principal) || (principal.kind === 'service' && hasScope(principal, ADMIN_SCOPE))) {
        const rows = await listProvisions(deps.sql, {
          ...(state ? { state: state as ProvisionState } : {}),
        })
        return { status: 200, body: { provisions: rows } }
      }
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const rows = await listProvisions(deps.sql, {
        subject: `user:${subjectUserId(principal, undefined)}`,
        ...(state ? { state: state as ProvisionState } : {}),
      })
      return { status: 200, body: { provisions: rows } }
    }),

    /**
     * An operator's explicit retry of a terminal provision.
     *
     * The ONLY way out of `failed`. A background poll must never do this: a poll that resurrects
     * failures repeats whatever caused them, at the rate of the poll.
     */
    define('POST', '/v1/provisions/:id/retry', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, ADMIN_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${ADMIN_SCOPE} or role:admin`)

      const provision = await reopenProvision(deps.sql, itemIdOf(ctx))
      if (!provision) throw new NotFoundError('no failed provision with that id')
      await deps.queue.enqueue({
        kind: PROVISION_KIND,
        key: provisionKey(provision.titleId),
        payload: { provisionId: provision.id },
        onConflict: 'replace',
      })
      return { status: 202, body: { provision } }
    }),

    define('GET', '/v1/provisions/:id', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const provision = await findProvision(deps.sql, itemIdOf(ctx))
      if (!provision) throw new NotFoundError('no such provision')
      // "Does not exist" and "is not yours" are the same answer on purpose.
      if (
        !isAdmin(principal) &&
        principal.kind === 'user' &&
        provision.subject !== `user:${principal.userId}`
      ) {
        throw new NotFoundError('no such provision')
      }
      return { status: 200, body: { provision } }
    }),

    /* ------------------------------------------------------------------ achievements and seasons */

    define('GET', '/v1/titles/:id/achievements', async (ctx, deps) => {
      const achievements = await listAchievements(deps.sql, itemIdOf(ctx))
      return {
        status: 200,
        body: {
          achievements: achievements.map((achievement) => ({
            ...achievement,
            rewardWei: achievement.rewardWei.toString(),
          })),
        },
      }
    }),

    define('PUT', '/v1/titles/:id/achievements', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      // A title service defines its own achievements. It cannot define another title's, because
      // the id is in the path and a title's credential names one title.
      if (principal.kind === 'service') requireScope(principal, TITLE_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${TITLE_SCOPE} or role:admin`)
      const body = await readJson(ctx.req)
      const achievement = await defineAchievement(deps.sql, {
        titleId: itemIdOf(ctx),
        key: requireString(body, 'key'),
        name: requireString(body, 'name'),
        description: typeof body['description'] === 'string' ? body['description'] : '',
        points: typeof body['points'] === 'number' ? body['points'] : 0,
        rewardWei: readWei(body['rewardWei'] ?? '0'),
      })
      return {
        status: 200,
        body: { achievement: { ...achievement, rewardWei: achievement.rewardWei.toString() } },
      }
    }),

    define('POST', '/v1/titles/:id/achievements/unlock', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TITLE_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${TITLE_SCOPE} or role:admin`)
      const body = await readJson(ctx.req)
      const result = await unlockAchievement(deps.sql, deps.producer, {
        userId: requireString(body, 'userId'),
        titleId: itemIdOf(ctx),
        key: requireString(body, 'key'),
        actor: actorOf(principal),
        correlationId: ctx.requestId,
      })
      // 201 on a fresh unlock, 200 on one that had already happened. A title re-evaluating its
      // achievements every tick can tell the difference without comparing bodies.
      return {
        status: result.unlocked ? 201 : 200,
        body: { unlocked: result.unlocked, achievement: { key: result.achievement.key } },
      }
    }),

    define('GET', '/v1/titles/:id/seasons', async (ctx, deps) => {
      const seasons = await listSeasons(deps.sql, itemIdOf(ctx))
      return { status: 200, body: { seasons: seasons.map(toSeasonWire) } }
    }),

    define('POST', '/v1/titles/:id/seasons', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      // Opening a season sets a MONEY budget, so it is an administrator's act and not a title's.
      // A title that could set its own reward budget could pay itself.
      if (principal.kind === 'service') requireScope(principal, ADMIN_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${ADMIN_SCOPE} or role:admin`)
      const body = await readJson(ctx.req)
      const season = await openSeason(deps.sql, {
        titleId: itemIdOf(ctx),
        slug: requireString(body, 'slug'),
        name: requireString(body, 'name'),
        startsAt: new Date(requireString(body, 'startsAt')),
        endsAt: new Date(requireString(body, 'endsAt')),
        rewardBudgetWei: readWei(body['rewardBudgetWei']),
        ...(typeof body['status'] === 'string' ? { status: body['status'] as 'active' } : {}),
        // The approval that authorises a RAISE, when this call raises the cap. Absent, and a raise
        // is refused by the database; present and already used, likewise. Lowering never needs it.
        ...(typeof body['budgetRaiseApprovalId'] === 'string'
          ? { budgetRaiseApprovalId: body['budgetRaiseApprovalId'] }
          : {}),
      })
      return { status: 201, body: { season: toSeasonWire(season) } }
    }),

    define('GET', '/v1/seasons/:id/budget', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, READ_SCOPE)
      const budget = await seasonBudget(deps.sql, itemIdOf(ctx))
      if (!budget) throw new NotFoundError('no such season')
      return {
        status: 200,
        body: {
          budgetWei: budget.budget.toString(),
          grantedWei: budget.granted.toString(),
          remainingWei: budget.remaining.toString(),
        },
      }
    }),

    /**
     * Pay a reward.
     *
     * **A title service asks; it does not decide.** The budget is charged and checked here, in the
     * same transaction as the ledger posting, so a title with a bug cannot spend past its season —
     * see `rewards.ts`. That is the whole reason this route exists instead of the title crediting
     * a player itself.
     */
    define('POST', '/v1/seasons/:id/rewards', async (ctx, deps) => {
      const principal = await authenticate(ctx, deps)
      if (principal.kind === 'service') requireScope(principal, TITLE_SCOPE)
      else if (!isAdmin(principal)) throw new ForbiddenError(`${TITLE_SCOPE} or role:admin`)
      const body = await readJson(ctx.req)

      const done = deps.lifecycle.track()
      try {
        const grant = await grantReward(deps.rewards, {
          seasonId: itemIdOf(ctx),
          userId: requireString(body, 'userId'),
          reason: requireString(body, 'reason'),
          amountWei: readWei(body['amountWei']),
          actor: actorOf(principal),
          correlationId: ctx.requestId,
        })
        deps.metrics.increment('worlds_rewards_granted_total', {
          outcome: grant.replayed ? 'replayed' : 'granted',
        })
        return {
          status: grant.replayed ? 200 : 201,
          body: {
            reward: {
              id: grant.id,
              userId: grant.userId,
              reason: grant.reason,
              amountWei: grant.amountWei.toString(),
              journalEntryId: grant.journalEntryId,
            },
            replayed: grant.replayed,
          },
        }
      } finally {
        done()
      }
    }),
  ]
}

/* ------------------------------------------------------------------ helpers */

function toItemWire(item: {
  id: string
  titleScope: string
  itemUrn: string
  source: string
  quantity: number
  bound: boolean
  entitlementId: string | null
  listedAt: Date | null
  listingUrn: string | null
  acquiredAt: Date
}): Record<string, unknown> {
  return {
    id: item.id,
    titleScope: item.titleScope,
    itemUrn: item.itemUrn,
    source: item.source,
    quantity: item.quantity,
    // On the wire because a client that offers a "sell" button must know before it draws one.
    bound: item.bound,
    entitlementId: item.entitlementId,
    listedAt: item.listedAt?.toISOString() ?? null,
    listingUrn: item.listingUrn,
    acquiredAt: item.acquiredAt.toISOString(),
  }
}

function toSeasonWire(season: {
  id: string
  titleId: string
  slug: string
  name: string
  startsAt: Date
  endsAt: Date
  status: string
  rewardBudgetWei: bigint
  rewardsGrantedWei: bigint
  budgetRaiseApprovalId: string | null
}): Record<string, unknown> {
  return {
    id: season.id,
    titleId: season.titleId,
    slug: season.slug,
    name: season.name,
    startsAt: season.startsAt.toISOString(),
    endsAt: season.endsAt.toISOString(),
    status: season.status,
    // Strings, always. A budget is money.
    rewardBudgetWei: season.rewardBudgetWei.toString(),
    rewardsGrantedWei: season.rewardsGrantedWei.toString(),
    // Named, not hidden. A spending limit that was raised should say what raised it; 21 §4's
    // premise is that the programme can be reconstructed by somebody who was not in the room.
    budgetRaiseApprovalId: season.budgetRaiseApprovalId,
  }
}

async function authenticate(ctx: RequestContext, deps: ServerDeps): Promise<Principal> {
  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token is a token fault, so it takes the same 401 path as a bad one rather than being
  // a separate branch that can drift away from it.
  if (!token) throw new TokenError('no bearer token presented', 'missing')
  return deps.verifier.principal(token)
}

function hasScope(principal: Principal, scope: string): boolean {
  return principal.kind === 'service' && principal.scopes.includes(scope)
}

function actorOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

/**
 * A path parameter that will be compared against a `uuid` column.
 *
 * Checked in the application rather than left to Postgres, because Postgres answers a malformed
 * uuid with error 22P02 — which reaches the error handler as an unrecognised fault and becomes a
 * 500. A caller typing a wrong id would then get "something went wrong on our side" for a request
 * that was simply about a thing that does not exist.
 */
function itemIdOf(ctx: RequestContext): string {
  const id = ctx.params['id'] ?? ''
  if (!UUID.test(id)) throw new NotFoundError('no such record')
  return id
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  return value.trim()
}

/**
 * A quantity of EMBER wei, as a decimal STRING.
 *
 * A number is refused rather than coerced, and the reason got sharper when the unit moved. A
 * budget and a reward are money, and the habit of sending amounts as JSON numbers is how an
 * amount loses its low bits somewhere else in the estate — but at 18 decimals every reward worth
 * paying is already past `Number.MAX_SAFE_INTEGER`, so a JSON number here would not merely risk
 * the low bits, it would routinely lose them.
 *
 * Wei and not a decimal EMBER string, on both directions of the wire: smallest units are the only
 * form that survives a round trip without a rounding rule, and this service is not the one that
 * knows EMBER's decimals — `chainSpec` lives in contracts-chain and the client that renders the
 * figure applies it.
 */
function readWei(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d{1,78}$/.test(value)) {
    throw new BadRequestError('an EMBER amount must be a decimal string of up to 78 digits of wei')
  }
  return BigInt(value)
}

/**
 * The MAC check lives in `outbox.ts`'s `verifyEventSignature`, which is the contract's verifier.
 *
 * This file used to hold its own: re-sign the body and compare the two header STRINGS in constant
 * time. Two things were wrong with it. It re-signed with `Date.now()`, so the `t=` it produced
 * differed from the `t=` the producer signed with the moment a delivery took longer than the
 * second it was minted in — an honest event refused, intermittently, as a forgery. And comparing
 * whole headers rather than the digests inside them meant the freshness window in the contract's
 * verifier was never consulted at all.
 *
 * The contract's verifier is still timing-safe — a byte-at-a-time comparison of a MAC is a
 * byte-at-a-time forgery oracle — and it additionally accepts a LIST of keys, which is what makes
 * rotating `OUTBOX_SIGNING_SECRET` possible without partitioning delivery.
 */

/** The raw bytes, for the signature check. Capped before buffering. */
async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    // An unbounded body is a memory exhaustion primitive that any UNAUTHENTICATED caller can
    // reach on this route, since the signature cannot be checked until the bytes are in hand.
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

/**
 * The error shape, identical on every failure and always carrying the request id.
 *
 * The id in the body rather than only in the header is what makes a support conversation work: a
 * user can read back what their browser showed them, and it joins to the log line and the trace.
 */
function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    ...(reply.headers ?? {}),
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
