/**
 * Rewards are money, so the cap is the test.
 *
 * The service this supersedes has no cap of any kind and no ledger entry either. These tests are
 * the two halves of the fix: every reward is a balanced posting, and no season can be spent past.
 */

import assert from 'node:assert/strict'
import test, { after, before, beforeEach } from 'node:test'
import type postgres from 'postgres'
import {
  BudgetExceededError,
  defineAchievement,
  grantReward,
  listUnlocked,
  openSeason,
  seasonBudget,
  unlockAchievement,
} from './rewards.ts'
import { registerTitle } from './titles.ts'
import { LedgerUnavailableError } from './ledgerclient.ts'
import type { Db } from './outbox.ts'
import {
  ALICE,
  BOB,
  enabled,
  fakeLedger,
  migrateTestDb,
  openDb,
  resetWorlds,
  skip,
  type FakeLedger,
} from './testsupport.ts'

let sql: postgres.Sql
let db: Db
let ledger: FakeLedger

before(async () => {
  if (!enabled) return
  sql = openDb()
  db = sql as unknown as Db
  await migrateTestDb(sql)
})

beforeEach(async () => {
  if (!enabled) return
  await resetWorlds(sql)
  ledger = fakeLedger()
})

after(async () => {
  if (!enabled) return
  await sql.end({ timeout: 5 })
})

async function aTitle(slug = 'ashfall'): Promise<string> {
  const title = await registerTitle(db, 'worlds', {
    slug,
    name: slug,
    status: 'live',
    serviceUrl: 'http://127.0.0.1:9001',
    capabilities: ['achievements', 'seasons'],
    assetScopes: [],
    actor: 'operator:test',
    correlationId: 'req-1',
  })
  return title.id
}

async function aSeason(budget = 1_000n): Promise<string> {
  const titleId = await aTitle()
  const season = await openSeason(db, {
    titleId,
    slug: 's1',
    name: 'Season One',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2026-04-01T00:00:00Z'),
    rewardBudgetShards: budget,
    status: 'active',
  })
  return season.id
}

const deps = () => ({ sql: db, ledger, producer: 'worlds' })

/* ------------------------------------------------------------------ the posting */

test('a reward is a BALANCED LEDGER POSTING, not a column somewhere', { skip }, async () => {
  const seasonId = await aSeason()
  const grant = await grantReward(deps(), {
    seasonId,
    userId: ALICE,
    reason: 'first_blood',
    amountShards: 100n,
    actor: `service:worlds`,
    correlationId: 'req-2',
  })
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.entries[0]?.kind, 'reward_granted')
  const postings = ledger.entries[0]?.postings ?? []
  assert.equal(postings.length, 2)
  // The platform GIVES the customer money, so it shows up as an expense the platform can be asked
  // about rather than as a number that appeared in a player's row.
  assert.equal(postings[0]?.direction, 'debit')
  assert.equal(postings[0]?.account.subject, 'platform')
  assert.equal(postings[0]?.account.type, 'expense')
  assert.equal(postings[1]?.direction, 'credit')
  assert.equal(postings[1]?.account.subject, `user:${ALICE}`)
  assert.equal(postings[0]?.amount, postings[1]?.amount)
  assert.ok(grant.journalEntryId)
})

test('the local record names the entry that paid it', { skip }, async () => {
  // A reward with no entry is a payment that exists only in this service's opinion.
  const seasonId = await aSeason()
  const grant = await grantReward(deps(), {
    seasonId,
    userId: ALICE,
    reason: 'first_blood',
    amountShards: 100n,
    actor: 'service:worlds',
    correlationId: 'req-2',
  })
  const rows = await sql<{ journal_entry_id: string }[]>`
    select journal_entry_id from reward_grants where id = ${grant.id}
  `
  assert.equal(rows[0]?.journal_entry_id, grant.journalEntryId)
})

/* ------------------------------------------------------------------ THE CAP */

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A GAME EXPLOIT THAT MINTS REWARDS IS A MONEY INCIDENT.**
 *
 * This is the test that says the cap is a control rather than an intention: the loop below is the
 * exploit — the same reward asked for over and over — and the budget stops it dead. In the frozen
 * service this loop runs for ever.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('a season cannot be spent past its budget, however many times it is asked', { skip }, async () => {
  const seasonId = await aSeason(250n)
  for (let i = 0; i < 5; i += 1) {
    await grantReward(deps(), {
      seasonId,
      userId: ALICE,
      reason: `objective_${i}`,
      amountShards: 50n,
      actor: 'service:worlds',
      correlationId: `req-${i}`,
    })
  }
  // 250 spent, 0 left. The sixth is refused.
  await assert.rejects(
    () =>
      grantReward(deps(), {
        seasonId,
        userId: ALICE,
        reason: 'objective_5',
        amountShards: 50n,
        actor: 'service:worlds',
        correlationId: 'req-5',
      }),
    BudgetExceededError,
  )
  const budget = await seasonBudget(db, seasonId)
  assert.equal(budget?.granted, 250n)
  assert.equal(budget?.remaining, 0n)
  assert.equal(ledger.entries.length, 5, 'exactly five entries were ever posted')
})

test('a refused reward asks the ledger for NOTHING', { skip }, async () => {
  // The cap is charged FIRST, so a grant that cannot be afforded never moves real money and then
  // declines to record it.
  const seasonId = await aSeason(10n)
  await assert.rejects(
    () =>
      grantReward(deps(), {
        seasonId,
        userId: ALICE,
        reason: 'jackpot',
        amountShards: 1_000n,
        actor: 'service:worlds',
        correlationId: 'req-2',
      }),
    BudgetExceededError,
  )
  assert.equal(ledger.entries.length, 0)
  assert.equal(ledger.keys.length, 0, 'the ledger was not even asked')
  const budget = await seasonBudget(db, seasonId)
  assert.equal(budget?.granted, 0n, 'the budget was rolled back')
})

test('the refusal says how much is left, so a caller can act on it', { skip }, async () => {
  const seasonId = await aSeason(100n)
  await grantReward(deps(), {
    seasonId,
    userId: ALICE,
    reason: 'a',
    amountShards: 90n,
    actor: 'service:worlds',
    correlationId: 'req-2',
  })
  await assert.rejects(
    () =>
      grantReward(deps(), {
        seasonId,
        userId: BOB,
        reason: 'b',
        amountShards: 50n,
        actor: 'service:worlds',
        correlationId: 'req-3',
      }),
    (err: unknown) => err instanceof BudgetExceededError && err.remaining === 10n,
  )
})

test('two concurrent grants cannot both spend the last of a budget', { skip }, async () => {
  const seasonId = await aSeason(100n)
  const results = await Promise.allSettled([
    grantReward(deps(), {
      seasonId,
      userId: ALICE,
      reason: 'a',
      amountShards: 100n,
      actor: 'service:worlds',
      correlationId: 'req-2',
    }),
    grantReward(deps(), {
      seasonId,
      userId: BOB,
      reason: 'b',
      amountShards: 100n,
      actor: 'service:worlds',
      correlationId: 'req-3',
    }),
  ])
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(ledger.entries.length, 1)
  assert.equal((await seasonBudget(db, seasonId))?.granted, 100n)
})

/* ------------------------------------------------------------------ idempotency */

test('the same reward asked twice pays once', { skip }, async () => {
  const seasonId = await aSeason()
  const first = await grantReward(deps(), {
    seasonId,
    userId: ALICE,
    reason: 'first_blood',
    amountShards: 100n,
    actor: 'service:worlds',
    correlationId: 'req-2',
  })
  const second = await grantReward(deps(), {
    seasonId,
    userId: ALICE,
    reason: 'first_blood',
    amountShards: 100n,
    actor: 'service:worlds',
    correlationId: 'req-3',
  })
  assert.equal(second.replayed, true)
  assert.equal(second.id, first.id)
  assert.equal(ledger.entries.length, 1)
  // And it did not charge the budget twice.
  assert.equal((await seasonBudget(db, seasonId))?.granted, 100n)
})

test('an unreachable ledger rolls the budget back', { skip }, async () => {
  // The budget is charged first, inside the same transaction, so a ledger that cannot be reached
  // leaves the season exactly as it was rather than having quietly spent a hundred shards.
  const seasonId = await aSeason()
  ledger.failNext(new LedgerUnavailableError('connect ECONNREFUSED'))
  await assert.rejects(() =>
    grantReward(deps(), {
      seasonId,
      userId: ALICE,
      reason: 'first_blood',
      amountShards: 100n,
      actor: 'service:worlds',
      correlationId: 'req-2',
    }),
  )
  assert.equal((await seasonBudget(db, seasonId))?.granted, 0n)
  const rows = await sql<{ n: number }[]>`select count(*)::int as n from reward_grants`
  assert.equal(rows[0]?.n, 0)
})

test('a zero or negative reward is refused', { skip }, async () => {
  const seasonId = await aSeason()
  await assert.rejects(
    () =>
      grantReward(deps(), {
        seasonId,
        userId: ALICE,
        reason: 'nothing',
        amountShards: 0n,
        actor: 'service:worlds',
        correlationId: 'req-2',
      }),
    /positive number of shards/,
  )
})

/* ------------------------------------------------------------------ achievements */

test('an achievement unlocks once per ACCOUNT, not once per world', { skip }, async () => {
  const titleId = await aTitle()
  await defineAchievement(db, { titleId, key: 'first_blood', name: 'First Blood', points: 10 })
  const first = await unlockAchievement(db, 'worlds', {
    userId: ALICE,
    titleId,
    key: 'first_blood',
    actor: 'service:ashfall',
    correlationId: 'req-2',
  })
  const second = await unlockAchievement(db, 'worlds', {
    userId: ALICE,
    titleId,
    key: 'first_blood',
    actor: 'service:ashfall',
    correlationId: 'req-3',
  })
  assert.equal(first.unlocked, true)
  assert.equal(second.unlocked, false, 'a title re-evaluating every tick unlocks it once')

  const unlocked = await listUnlocked(db, ALICE, titleId)
  assert.equal(unlocked.length, 1)
})

test('an unlock emits exactly one event, however many times it is asked for', { skip }, async () => {
  const titleId = await aTitle()
  await defineAchievement(db, { titleId, key: 'first_blood', name: 'First Blood' })
  for (let i = 0; i < 3; i += 1) {
    await unlockAchievement(db, 'worlds', {
      userId: ALICE,
      titleId,
      key: 'first_blood',
      actor: 'service:ashfall',
      correlationId: `req-${i}`,
    })
  }
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from outbox where topic = 'worlds.achievement.unlocked'
  `
  assert.equal(rows[0]?.n, 1)
})

test('an unknown achievement key is refused rather than silently ignored', { skip }, async () => {
  const titleId = await aTitle()
  await assert.rejects(
    () =>
      unlockAchievement(db, 'worlds', {
        userId: ALICE,
        titleId,
        key: 'not_a_thing',
        actor: 'service:ashfall',
        correlationId: 'req-2',
      }),
    /no achievement not_a_thing/,
  )
})

test('two titles keep separate achievement namespaces and separate unlocks', { skip }, async () => {
  const a = await aTitle('ashfall')
  const b = await aTitle('emberfall')
  await defineAchievement(db, { titleId: a, key: 'first_blood', name: 'First Blood (Ashfall)' })
  await defineAchievement(db, { titleId: b, key: 'first_blood', name: 'First Blood (Emberfall)' })
  await unlockAchievement(db, 'worlds', {
    userId: ALICE,
    titleId: a,
    key: 'first_blood',
    actor: 'service:ashfall',
    correlationId: 'req-2',
  })
  assert.equal((await listUnlocked(db, ALICE, a)).length, 1)
  assert.equal((await listUnlocked(db, ALICE, b)).length, 0, 'unlocking in one title is not the other')
  assert.equal((await listUnlocked(db, ALICE)).length, 1, 'the account view spans titles')
})

/* ------------------------------------------------------------------ seasons */

test('a season is a ROW per title, so a second season is possible', { skip }, async () => {
  const titleId = await aTitle()
  const one = await openSeason(db, {
    titleId,
    slug: 's1',
    name: 'Season One',
    startsAt: new Date('2026-01-01T00:00:00Z'),
    endsAt: new Date('2026-04-01T00:00:00Z'),
    rewardBudgetShards: 1_000n,
  })
  const two = await openSeason(db, {
    titleId,
    slug: 's2',
    name: 'Season Two',
    startsAt: new Date('2026-04-01T00:00:00Z'),
    endsAt: new Date('2026-07-01T00:00:00Z'),
    rewardBudgetShards: 2_000n,
  })
  assert.notEqual(one.id, two.id)
  assert.equal(two.rewardBudgetShards, 2_000n)
})

test('a budget cannot be lowered below what has already been paid', { skip }, async () => {
  const seasonId = await aSeason(1_000n)
  await grantReward(deps(), {
    seasonId,
    userId: ALICE,
    reason: 'a',
    amountShards: 500n,
    actor: 'service:worlds',
    correlationId: 'req-2',
  })
  const season = await sql<{ title_id: string }[]>`select title_id from seasons where id = ${seasonId}`
  // Lowering a budget cannot un-pay a reward, and the CHECK is what says so.
  await assert.rejects(
    () =>
      openSeason(db, {
        titleId: season[0]!.title_id,
        slug: 's1',
        name: 'Season One',
        startsAt: new Date('2026-01-01T00:00:00Z'),
        endsAt: new Date('2026-04-01T00:00:00Z'),
        rewardBudgetShards: 100n,
      }),
    /seasons_within_budget/,
  )
})
