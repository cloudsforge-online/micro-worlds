/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
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
  // GENERATED, not written. The literal that used to sit here was
  // `a-real-looking-secret-of-sufficient-length` — 42 characters, therefore past the old
  // 24-character floor, and a hyphenated placeholder of exactly the family that reached 44
  // containers as micro-org #142. It also normalises to a string containing `sufficientlength`,
  // which is on `@cloudsforge/secrets`' marker list BECAUSE OF THIS FIXTURE. Every test in this
  // file was built on it, so the whole suite was asserting that a placeholder is an acceptable
  // verification key for the inbound entitlement webhook that provisions private worlds.
  OUTBOX_SIGNING_SECRET: randomBytes(48).toString('base64'),
  LEDGER_URL: 'http://127.0.0.1:4007',
  BILLING_URL: 'http://127.0.0.1:4009',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

/**
 * The credential is NOT in `BASE`, because it is not required — see the field comment in `env.ts`.
 * `WORLDS_SERVICE_TOKEN` is not there either: it was removed, and the tests below assert that its absence is
 * fine and its presence is reported rather than silently obeyed.
 */
/**
 * THIS FIXTURE CONTAINS HYPHENS ON PURPOSE, AND THAT IS THE MOST IMPORTANT THING ABOUT IT.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates: the mainnet credential is alphanumeric and the testnet one CONTAINS A HYPHEN. So a
 * "secrets have no hyphens" rule — correct for `OUTBOX_SIGNING_SECRET` above, and what every
 * placeholder this estate wrote would have failed — passes mainnet and kills testnet at boot. One
 * environment healthy, one dead, from a rule that reads as obviously right in review.
 *
 * Keeping a hyphenated credential here means that mistake fails CI instead of failing one estate in
 * production. Do not "tidy" the hyphens out of this value.
 *
 * The literal it replaces was `cfsc_a-long-lived-credential-that-does-not-expire`: the right prefix
 * and the right length, and 3.5 bits per character of entropy — English prose, i.e. a value the
 * guard is specifically there to refuse.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

/**
 * The shape `WORLDS_SERVICE_TOKEN` held before it was retired: a 600-second JWT read once at boot.
 * Fabricated; only the first two segments matter, because the guard refuses on SHAPE and never
 * decodes. micro-org #222.
 */
const JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ3b3JsZHMiLCJleHAiOjF9.notasignature'

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
  // THE ONE THAT ACTUALLY SHIPPED, and which no deny-list contained. micro-org #142's
  // `estate-only-outbox-secret-00000000000000` is 40 characters, so it cleared the 24-character
  // floor this file used to assert, and it reached 44 containers on both networks with every guard
  // in the estate passing it.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'estate-only-outbox-secret-00000000000000' }, 'host'),
    (err: unknown) => err instanceof EnvError && /placeholder/.test(err.message),
  )
  // The second assertion here used to read `/at least 24/` against `'short'`. That wording pinned
  // the KEYSTROKE floor the 40-character placeholder above sailed through, so any fix that started
  // counting bytes would have failed CI however much better it was. `hunter2` is spelled in the
  // base64 alphabet, so it is not the alphabet that catches it — it decodes to 5 BYTES.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_SIGNING_SECRET: 'hunter2' }, 'host'),
    (err: unknown) =>
      err instanceof EnvError &&
      /5 bytes of key material/.test(err.message) &&
      /at least 32/.test(err.message) &&
      !err.message.includes('hunter2'),
  )
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * OUTBOX_ACCEPT_SECRETS — the rotation window.
 *
 * `OUTBOX_SIGNING_SECRET` is one shared key across the estate, so replacing it is not a swap: a
 * producer that moves first would have every delivery refused here, and no world would be
 * provisioned until the last consumer caught up. The receiver therefore accepts a LIST, and the
 * rotation becomes: publish the new key here, restart, then move the producers, then drop the old.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/**
 * "The new one" and "the one being rotated out" for the acceptance-list cases below.
 *
 * These were `rotation-fixture-next-key-not-a-real-secret` and its `prior` twin, under a comment
 * that said they were "long enough to clear the length rule". That is the defect stated out loud:
 * both are hyphenated placeholders of exactly the family that reached 44 containers as micro-org
 * #142, both normalise to a string containing `notareal`, and this suite asserted they were VALID
 * secrets on the route that provisions a paid world.
 *
 * Generated rather than replaced with better-looking literals, so a placeholder cannot creep back
 * in the next time somebody needs a fixture.
 */
const NEXT_KEY = randomBytes(48).toString('base64')
const PRIOR_KEY = randomBytes(48).toString('base64')

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
  // Was `/at least 24/` — the keystroke floor again. The INDEX matters and is asserted: an
  // operator with the file open counts commas, and the message must name which entry failed while
  // never carrying the entry itself.
  assert.throws(
    () => loadEnv({ ...BASE, OUTBOX_ACCEPT_SECRETS: `${NEXT_KEY},hunter2` }, 'host'),
    (err: unknown) =>
      err instanceof EnvError &&
      /OUTBOX_ACCEPT_SECRETS\[1\]/.test(err.message) &&
      /at least 32/.test(err.message) &&
      !err.message.includes('hunter2'),
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
  // Well past Number.MAX_SAFE_INTEGER, and in wei that is a rounding error rather than an exotic
  // case: one EMBER is 1e18 wei, so ANY realistic budget is outside the double range.
  const env = loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_WEI: '9007199254740993' }, 'host')
  assert.equal(env.seasonRewardBudgetWei, 9_007_199_254_740_993n)
})

test('the default season reward budget is 4,000 EMBER', () => {
  // Not a relabelling of the 100,000 Shards this used to default to: 100 Shards to the USD and
  // EMBER administered at 0.25 USD makes USD 1,000 either way. See the derivation in env.ts.
  assert.equal(loadEnv(BASE, 'host').seasonRewardBudgetWei, 4_000_000_000_000_000_000_000n)
})

test('a zero reward budget is refused: a season that can pay nothing is a mistake', () => {
  assert.throws(() => loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_WEI: '0' }, 'host'), /positive/)
})

test('a non-numeric budget is refused rather than defaulted', () => {
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_WEI: 'lots' }, 'host'),
    /whole number of wei/,
  )
})

test('the retired WORLDS_SEASON_REWARD_BUDGET_SHARDS is refused, not ignored', () => {
  // Accepting-and-ignoring it would run the default budget while the deployment believes it set
  // one, and the two numbers differ by 4e16 — the Shard-to-wei rate — not by nothing.
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_SEASON_REWARD_BUDGET_SHARDS: '100000' }, 'host'),
    /retired with the asset it names/,
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
  //
  // BYTES, not keystrokes: `cfsc_` plus 32 keystrokes of base64url is 24 bytes, which is under the
  // floor and was past the check this file used to make.
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_IDENTITY_CREDENTIAL: 'cfsc_short' }),
    (err: unknown) =>
      err instanceof EnvError &&
      err.message.includes('WORLDS_IDENTITY_CREDENTIAL') &&
      /bytes of key material/.test(err.message) &&
      !err.message.includes('cfsc_short'),
  )
})

test('A TOKEN PASTED INTO THE CREDENTIAL IS REFUSED BY NAME — micro-org #222', () => {
  // The single most likely mistake while this rolls out: `WORLDS_SERVICE_TOKEN` held a 600-second
  // JWT, and pasting one into the credential would authenticate for ten minutes and then reproduce
  // the exact defect the credential was introduced to remove.
  //
  // If this ever fails and the fix on offer is a JWT exemption or a weaker assertion, the fix IS
  // the defect. The error names the variable and never quotes the value.
  assert.throws(
    () => loadEnv({ ...BASE, WORLDS_IDENTITY_CREDENTIAL: JWT }),
    (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match(err.message, /WORLDS_IDENTITY_CREDENTIAL/)
      assert.match(err.message, /TOKEN, not a credential|micro-org#197/)
      assert.ok(!err.message.includes(JWT), 'the error quoted the token back')
      return true
    },
  )
})

test('an empty string is an ABSENT credential, not a present one', () => {
  // `WORLDS_IDENTITY_CREDENTIAL: ${WORLDS_IDENTITY_CREDENTIAL:-}` in the estate compose expands to
  // empty when the variable is unset, so this is the literal value a real deployment passes.
  // Refusing it would turn an erasure gap into an outage; reading it as present would build a
  // provider around nothing.
  assert.equal(loadEnv({ ...BASE, WORLDS_IDENTITY_CREDENTIAL: '' }).identityCredential, null)
  assert.equal(loadEnv({ ...BASE, WORLDS_IDENTITY_CREDENTIAL: '   ' }).identityCredential, null)
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
  // Deliberately a JWT: it is what this variable actually held, and the point is that a RETIRED
  // variable confers nothing and REQUIRES nothing — not even a well-formed value. Nothing asserts
  // it, because nothing reads it beyond `.length > 0`. That is how micro-org #222 is closed for
  // this service: the expired token cannot break a boot it is not consulted by.
  const withLegacy = loadEnv({ ...BASE, WORLDS_SERVICE_TOKEN: JWT })
  assert.equal(withLegacy.legacyServiceTokenPresent, true)
  // And it confers nothing: setting it must not make the service look configured.
  assert.equal(withLegacy.identityCredential, null)
})
