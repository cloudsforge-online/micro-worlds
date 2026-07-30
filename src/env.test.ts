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
  WORLDS_SERVICE_TOKEN: 'another-real-looking-secret-value-here',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

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
