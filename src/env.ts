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
import {
  SecretError,
  assertGeneratedSecret,
  assertServiceCredential,
  parseSecretList,
} from '@cloudsforge/secrets'

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

/**
 * THE `PLACEHOLDERS` SET THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It held nine exact strings and was paired with a 24-character floor, and the private
 * `parseSecretList` below applied both to every entry of the rotation list. Neither could fail for
 * the value that actually reached 44 containers on both networks: micro-org #142's
 * `estate-only-outbox-secret-00000000000000` is 40 characters and was on nobody's list. A check
 * that cannot fail is worse than no check, because the absence of an alarm gets read as the absence
 * of a problem — and on THIS service the key in question is what `POST /v1/events` verifies an
 * inbound entitlement grant with, so a placeholder is a free-worlds endpoint.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody
 * writes is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of a generated
 * value instead, which is the property a placeholder cannot have. It is imported rather than
 * copied so that this service cannot drift from the other sixteen — this repository's own copy of
 * `parseSecretList` was one of ELEVEN, four of which took the `minLength = 24` parameter that is
 * the keystroke floor the shared package exists to replace.
 */

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * Re-wrap the shared guard's `SecretError` as this service's `EnvError`.
 *
 * `loadEnv` documents a single error class for every configuration failure, and the boot path
 * catches that one class. The message is preserved verbatim — it already names the variable and
 * the command that fixes it, and it never contains the value.
 */
function asEnvError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
}

/**
 * The estate's shared event-bus HMAC key — and on THIS service the thing standing between "billing
 * said this customer bought a private world" and "anyone who can reach this port said so".
 *
 * `assertGeneratedSecret` asserts what a placeholder cannot have: the base64 or hex alphabet (no
 * hyphens — every placeholder this estate wrote had one), 32 decoded BYTES rather than 24
 * keystrokes, and a measured Shannon entropy floor. The old `minLength` parameter is gone rather
 * than kept in front: it is a strict subset of the shape check, and running it first answers a
 * 40-character placeholder with "must be at least 24 characters" — true, useless, and about the
 * wrong property.
 */
function requiredSigningSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertGeneratedSecret(name, value))
  return value
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * Absent is a deployment that has not been granted a credential yet; it returns `null`, `/readyz`
 * reports the `identity-credential` probe as a HARD failure, and the replica never takes traffic.
 * The empty check therefore stays AHEAD of the assertion, because compose interpolates
 * `${WORLDS_IDENTITY_CREDENTIAL:-}` and an unset credential arrives as the EMPTY STRING — that is
 * the supported mode, not a malformed one, and it is the mode CI's `/livez` smoke test boots the
 * image in. Turning it into `exit(1)` would fail that job rather than this service.
 *
 * What is not supported is a value that is present and rubbish: a short placeholder is a deployment
 * that believes it HAS a credential, and would fail on its first call to a peer with a 401 that
 * reads as "identity rejected this service" rather than "nobody set this variable".
 *
 * ── WHY NOT `assertGeneratedSecret` ────────────────────────────────────────────────────────────
 *
 * Because it would refuse every credential this estate has ever minted, and worlds would exit 1 at
 * boot on BOTH networks. A credential is `cfsc_` + base64url, which is neither wholly base64 nor
 * wholly hex — the underscore in its own prefix disqualifies it. Measured live: the testnet
 * credential also CONTAINS A HYPHEN while the mainnet one does not, so the "no hyphens" instinct
 * that is correct for the signing key above would have booted mainnet and killed testnet.
 */
function optionalCredential(source: Source, name: string): string | null {
  const value = source[name]?.trim()
  if (!value) return null
  asEnvError(() => assertServiceCredential(name, value))
  return value
}

/**
 * The rotation list, split and checked — `@cloudsforge/secrets`' `parseSecretList`, imported.
 *
 * A LIST, not a value, because rotation without an overlap window means every producer must change
 * secret in the same instant this service does, and that instant does not exist during a rolling
 * deploy. The receiver publishes the new key, accepts both for a window, then drops the old one.
 *
 * EVERY ENTRY FACES THE FULL RULE, INCLUDING THE OUTGOING ONE. In a rotation overlap window the
 * outgoing key is the one an attacker already holds if it leaked, and "just for the drain" is
 * exactly how a placeholder survives the rotation that was meant to remove it.
 *
 * NOTE THE ARGUMENT ORDER. The private copy this replaces took `(raw, name, minLength)`; the shared
 * one takes `(name, raw)`. The wrapper exists to make that flip explicit at the one call site,
 * because a silent swap of two `string` parameters is a change the type checker cannot catch — it
 * would put the raw list where the variable name belongs and report the SECRET in the error message.
 */
function acceptSecretList(name: string, raw: string): readonly string[] {
  return asEnvError(() => parseSecretList(name, raw))
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
   * (identity/src/tokens.ts). Ten minutes into any deployment it expired and every call to a
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
   *
   * **THIS IS WHY micro-org #222 IS ALREADY CLOSED FOR THIS SERVICE.** The variable holds an
   * expired JWT wherever a deployment still sets one — market's and foresight's copies of it were
   * measured expired by 26 hours on healthy containers — and it cannot break a boot it is not
   * consulted by. Nothing here asserts it, because nothing here trusts it: presence is REPORTED,
   * confers nothing, and requires nothing. The estate's compose stopped passing it, and the CI
   * smoke environment stopped supplying it, for the same reason.
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
  const signingSecret = requiredSigningSecret(source, 'OUTBOX_SIGNING_SECRET')
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
      ? acceptSecretList('OUTBOX_ACCEPT_SECRETS', acceptSecrets)
      : Object.freeze([signingSecret]),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    ledgerUrl: required(source, 'LEDGER_URL'),
    billingUrl: required(source, 'BILLING_URL'),
    identityUrl: optional(source, 'IDENTITY_URL', required(source, 'IDENTITY_ISSUER')),
    // Optional by design: see the field comment. The absence is caught by `/readyz`, which is
    // a check that can fail, rather than by a boot CI cannot perform.
    identityCredential: optionalCredential(source, 'WORLDS_IDENTITY_CREDENTIAL'),
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
