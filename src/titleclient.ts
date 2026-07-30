/**
 * A title service, as this service uses it.
 *
 * ## The contract is deliberately tiny, because every method here is a method a second title has
 * to implement before it can be sold to
 *
 * Four calls. `conformance.ts` is the executable statement of them, and a title that passes it can
 * be registered and sold to without this service changing — which is what "a second game is
 * possible" has to mean if it is to be a test rather than a claim.
 *
 * ## Provisioning is idempotent ON THE ENTITLEMENT ID, and the title must honour that
 *
 * The bridge is at-least-once by construction: the event may be redelivered, the job may be
 * retried, and two replicas may both hold a claim in the instant after one crashes. The entitlement
 * id is the one value that is stable across every one of those, so it is the idempotency key — sent
 * as `Idempotency-Key` and repeated in the body. A title that ignores it raises a second world for
 * one purchase, which is the mirror image of the defect this whole bridge exists to fix.
 *
 * ## `unsupported` is an ANSWER, not a fault
 *
 * A title asked for something it does not sell answers 422, and the bridge records `unsupported`
 * and stops. Retrying is guaranteed to fail again, and burning an attempt budget on it hides the
 * one case an operator actually needs to see: a customer paid for something the title cannot
 * deliver, which is a catalogue mistake and a refund.
 */

import { HttpClient, HttpError } from '@cloudsforge/http'

/** The title refused on its own terms. Permanent for this request. */
export class TitleRefusedError extends Error {
  readonly code: string
  readonly status: number
  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'TitleRefusedError'
    this.code = code
    this.status = status
  }
}

/** The title asked for something it does not sell. An answer, and terminal. */
export class TitleUnsupportedError extends TitleRefusedError {
  constructor(message: string) {
    super(422, 'unsupported', message)
    this.name = 'TitleUnsupportedError'
  }
}

/** The title could not be reached, or answered 5xx. We do not know whether it provisioned. */
export class TitleUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TitleUnavailableError'
  }
}

export interface ProvisionRequest {
  /** The idempotency key of the whole bridge. See the file header. */
  readonly entitlementId: string
  readonly subject: string
  readonly userId: string
  readonly sku: string
  readonly scope: string
  /** Whatever billing carried on the grant — a world name, a season length, a player cap. */
  readonly metadata: Readonly<Record<string, unknown>>
  readonly correlationId: string
}

export interface ProvisionResult {
  /** `cf:<title>:<type>:<id>`. What was created, in a form anything in the estate can point at. */
  readonly urn: string
  /** True when the title recognised the key and returned what it had already made. */
  readonly replayed: boolean
}

export interface TitleDescriptor {
  readonly slug: string
  readonly name: string
  readonly capabilities: readonly string[]
}

export interface TitleClient {
  /** What this title says it is. Used by the conformance suite and by registration. */
  describe(baseUrl: string): Promise<TitleDescriptor>
  provision(baseUrl: string, request: ProvisionRequest): Promise<ProvisionResult>
}

export interface TitleClientOptions {
  readonly token: () => Promise<string | undefined> | string | undefined
  readonly deadlineMs: number
  readonly fetch?: typeof globalThis.fetch
}

export function httpTitleClient(options: TitleClientOptions): TitleClient {
  // One client per title base URL, cached for the life of the process so a circuit breaker
  // accumulates state across ticks. A fresh client per call has a permanently closed circuit and
  // hammers a title that is already having a bad time.
  const clients = new Map<string, HttpClient>()
  const clientFor = (baseUrl: string): HttpClient => {
    const existing = clients.get(baseUrl)
    if (existing) return existing
    const client = new HttpClient({
      baseUrl: new URL(baseUrl).origin,
      name: `title:${new URL(baseUrl).host}`,
      defaultDeadlineMs: options.deadlineMs,
      token: options.token,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    })
    clients.set(baseUrl, client)
    return client
  }

  const pathOf = (baseUrl: string, suffix: string): string => {
    const url = new URL(baseUrl)
    const base = url.pathname.replace(/\/$/, '')
    return `${base}${suffix}`
  }

  return {
    async describe(baseUrl) {
      try {
        const body = await clientFor(baseUrl).get<TitleDescriptor>(pathOf(baseUrl, '/v1/title'))
        if (typeof body.slug !== 'string' || !Array.isArray(body.capabilities)) {
          throw new TitleUnavailableError('a title descriptor must carry a slug and capabilities')
        }
        return body
      } catch (err) {
        throw translate(err)
      }
    },

    async provision(baseUrl, request) {
      try {
        const body = await clientFor(baseUrl).request<{ urn?: unknown; replayed?: unknown }>(
          pathOf(baseUrl, '/v1/provision'),
          {
            method: 'POST',
            body: {
              entitlementId: request.entitlementId,
              subject: request.subject,
              userId: request.userId,
              sku: request.sku,
              scope: request.scope,
              metadata: request.metadata,
            },
            // Both places. In the header it is what makes the POST retriable at all —
            // `HttpClient` attempts a non-idempotent method exactly once without one — and in the
            // body it is what the title stores and dedupes on.
            idempotencyKey: request.entitlementId,
            requestId: request.correlationId,
          },
        )
        if (typeof body.urn !== 'string' || body.urn.length === 0) {
          // A 2xx with no urn is a title claiming success it cannot name. Treated as an outage
          // rather than a success, because recording `provisioned` with no urn would break the
          // `provisions_provisioned_is_complete` constraint anyway — and would deserve to.
          throw new TitleUnavailableError('the title answered 2xx with no urn')
        }
        return { urn: body.urn, replayed: body.replayed === true }
      } catch (err) {
        throw translate(err)
      }
    },
  }
}

/**
 * Turn an HTTP failure into one of the three things a caller can act on.
 *
 * `HttpError.peerDecided` is the discriminator: a 4xx means the title looked at the request and
 * said no, which is a permanent fact about it. Anything else — 5xx, a timeout, an open circuit —
 * means we do not know whether it provisioned, and the only safe response is to leave the row where
 * it is and retry with the same entitlement id.
 *
 * That distinction is what keeps a title having a bad minute from turning into a refund queue.
 */
function translate(err: unknown): Error {
  if (err instanceof TitleUnavailableError || err instanceof TitleRefusedError) return err
  if (err instanceof HttpError && err.peerDecided) {
    const parsed = parseError(err.body)
    if (err.status === 422 || parsed.code === 'unsupported') {
      return new TitleUnsupportedError(parsed.message)
    }
    return new TitleRefusedError(err.status, parsed.code, parsed.message)
  }
  return new TitleUnavailableError(err instanceof Error ? err.message : String(err))
}

function parseError(body: string): { code: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(body)
    const error = (parsed as { error?: { code?: unknown; message?: unknown } }).error
    return {
      code: typeof error?.code === 'string' ? error.code : 'title_error',
      message: typeof error?.message === 'string' ? error.message : body.slice(0, 500),
    }
  } catch {
    return { code: 'title_error', message: body.slice(0, 500) }
  }
}
