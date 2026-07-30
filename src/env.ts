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
   * HMAC key for outbound event signatures — and for VERIFYING the inbound ones.
   *
   * The entitlement bridge is an inbound webhook, so this key is what stands between "billing said
   * this customer bought a private world" and "anyone who can reach this port said so". A
   * provisioning bridge with no signature check is a free-worlds endpoint.
   */
  readonly outboxSigningSecret: string
  readonly instanceId: string

  readonly ledgerUrl: string
  readonly billingUrl: string
  /** The scoped service credential. Not shared: SD-05. */
  readonly serviceToken: string
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
    outboxSigningSecret: requiredSecret(source, 'OUTBOX_SIGNING_SECRET'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    serviceToken: requiredSecret(source, 'WORLDS_SERVICE_TOKEN'),
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
