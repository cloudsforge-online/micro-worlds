/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else, so the deploy manifest can be derived from it and `env_file: .env` fan-out (which
 * hands every container the whole estate's secrets) has nothing to justify it.
 *
 * Two behaviours are copied deliberately from custody:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 *
 * ## `WORLDS_SEASON_REWARD_BUDGET_SHARDS` is a money control, not a tuning knob
 *
 * Rewards are ledger postings. A game exploit that mints rewards is therefore a MONEY INCIDENT and
 * not a balance complaint, and the only thing standing between "a bug pays out" and "a bug pays
 * out for ever" is a cap that is checked in the same transaction as the posting. The service this
 * supersedes has no cap of any kind: `work.tokens += locked.rewardTokens` is unbounded, there is
 * no daily, seasonal or global issuance budget and no counter anywhere. Its currency happens to be
 * worthless, which is the only reason that has not cost anything.
 */

import { hostname } from 'node:os'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'worlds'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

const PLACEHOLDERS = new Set([
  'changeme',
  'change-me',
  'placeholder',
  'secret',
  'token',
  'dev-secret',
  'dev-outbox-signing-secret',
  'replace-with-a-real-secret',
  'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
])

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

function requiredSecret(source: Source, name: string, minLength = 24): string {
  const value = required(source, name)
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  // Length is a proxy for entropy and the only one available here. It is set above the point at
  // which a human-chosen string is plausible, so a memorable password fails this check too.
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

/**
 * A secret that may be absent, but must be real if present.
 *
 * The distinction matters for the identity credential: absent is a deployment that has not been
 * given one yet and is reported by `/readyz`; a short placeholder is a deployment that believes it
 * HAS one, and would fail on its first call to a peer with a 401 that reads as "identity rejected
 * this service" rather than "nobody set this variable".
 */
function optionalSecret(source: Source, name: string, minLength = 24): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  if (PLACEHOLDERS.has(value.toLowerCase())) {
    throw new EnvError(`${name} is set to a known placeholder — generate a real secret`)
  }
  if (value.length < minLength) {
    throw new EnvError(`${name} must be at least ${minLength} characters (got ${value.length})`)
  }
  return value
}

/**
 * A comma-separated list of secrets, newest first.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant this service does, and that instant does not exist during a rolling
 * deploy. The receiver publishes the new key, accepts both for a window, then drops the old one.
 *
 * Every entry is held to exactly the bar a single secret is held to — a rotation is not an excuse
 * to smuggle a placeholder in beside a real key. The house pattern; `devplatform/src/env.ts:103`
 * is the reference implementation and `activity` and `notify` carry the same shape.
 */
function parseSecretList(raw: string, name: string, minLength = 24): readonly string[] {
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  if (entries.length === 0) throw new EnvError(`${name} is required — at least one secret`)
  for (const entry of entries) {
    if (PLACEHOLDERS.has(entry.toLowerCase())) {
      throw new EnvError(`${name} contains a known placeholder — generate real secrets`)
    }
    if (entry.length < minLength) {
      throw new EnvError(`${name} entries must each be at least ${minLength} characters`)
    }
  }
  if (new Set(entries).size !== entries.length) {
    // A duplicated secret makes the "which key verified this" answer ambiguous, and that answer is
    // what tells an operator whether a rotation has finished and the old key may be dropped.
    throw new EnvError(`${name} lists the same secret twice`)
  }
  return Object.freeze(entries)
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

/**
 * A Shard quantity as a decimal string, never a number.
 *
 * A budget is money. Reading it through `Number()` would make a large one approximate, and an
 * approximate cap is a cap that is either slightly too generous or refuses a legitimate grant —
 * both of which are discovered by a customer rather than by a test.
 */
function shards(source: Source, name: string, fallback: bigint): bigint {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw)) throw new EnvError(`${name} must be a whole number of shards (got ${raw})`)
  return BigInt(raw)
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  /**
   * HMAC key for outbound event signatures. **Signing is one key, and stays one key.**
   *
   * Signing with two at once would double every subscriber's verification work and leave nobody
   * able to say which key an event was signed with. Verification is the side that needs a list —
   * see `outboxAcceptSecrets`.
   */
  readonly outboxSigningSecret: string
  /**
   * Every key `POST /v1/events` will accept an inbound signature from, newest first.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **ROTATION IS A WINDOW, NOT A SWAP.** `OUTBOX_SIGNING_SECRET` is one key shared by 24
   * services. If this bridge accepted only the current value, then the moment billing moved to a
   * new one — or the moment this service did, and billing had not yet — every grant event would
   * 401 and **no world would be provisioned** for the length of the rolling deploy. The failure
   * does not announce itself: delivery PARTITIONS, and the symptom reads as a secret mismatch
   * rather than as a deploy ordering problem. Accepting a list makes the ordering irrelevant.
   *
   * The entitlement bridge is an inbound webhook, so these keys are what stand between "billing
   * said this customer bought a private world" and "anyone who can reach this port said so". A
   * provisioning bridge with no signature check is a free-worlds endpoint, which is why every
   * entry is held to the same length and placeholder bar the single secret was.
   *
   * **`OUTBOX_ACCEPT_SECRETS` is OPTIONAL, and its absence means `[OUTBOX_SIGNING_SECRET]`** —
   * exactly what every deployment does today. That is what makes shipping this change a no-op and
   * therefore what lets the rotation be staged rather than flipped.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly outboxAcceptSecrets: readonly string[]
  readonly instanceId: string

  readonly ledgerUrl: string
  readonly billingUrl: string

  /**
   * Where identity is, for `POST /service-tokens/exchange`.
   *
   * Defaults to `IDENTITY_ISSUER`, which is already required and is identity's own base URL — the
   * issuer of a token is by definition where the token came from. `IDENTITY_URL` overrides it for a
   * deployment where the two genuinely differ. Deriving rather than demanding a fourth identity
   * variable keeps them in step: pointing the exchange at one identity and trusting the JWKS of
   * another fails with a signature error nobody reads as a configuration mistake.
   */
  readonly identityUrl: string

  /**
   * **The long-lived credential this service exchanges for short-lived tokens.**
   *
   * It replaces `WORLDS_SERVICE_TOKEN`, which was a 600-second token read once at boot
   * (identity/src/tokens.ts:33). Ten minutes into any deployment it expired and every call to a
   * peer failed; nothing could re-mint it, because minting requires the `admin` role. A credential
   * is not a token: it confers nothing by itself, it is revocable, and it survives a restart. See
   * `micro-identity` `src/serviceCredentials.ts` and `@cloudsforge/auth` `ServiceTokenProvider`.
   *
   * OPTIONAL, AND DELIBERATELY SO — but not "unconfigured is fine". It is optional because the
   * image must be able to BOOT without one: CI's startup smoke test builds the container, migrates
   * it and reads `/livez`, and that job's environment is fixed in a workflow file. Making this
   * required would fail that job rather than this service.
   *
   * The absence is not silent. `/readyz` reports the `identity-credential` probe as a HARD failure,
   * so an unconfigured replica never takes traffic, and every upstream call fails closed with 503
   * rather than being sent unauthenticated.
   */
  readonly identityCredential: string | null

  /**
   * Whether the retired `WORLDS_SERVICE_TOKEN` is still set.
   *
   * Read for exactly one purpose: to say so at boot. An operator who redeploys with the old
   * variable and not the new one would otherwise get a service that looks configured and is not.
   */
  readonly legacyServiceTokenPresent: boolean
  readonly upstreamDeadlineMs: number
  /** Title services are per-title URLs held on the `titles` row, so only the deadline is global. */
  readonly titleDeadlineMs: number

  /** Provisioning can be paused without pausing the service, so nothing is lost while it is off. */
  readonly provisioningEnabled: boolean

  /**
   * The default reward budget a new season is opened with, in Shards.
   *
   * A season may be given its own on creation; this is what one gets when nobody says. It is
   * deliberately small — a budget nobody chose should bind long before it costs anything.
   */
  readonly seasonRewardBudgetShards: bigint
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }
  const signingSecret = requiredSecret(source, 'OUTBOX_SIGNING_SECRET')
  // Absent means "accept exactly the key we sign with", which is what every deployment does today.
  // The default is what makes this change a no-op to ship and therefore what lets the rotation be
  // staged: add the new key here first, restart, move the producers, then drop the old one.
  const acceptSecrets = source['OUTBOX_ACCEPT_SECRETS']?.trim()
  const budget = shards(source, 'WORLDS_SEASON_REWARD_BUDGET_SHARDS', 100_000n)
  if (budget <= 0n) {
    // Zero would be a season that can pay nothing, which is a configuration mistake presenting as
    // "every reward is refused". Refused here, where the variable is named.
    throw new EnvError('WORLDS_SEASON_REWARD_BUDGET_SHARDS must be positive')
  }

  return {
    port: integer(source, 'PORT', 4000, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'WORLDS_DATABASE_URL'),
    databasePoolMax: integer(source, 'WORLDS_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    outboxSigningSecret: signingSecret,
    outboxAcceptSecrets: acceptSecrets
      ? parseSecretList(acceptSecrets, 'OUTBOX_ACCEPT_SECRETS')
      : Object.freeze([signingSecret]),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Not `requiredSecret`: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalSecret(source, 'WORLDS_IDENTITY_CREDENTIAL'),
    legacyServiceTokenPresent: (source['WORLDS_SERVICE_TOKEN']?.trim() ?? '').length > 0,
    upstreamDeadlineMs: integer(source, 'WORLDS_UPSTREAM_DEADLINE_MS', 5_000, 100, 60_000),
    // Longer than the estate's other upstream deadlines, deliberately: provisioning a world writes
    // up to four thousand tile rows in the title service, and a deadline shorter than that work
    // turns every provision into a retry of something that succeeded.
    titleDeadlineMs: integer(source, 'WORLDS_TITLE_DEADLINE_MS', 20_000, 100, 120_000),

    provisioningEnabled: boolean(source, 'WORLDS_PROVISIONING_ENABLED', true),
    seasonRewardBudgetShards: budget,
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
