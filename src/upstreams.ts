/**
 * The peers, and the credential this service presents to all of them.
 *
 * ── WHY THIS IS A MODULE AND NOT TWENTY LINES OF `index.ts` ────────────────────────────────────
 *
 * Because the defect it fixes was a WIRING defect, and wiring that lives in the composition root
 * is wiring no test can reach. `index.ts` opens a pool, asserts a schema and calls `listen()`;
 * importing it from a test starts a server. So the line that was wrong —
 *
 *     const token = () => env.serviceToken        // index.ts, for months
 *
 * — was structurally untestable, and a suite full of tests that build their own clients could not
 * have caught it however carefully they were written. A test that constructs its own provider
 * proves the provider works. Only a test that goes through THIS function proves the service uses
 * it. See `servicetoken.test.ts`.
 *
 * ── THE TEN-MINUTE CLIFF ───────────────────────────────────────────────────────────────────────
 *
 * A service token expires in 600 seconds (`SERVICE_TTL_SECONDS`, identity/src/tokens.ts). This
 * service read one once at boot, and nothing re-minted it — nothing could, because minting
 * required the `admin` role. Ten minutes into every deployment, the ledger and billing began
 * refusing every call, and no test here could see it because a test mints a token and uses it
 * within seconds.
 *
 * identity now mints for a service on demand. What this container holds at rest is a CREDENTIAL,
 * not a token: long-lived, revocable, worth nothing on its own, and exchangeable for an ordinary
 * ten-minute token whenever one is needed. The ten minutes is unchanged and must stay unchanged —
 * rotation IS expiry (SD-12).
 *
 * ── ONE PROVIDER FOR ALL THREE ─────────────────────────────────────────────────────────────────
 *
 * For the same reason there was one token: it is minted for `service:worlds` with the scopes
 * worlds needs and each peer checks the one it cares about. Three providers would be three
 * exchanges and three refresh schedules against one identity for one process.
 *
 * ── BOTH HOOKS, AND THE SECOND IS NOT DECORATION ───────────────────────────────────────────────
 *
 * `token` keeps the credential fresh on a schedule. `fetch` catches a 401 from a peer, re-mints
 * and replays once. Without the second, correctness would depend on this process and the peer
 * agreeing about what time it is — and titles are dialled at per-title URLs on machines this
 * estate does not own the clock of.
 */

import {
  ServiceTokenProvider,
  ServiceTokenUnavailableError,
  type ProviderEvent,
} from '@cloudsforge/auth'
import { httpBillingClient, type EntitlementReader } from './billingclient.ts'
import { httpLedgerClient, type LedgerClient } from './ledgerclient.ts'
import { httpTitleClient, type TitleClient } from './titleclient.ts'
// TYPE-ONLY, and that matters. `./env.ts` validates the process environment at import and calls
// `process.exit(1)` when it is incomplete, so a value import here would make this module — and
// therefore every test of the wiring in it — impossible to load without a full environment. That
// is the same "untestable therefore unchecked" property that let the cliff survive.
import type { Env } from './env.ts'

export interface Upstreams {
  /**
   * `null` when no credential is configured. Handed to `serviceTokenProbe`, which reports that as
   * a hard readiness failure — the image must be able to BOOT without one so CI can smoke-test
   * `/livez`, but a replica in that state must never take traffic.
   */
  readonly identityTokens: ServiceTokenProvider | null
  readonly ledger: LedgerClient
  readonly billing: EntitlementReader
  readonly titles: TitleClient
}

export interface UpstreamOptions {
  /** This service's name, for the ledger's `originating-service` header. `SERVICE` from `env.ts`. */
  readonly originatingService: string
  /** Test seam. Production uses the global `fetch`. */
  readonly fetch?: typeof globalThis.fetch | undefined
  readonly onEvent?: ((event: ProviderEvent) => void) | undefined
}

/** The subset of `Env` this needs. Named so a test does not have to build a whole environment. */
export type UpstreamEnv = Pick<
  Env,
  | 'identityUrl'
  | 'identityCredential'
  | 'ledgerUrl'
  | 'billingUrl'
  | 'upstreamDeadlineMs'
  | 'titleDeadlineMs'
>

export function buildUpstreams(env: UpstreamEnv, options: UpstreamOptions): Upstreams {
  const identityTokens = env.identityCredential
    ? new ServiceTokenProvider({
        identityUrl: env.identityUrl,
        credential: env.identityCredential,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      })
    : null

  /**
   * What every peer client asks for the `Authorization` header.
   *
   * Rejects rather than resolving `undefined` when there is no credential. `HttpClient` omits the
   * header entirely for `undefined`, so the request would go out unauthenticated and come back
   * 401 — telling an operator that the peer rejected worlds, when the truth is that nobody
   * configured worlds. `ServiceTokenUnavailableError` is 503 under `statusFor`, which is the same
   * answer the estate already gives when a verifier is unreachable and for the same reason.
   */
  const token = (): Promise<string> =>
    identityTokens
      ? identityTokens.token()
      : Promise.reject(new ServiceTokenUnavailableError('no identity credential is configured'))

  const peerFetch = identityTokens?.authorizedFetch ?? options.fetch
  const fetchOption = peerFetch ? { fetch: peerFetch } : {}

  return {
    identityTokens,
    ledger: httpLedgerClient({
      baseUrl: env.ledgerUrl,
      token,
      deadlineMs: env.upstreamDeadlineMs,
      originatingService: options.originatingService,
      ...fetchOption,
    }),
    billing: httpBillingClient({
      baseUrl: env.billingUrl,
      token,
      deadlineMs: env.upstreamDeadlineMs,
      ...fetchOption,
    }),
    // Titles have no single base URL: each one carries its own on its registry row, so the client
    // is constructed once and given the URL per call.
    titles: httpTitleClient({ token, deadlineMs: env.titleDeadlineMs, ...fetchOption }),
  }
}
