/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE CONFORMANCE SUITE A SECOND TITLE MUST PASS.**
 *
 * "A second game is possible" has to be a test rather than a claim, and this file is the test. It
 * is executable, it takes a base URL, and it is the whole of what a title service has to satisfy
 * before it can be registered and sold to. A title that passes needs no change to this service; a
 * title that fails is told which of nine checks it failed and why.
 *
 * It is deliberately NOT a `node:test` file. It is a function, so three things can run it:
 *
 *   1. `conformance.test.ts`, against two in-memory titles — which is what turns "a second game is
 *      possible" from an assertion into a demonstration.
 *   2. A title's own CI, against itself, as a contract test.
 *   3. An operator, against a candidate title, before registering it.
 *
 * ## What is checked, and why each one is here rather than being left to good faith
 *
 *   1. `/livez` answers.                A title that cannot say it is alive cannot be probed, and
 *                                       a provisioning failure against it is indistinguishable
 *                                       from it being down.
 *
 *   2. `GET /v1/title` describes it.    A registration is only as good as what the title says it
 *                                       can do. Capabilities are read BEFORE a provision is
 *                                       attempted, so a purchase for something a title does not
 *                                       do is refused with a row rather than a 404.
 *
 *   3. Its slug is well formed.         The slug is a URL segment and an entitlement scope id.
 *                                       An ill-formed one is a path traversal or a scope that
 *                                       matches more than it should.
 *
 *   4. Its capabilities are known.      A typo in a capability is a purchase that is accepted and
 *                                       never delivered — the exact defect being fixed.
 *
 *   5. **A provision is idempotent on the entitlement id.** THE ONE THAT MATTERS. The bridge is
 *      at-least-once by construction: the event may be redelivered, the job may be retried, and
 *      two replicas may both hold a claim in the instant after one crashes. A title that ignores
 *      the key raises a second world for one purchase, which is the mirror image of the defect
 *      the bridge exists to fix. Checked by provisioning twice and requiring the SAME urn back.
 *
 *   6. It returns a URN.                Something this service can record, and something the rest
 *                                       of the estate can point at. A 2xx with nothing in it is a
 *                                       title claiming a success it cannot name.
 *
 *   7. It refuses an unknown SKU        With a 422, not a 500 and not a cheerful 200. `unsupported`
 *      as an ANSWER.                    is terminal and must be distinguishable from an outage, or
 *                                       a catalogue mistake is retried until an attempt budget
 *                                       runs out and then reported as a title failure.
 *
 *   8. It refuses an unsigned or        A provisioning endpoint that anybody can reach is a
 *      unauthenticated provision.       free-worlds endpoint. This service always sends its scoped
 *                                       credential; a title that does not check it is one curl
 *                                       away from an infinite inventory.
 *
 *   9. It does not leak another         A provision names a subject. A title that will provision
 *      account's world.                 for any subject a caller states, without checking that the
 *                                       caller is this platform, has no ownership model at all.
 *
 * ## What is deliberately NOT checked
 *
 * Anything about simulation. Ticks, maps, combat, balance, how many tiles a world has — none of it
 * is this service's business, and a conformance suite that reached into it would be a second game
 * engine pretending to be a contract. 04-domain-model §7.4: a title service owns simulation state;
 * this service owns anything that must outlive a season or cross a title. The line is exactly there
 * and this file is the line.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { isCapability } from './titles.ts'

export interface ConformanceCheck {
  readonly id: string
  readonly title: string
  readonly passed: boolean
  readonly detail: string
}

export interface ConformanceReport {
  readonly baseUrl: string
  readonly slug: string | null
  readonly passed: boolean
  readonly checks: readonly ConformanceCheck[]
}

export interface ConformanceOptions {
  readonly baseUrl: string
  /** The credential this platform would present. A title MUST require one. */
  readonly token: string
  /** A SKU the title claims to sell, used for the idempotency check. */
  readonly sku: string
  /** Metadata a real grant would carry — a world name, a season length, a player cap. */
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly fetch?: typeof globalThis.fetch
  /** Injected so a run is reproducible and two runs do not collide on one entitlement id. */
  readonly entitlementId?: string
  readonly deadlineMs?: number
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/

/**
 * Run every check. **Never throws** — a title that is entirely broken produces a report saying so,
 * because a thrown exception here would tell an operator less than a list of nine falses.
 */
export async function runConformance(options: ConformanceOptions): Promise<ConformanceReport> {
  const doFetch = options.fetch ?? globalThis.fetch
  const deadlineMs = options.deadlineMs ?? 10_000
  const base = options.baseUrl.replace(/\/$/, '')
  const checks: ConformanceCheck[] = []
  let slug: string | null = null

  const record = (id: string, title: string, passed: boolean, detail: string): void => {
    checks.push({ id, title, passed, detail })
  }

  const call = async (
    path: string,
    init: { method?: string; token?: string | null; body?: unknown } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await doFetch(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? options.token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(deadlineMs),
    })
    const text = await response.text()
    let body: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    } catch {
      // A non-JSON body is not fatal here: the status is what most checks turn on, and a check
      // that needs a field will fail on its absence with a message that says which field.
    }
    return { status: response.status, body }
  }

  /* 1 — liveness */
  try {
    const res = await call('/livez', { token: null })
    record('livez', 'the title answers /livez', res.status === 200, `status ${res.status}`)
  } catch (err) {
    record('livez', 'the title answers /livez', false, describe(err))
  }

  /* 2, 3, 4 — the descriptor */
  let capabilities: readonly string[] = []
  try {
    const res = await call('/v1/title')
    const ok = res.status === 200 && typeof res.body['slug'] === 'string'
    slug = typeof res.body['slug'] === 'string' ? res.body['slug'] : null
    capabilities = Array.isArray(res.body['capabilities'])
      ? (res.body['capabilities'] as unknown[]).filter((c): c is string => typeof c === 'string')
      : []
    record('descriptor', 'GET /v1/title describes the title', ok, `status ${res.status}`)
    record(
      'slug',
      'the slug is a safe URL segment and scope id',
      slug !== null && SLUG.test(slug),
      slug === null ? 'no slug' : `slug ${slug}`,
    )
    const unknown = capabilities.filter((c) => !isCapability(c))
    record(
      'capabilities',
      'every declared capability is one this platform knows',
      Array.isArray(res.body['capabilities']) && unknown.length === 0,
      unknown.length > 0 ? `unknown: ${unknown.join(', ')}` : `declared: ${capabilities.join(', ') || 'none'}`,
    )
  } catch (err) {
    record('descriptor', 'GET /v1/title describes the title', false, describe(err))
    record('slug', 'the slug is a safe URL segment and scope id', false, 'no descriptor')
    record('capabilities', 'every declared capability is one this platform knows', false, 'no descriptor')
  }

  /* 8 — an unauthenticated provision is refused. Run BEFORE the idempotency check, so a title
     that provisions for anybody has not already created the thing under test. */
  const entitlementId = options.entitlementId ?? `conformance-${crypto.randomUUID()}`
  const provisionBody = {
    entitlementId,
    subject: 'user:00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000001',
    sku: options.sku,
    scope: 'title:conformance',
    metadata: options.metadata ?? {},
  }
  try {
    const res = await call('/v1/provision', { method: 'POST', token: null, body: provisionBody })
    record(
      'authentication',
      'an unauthenticated provision is refused',
      res.status === 401 || res.status === 403,
      `status ${res.status}`,
    )
  } catch (err) {
    record('authentication', 'an unauthenticated provision is refused', false, describe(err))
  }

  /* 9 — a forged credential is refused too. A title that only checks for the header's PRESENCE
     has an authentication check that is decorative. */
  try {
    const res = await call('/v1/provision', {
      method: 'POST',
      token: 'not-this-platforms-token',
      body: provisionBody,
    })
    record(
      'credential',
      'a credential this platform did not issue is refused',
      res.status === 401 || res.status === 403,
      `status ${res.status}`,
    )
  } catch (err) {
    record('credential', 'a credential this platform did not issue is refused', false, describe(err))
  }

  /* 5, 6 — provisioning, and its idempotency */
  let firstUrn: string | null = null
  try {
    const first = await call('/v1/provision', { method: 'POST', body: provisionBody })
    firstUrn = typeof first.body['urn'] === 'string' ? first.body['urn'] : null
    record(
      'provision',
      'a provision succeeds and returns a urn',
      (first.status === 200 || first.status === 201) && firstUrn !== null,
      firstUrn ? `urn ${firstUrn}` : `status ${first.status}, no urn`,
    )

    const second = await call('/v1/provision', { method: 'POST', body: provisionBody })
    const secondUrn = typeof second.body['urn'] === 'string' ? second.body['urn'] : null
    record(
      'idempotency',
      'provisioning twice with one entitlement id returns the SAME urn',
      firstUrn !== null && secondUrn === firstUrn,
      firstUrn === null
        ? 'the first provision produced no urn'
        : secondUrn === null
          ? `the replay produced no urn (status ${second.status})`
          : secondUrn === firstUrn
            ? 'the replay returned the same urn'
            : `the replay returned ${secondUrn}, a SECOND world for one purchase`,
    )
  } catch (err) {
    record('provision', 'a provision succeeds and returns a urn', false, describe(err))
    record('idempotency', 'provisioning twice with one entitlement id returns the SAME urn', false, describe(err))
  }

  /* 7 — an unknown SKU is an ANSWER */
  try {
    const res = await call('/v1/provision', {
      method: 'POST',
      body: {
        ...provisionBody,
        entitlementId: `${entitlementId}-unknown`,
        sku: 'definitely_not_a_real_sku',
      },
    })
    const code = ((res.body['error'] as { code?: unknown } | undefined)?.code ?? '') as string
    record(
      'unsupported',
      'an unknown sku is refused with 422, not a 500 and not a cheerful 200',
      res.status === 422 || code === 'unsupported',
      `status ${res.status}${code ? `, code ${code}` : ''}`,
    )
  } catch (err) {
    record('unsupported', 'an unknown sku is refused with 422, not a 500 and not a cheerful 200', false, describe(err))
  }

  return {
    baseUrl: options.baseUrl,
    slug,
    passed: checks.every((check) => check.passed),
    checks,
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** A human-readable report, for an operator running this by hand. */
export function formatReport(report: ConformanceReport): string {
  const lines = [
    `conformance: ${report.slug ?? report.baseUrl} — ${report.passed ? 'PASS' : 'FAIL'}`,
  ]
  for (const check of report.checks) {
    lines.push(`  ${check.passed ? 'pass' : 'FAIL'}  ${check.id}: ${check.title} (${check.detail})`)
  }
  return lines.join('\n')
}
