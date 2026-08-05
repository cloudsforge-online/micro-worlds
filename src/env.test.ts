/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 */
const BASE: Record<string, string> = {
  WORLDS_DATABASE_URL: 'postgres://worlds:worlds@127.0.0.1:5432/worlds',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  OUTBOX_SIGNING_SECRET: 'a-real-looking-secret-of-sufficient-length',
  LEDGER_URL: 'http://127.0.0.1:4007',
  BILLING_URL: 'http://127.0.0.1:4009',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/**
 * The credential is NOT in `BASE`, because it is not required — see the field comment in `env.ts`.
 * `WORLDS_SERVICE_TOKEN` is not there either: it was removed, and the tests below assert that its absence is
 * fine and its presence is reported rather than silently obeyed.
 */
const CREDENTIAL = 'cfsc_a-long-lived-credential-that-does-not-expire'

const { EnvError, SERVICE, env, loadEnv } = await import('./env.ts')

test('a complete environment loads, and importing the module did not exit', () => {
  assert.equal(env.databaseUrl, BASE['WORLDS_DATABASE_URL'])
  assert.equal(SERVICE, 'worlds')
})

test('a missing variable names itself', () => {
  const { BILLING_URL: _omitted, ...rest } = BASE
  assert.throws(() => loadEnv(rest, 'host'), (err: unknown) => {
    assert.ok(err instanceof EnvError)
    assert.match(err.message, /BILLING_URL/)
    return true
  })
})

test('the event signing secret is required and a placeholder is refused', () => {
  // This key is what stands between "billing said this customer bought a private world" and
  // "anyone who can reach this port said so". A placeholder here is a free-worlds endpoint.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'changeme' }, 'host'), /placeholder/)
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'short' }, 'host'), /at least 24/)
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * OUTBOX_ACCEPT_SECRETS — the rotation window.
 *
 * `OUTBOX_SIGNING_SECRET` is one shared key across the estate, so replacing it is not a swap: a
 * producer that moves first would have every delivery refused here, and no world would be
 * provisioned until the last consumer caught up. The receiver therefore accepts a LIST, and the
 * rotation becomes: publish the new key here, restart, then move the producers, then drop the old.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** Obviously fake, and long enough to clear the length rule. Never a real key. */
const NEXT_KEY = 'rotation-fixture-next-key-not-a-real-secret'
const PRIOR_KEY = 'rotation-fixture-prior-key-not-a-real-secret'

test('with OUTBOX_ACCEPT_SECRETS unset, the accepted list is exactly the signing secret', () => {
  // The backwards compatibility that makes deploying this change a no-op, and therefore makes the
  // rotation stageable: an estate that has never heard of the new variable behaves as it does today.
  assert.deepEqual(
    [...loadEnv(BASE, 'host').outboxAcceptSecrets],
    [BASE['OUTBOX_SIGNING_SECRET']],
  )
})

test('OUTBOX_ACCEPT_SECRETS is a comma-separated list, newest first, and signing stays single', () => {
  const env = loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ` ${NEXT_KEY} , ${PRIOR_KEY} ` }, 'host')
  assert.deepEqual([...env.outboxAcceptSecrets], [NEXT_KEY, PRIOR_KEY])
  // Signing is NOT a list. Two outbound signatures would double every subscriber's verification
  // work and leave nobody able to say which key an event was signed with.
  assert.equal(env.outboxSigningSecret, BASE['OUTBOX_SIGNING_SECRET'])
})

test('every OUTBOX_ACCEPT_SECRETS entry is held to the same bar as the signing secret', () => {
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},changeme` }, 'host'),
    /placeholder/,
  )
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},short` }, 'host'),
    /at least 24/,
  )
  // A list of separators is an empty list, which would accept nothing and 401 the whole estate.
  assert.throws(() => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: ' , , ' }, 'host'), /at least one/)
})

test('OUTBOX_ACCEPT_SECRETS listing the same secret twice is refused', () => {
  // A duplicate makes "which key verified this" ambiguous, and that answer is how an operator
  // knows the rotation has finished and the old key can be dropped.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},${NEXT_KEY}` }, 'host'),
    /twice/,
  )
})

test('the season reward budget is read as a bigint, never through Number', () => {
  const env = loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_SHARDS: '9007199254740993' }, 'host')
  assert.equal(env.seasonRewardBudgetShards, 9_007_199_254_740_993n)
})

test('a zero reward budget is refused: a season that can pay nothing is a mistake', () => {
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_SHARDS: '0' }, 'host'),
    /positive/,
  )
})

test('a non-numeric budget is refused rather than defaulted', () => {
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_SHARDS: 'lots' }, 'host'),
    /whole number of shards/,
  )
})

test('the title deadline is longer than the other upstreams by default', () => {
  // Provisioning a world writes thousands of rows in the title service. A deadline shorter than
  // that work turns every provision into a retry of something that succeeded.
  const env = loadEnv(BASE, 'host')
  assert.ok(env.titleDeadlineMs > env.upstreamDeadlineMs)
})

test('provisioning can be turned off without turning the service off', () => {
  assert.equal(loadEnv({ ...BASE, WORLDS_PROVISIONING_ENABLED: 'false' }, 'host').provisioningEnabled, false)
  assert.throws(() => loadEnv({ ...BASE, WORLDS_PROVISIONING_ENABLED: 'maybe' }, 'host'), /true or false/)
})

test('INSTANCE_ID falls back to the hostname, which is what names a stuck lease', () => {
  assert.equal(loadEnv(BASE, 'pod-7').instanceId, 'pod-7')
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * The credential that replaced WORLDS_SERVICE_TOKEN. See `env.ts` and `@cloudsforge/auth`.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

test('the identity credential is read, and its absence is a null rather than a throw', () => {
  assert.equal(loadEnv({ ...BASE, WORLDS_IDENTITY_CREDENTIAL: CREDENTIAL }).identityCredential, CREDENTIAL)
  // Absent must LOAD — the image has to boot without one so the CI smoke test can read /livez —
  // and is caught by the hard `identity-credential` readiness probe instead.
  assert.equal(loadEnv(BASE).identityCredential, null)
})

test('a credential that is present but too short is refused, not accepted as configured', () => {
  // Absent is a deployment nobody has given a credential to. A short one is a deployment that
  // BELIEVES it has one, and would fail on its first call to a peer with a 401 that reads as
  // "identity rejected this service" rather than "nobody set this variable".
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_IDENTITY_CREDENTIAL: 'cfsc_short' }),
    (err: unknown) => err instanceof EnvError && err.message.includes('WORLDS_IDENTITY_CREDENTIAL'),
  )
})

test('identityUrl derives from the issuer, and IDENTITY_URL overrides it', () => {
  // The issuer of a token is by definition where the token came from, so demanding a fourth
  // identity variable would only create a way for the exchange and the JWKS to disagree.
  assert.equal(loadEnv(BASE).identityUrl, BASE['IDENTITY_ISSUER'])
  assert.equal(
    loadEnv({ ...BASE, IDENTITY_URL: 'http://identity.internal:4000' }).identityUrl,
    'http://identity.internal:4000',
  )
})

test('WORLDS_SERVICE_TOKEN is no longer required, and being set is reported rather than obeyed', () => {
  // The retired variable. It was a 600-second token read once at boot; ten minutes into every
  // deployment every call to a peer failed and nothing could re-mint it.
  assert.equal(loadEnv(BASE).legacyServiceTokenPresent, false)
  const withLegacy = loadEnv({ ...BASE, WORLDS_SERVICE_TOKEN: 'a-real-looking-secret-of-sufficient-length' })
  assert.equal(withLegacy.legacyServiceTokenPresent, true)
  // And it confers nothing: setting it must not make the service look configured.
  assert.equal(withLegacy.identityCredential, null)
})
