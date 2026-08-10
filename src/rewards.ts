/**
 * Achievements, seasons, and rewards that are money.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A REWARD IS A LEDGER POSTING WITH A BUDGET CAP, BECAUSE A GAME EXPLOIT THAT MINTS REWARDS IS
 * A MONEY INCIDENT.**
 *
 * That sentence is the whole design and it has two halves, both of which the service this
 * supersedes is missing.
 *
 * **The posting.** There, XP, levels, skill points and `tokens` are plain integer columns
 * incremented in place — `work.tokens += locked.rewardTokens` — with no entry anywhere and no
 * possibility of reconciliation. It is survivable only because those tokens are a dead currency:
 * nothing spends them, and their only consumer is one achievement trigger. The moment a reward is
 * worth EMBER wei — a balance a player can withdraw to a chain — an unreconciled increment is a
 * hole in the money.
 *
 * **The cap.** There is no cap of any kind there: no daily, weekly, seasonal or global issuance
 * budget, no counter, no alert. `grantXp` loops levels with no ceiling. So a bug that grants an
 * objective twice per tick grants it for ever, and the only bound is how long it takes somebody to
 * notice.
 *
 * Here the budget is a column, the check is a database CHECK, and the increment happens in the
 * SAME TRANSACTION as the grant. `seasons_within_budget` therefore cannot be spent past by any
 * amount of application-level cleverness, by a second replica, or by a hand-run UPDATE — the
 * transaction simply fails to commit. That is the difference between a control and an intention.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The ordering inside `grantReward`, which is the part that is easy to get backwards
 *
 *   1. Increment `rewards_granted_wei` FIRST, under the CHECK. If the season cannot afford it,
 *      the transaction fails here — before the ledger has been asked for anything. Posting first
 *      and capping second would move real money and then decline to record it.
 *   2. Post to the ledger, inside the transaction, with a derived key.
 *   3. Insert the `reward_grants` row naming the entry.
 *
 * A crash anywhere rolls all three back, and the retry replays the ledger entry rather than
 * posting a second one. A crash between 2 and 3 is the one that would have been dangerous, and it
 * is the one the derived key makes safe.
 */

import type { Db } from './outbox.ts'
import { withOutbox } from './outbox.ts'
import {
  REWARD_ASSET,
  rewardIdempotencyKey,
  rewardPostings,
  type LedgerClient,
} from './ledgerclient.ts'

export const REWARD_GRANTED_TOPIC = 'worlds.reward.granted'
export const ACHIEVEMENT_UNLOCKED_TOPIC = 'worlds.achievement.unlocked'

export class RewardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RewardError'
  }
}

/** The season cannot afford this grant. Not a fault: the cap did its job. */
export class BudgetExceededError extends RewardError {
  readonly seasonId: string
  readonly remaining: bigint
  constructor(seasonId: string, remaining: bigint, requested: bigint) {
    super(
      `this season's reward budget has ${remaining} wei of EMBER left and the grant asks for ${requested}`,
    )
    this.name = 'BudgetExceededError'
    this.seasonId = seasonId
    this.remaining = remaining
  }
}

/**
 * A re-open tried to raise a season's reward budget without naming an approval.
 *
 * Not a fault either: the season's budget is a spending limit on `engagement:worlds`, and 21 §6
 * makes raising one an approved act while leaving lowering free. The database is what refuses it
 * (`seasons_budget_raise_needs_approval`, migration 10); this type exists so the refusal reaches a
 * caller as a sentence about approvals rather than as a Postgres exception string.
 */
export class BudgetRaiseNeedsApprovalError extends RewardError {
  readonly titleId: string
  readonly slug: string
  constructor(titleId: string, slug: string, requested: bigint) {
    super(
      `raising this season's reward budget to ${requested} wei of EMBER needs an approved ` +
        'engagement.policy.set approval id; lowering it does not (21 §7.7)',
    )
    this.name = 'BudgetRaiseNeedsApprovalError'
    this.titleId = titleId
    this.slug = slug
  }
}

/* ------------------------------------------------------------------ achievements */

export interface Achievement {
  readonly id: string
  readonly titleId: string
  readonly key: string
  readonly name: string
  readonly description: string
  readonly points: number
  readonly rewardWei: bigint
}

interface AchievementRow {
  readonly id: string
  readonly title_id: string
  readonly key: string
  readonly name: string
  readonly description: string
  readonly points: number
  readonly reward_wei: string
}

const ACHIEVEMENT_COLUMNS = `id, title_id, key, name, description, points, reward_wei`

const toAchievement = (row: AchievementRow): Achievement => ({
  id: row.id,
  titleId: row.title_id,
  key: row.key,
  name: row.name,
  description: row.description,
  points: row.points,
  rewardWei: BigInt(row.reward_wei),
})

/**
 * Define an achievement, or update the one with this key.
 *
 * Keyed on `(title_id, key)`, so two titles may both ship a `first_blood` without colliding. In
 * the frozen estate an achievement id is `${playerId}:${achId}` with no title anywhere, and the
 * catalogue is a module-level array in a shared package — so a second title's achievements would
 * be a republish of that package and a collision on any key both chose.
 */
export async function defineAchievement(
  sql: Db,
  input: {
    readonly titleId: string
    readonly key: string
    readonly name: string
    readonly description?: string
    readonly points?: number
    readonly rewardWei?: bigint
  },
): Promise<Achievement> {
  const rows = await sql<AchievementRow[]>`
    insert into achievements (title_id, key, name, description, points, reward_wei)
    values (
      ${input.titleId}, ${input.key}, ${input.name}, ${input.description ?? ''},
      ${input.points ?? 0}, ${(input.rewardWei ?? 0n).toString()}::numeric
    )
    on conflict (title_id, key) do update set
      name = excluded.name,
      description = excluded.description,
      points = excluded.points,
      reward_wei = excluded.reward_wei
    returning ${sql.unsafe(ACHIEVEMENT_COLUMNS)}
  `
  const row = rows[0]
  if (!row) throw new Error('upsert returned no row')
  return toAchievement(row)
}

export async function findAchievement(
  sql: Db,
  titleId: string,
  key: string,
): Promise<Achievement | null> {
  const rows = await sql<AchievementRow[]>`
    select ${sql.unsafe(ACHIEVEMENT_COLUMNS)} from achievements
     where title_id = ${titleId} and key = ${key}
  `
  const row = rows[0]
  return row ? toAchievement(row) : null
}

export async function listAchievements(sql: Db, titleId: string): Promise<Achievement[]> {
  const rows = await sql<AchievementRow[]>`
    select ${sql.unsafe(ACHIEVEMENT_COLUMNS)} from achievements where title_id = ${titleId} order by key
  `
  return rows.map(toAchievement)
}

export interface UnlockResult {
  readonly unlocked: boolean
  readonly achievement: Achievement
}

/**
 * Unlock an achievement for an account, once.
 *
 * The primary key `(user_id, achievement_id)` IS the idempotency, exactly as the frozen service's
 * deterministic `${playerId}:${achId}` id is — that part it gets right and it is carried forward.
 * What is new is that the unlock is account-scoped rather than per-world, so a player who unlocked
 * something in season one still has it in season two.
 *
 * **This does not pay.** A reward-bearing achievement is paid by `grantReward`, which needs a
 * season to charge the budget to. Splitting them means an achievement can be unlocked outside a
 * season — which is most of them — without inventing a budget to spend.
 */
export async function unlockAchievement(
  sql: Db,
  producer: string,
  input: {
    readonly userId: string
    readonly titleId: string
    readonly key: string
    readonly actor: string
    readonly correlationId: string
  },
): Promise<UnlockResult> {
  const achievement = await findAchievement(sql, input.titleId, input.key)
  if (!achievement) throw new RewardError(`no achievement ${input.key} for this title`)

  return withOutbox(sql, producer, async (tx, emit) => {
    const rows = await tx<{ user_id: string }[]>`
      insert into player_achievements (user_id, achievement_id)
      values (${input.userId}, ${achievement.id})
      on conflict (user_id, achievement_id) do nothing
      returning user_id
    `
    if (rows.length === 0) return { unlocked: false, achievement }
    emit({
      topic: ACHIEVEMENT_UNLOCKED_TOPIC,
      key: `${input.userId}:${achievement.id}`,
      payload: {
        userId: input.userId,
        titleId: input.titleId,
        achievementKey: achievement.key,
        name: achievement.name,
        points: achievement.points,
        rewardWei: achievement.rewardWei.toString(),
        // Named for the same reason as on `worlds.reward.granted`, and named even though this
        // event does not pay: an unlock announces what the achievement is WORTH, and a worth
        // without a unit is the defect #226 exists about. `rewardWei` is 0 on all 47 achievements
        // defined on mainnet as of 2026-08-10, so no consumer sees a figure change here.
        assetCode: REWARD_ASSET,
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })
    return { unlocked: true, achievement }
  })
}

export async function listUnlocked(
  sql: Db,
  userId: string,
  titleId?: string,
): Promise<Array<{ achievement: Achievement; unlockedAt: Date }>> {
  const rows = titleId
    ? await sql<(AchievementRow & { unlocked_at: Date })[]>`
        select a.id, a.title_id, a.key, a.name, a.description, a.points, a.reward_wei,
               pa.unlocked_at
          from player_achievements pa
          join achievements a on a.id = pa.achievement_id
         where pa.user_id = ${userId} and a.title_id = ${titleId}
         order by pa.unlocked_at desc
      `
    : await sql<(AchievementRow & { unlocked_at: Date })[]>`
        select a.id, a.title_id, a.key, a.name, a.description, a.points, a.reward_wei,
               pa.unlocked_at
          from player_achievements pa
          join achievements a on a.id = pa.achievement_id
         where pa.user_id = ${userId}
         order by pa.unlocked_at desc
      `
  return rows.map((row) => ({ achievement: toAchievement(row), unlockedAt: row.unlocked_at }))
}

/* ------------------------------------------------------------------ seasons */

export type SeasonStatus = 'upcoming' | 'active' | 'ended' | 'archived'

export interface Season {
  readonly id: string
  readonly titleId: string
  readonly slug: string
  readonly name: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly status: SeasonStatus
  readonly rewardBudgetWei: bigint
  readonly rewardsGrantedWei: bigint
  /**
   * The approval that authorised the CURRENT budget, or null if it has never been raised.
   *
   * Exposed rather than hidden: a spending limit that was raised should be able to say what
   * raised it, and 21 §4's whole premise is that the programme can be reconstructed after the
   * fact by somebody who was not in the room.
   */
  readonly budgetRaiseApprovalId: string | null
}

interface SeasonRow {
  readonly id: string
  readonly title_id: string
  readonly slug: string
  readonly name: string
  readonly starts_at: Date
  readonly ends_at: Date
  readonly status: string
  readonly reward_budget_wei: string
  readonly rewards_granted_wei: string
  readonly budget_raise_approval_id: string | null
}

const SEASON_COLUMNS = `
  id, title_id, slug, name, starts_at, ends_at, status, reward_budget_wei,
  rewards_granted_wei, budget_raise_approval_id
`

const toSeason = (row: SeasonRow): Season => ({
  id: row.id,
  titleId: row.title_id,
  slug: row.slug,
  name: row.name,
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  status: row.status as SeasonStatus,
  rewardBudgetWei: BigInt(row.reward_budget_wei),
  rewardsGrantedWei: BigInt(row.rewards_granted_wei),
  budgetRaiseApprovalId: row.budget_raise_approval_id,
})

/**
 * Open a season, or re-open the one with this slug.
 *
 * A ROW, per title, with a start, an end and a budget. The frozen estate's "Season 1" is a single
 * hardcoded object in a shared package with no expiry and no title — so a second season means
 * editing and republishing that package, and anybody who bought season one owns season two.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **RE-OPENING MAY LOWER THE BUDGET FREELY AND MAY RAISE IT ONLY WITH AN APPROVAL.**
 *
 * `reward_budget_wei` stopped being a game-balance number in migration 9: the season is funded
 * from `engagement:worlds`, rewards debit that account, so the budget is a **spending limit on
 * real platform money**. This function used to assign `reward_budget_wei` unconditionally in
 * its ON CONFLICT branch, which meant the ordinary act of re-opening a season to fix a name or
 * push an end date silently raised that limit to whatever the request carried.
 *
 * Doc 21 §6 makes raising an engagement cap an approved act and lowering one free, §7.7 requires
 * that asymmetry to be proven by test, and `admin-api/src/migrations.ts` already enforces it
 * on `engagement_policies` with a trigger. This is the same rule about the same money, so it is
 * the same mechanism: `seasons_budget_raise_needs_approval` refuses an increase that does not name
 * a fresh approval, and it refuses it against a hand-run UPDATE as well as against this function.
 *
 * The guard is therefore NOT here. What is here is the translation of the database's refusal into
 * `BudgetRaiseNeedsApprovalError`, and the plumbing of `budgetRaiseApprovalId` through to the row.
 * A pre-flight SELECT would have been a lie twice over: it could not bind (two re-opens could read
 * the same old budget and both raise), and it would have made a schema control look optional.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function openSeason(sql: Db, input: OpenSeasonInput): Promise<Season> {
  if (input.rewardBudgetWei <= 0n) {
    throw new RewardError('a season needs a positive reward budget')
  }
  const rows = await upsertSeason(sql, input)
  const row = rows[0]
  if (!row) throw new Error('upsert returned no row')
  return toSeason(row)
}

export interface OpenSeasonInput {
  readonly titleId: string
  readonly slug: string
  readonly name: string
  readonly startsAt: Date
  readonly endsAt: Date
  readonly rewardBudgetWei: bigint
  readonly status?: SeasonStatus
  /**
   * The `engagement.policy.set` approval authorising a RAISE, when this re-open raises the cap.
   *
   * A reference to a row `admin-api` owns — text and no foreign key, like
   * `reward_grants.journal_entry_id` points at the ledger's. Omit it and a raise is refused; omit
   * it and lower, and nothing is asked of anybody. One id authorises one raise, for ever.
   */
  readonly budgetRaiseApprovalId?: string
}

async function upsertSeason(sql: Db, input: OpenSeasonInput): Promise<SeasonRow[]> {
  try {
    return await sql<SeasonRow[]>`
      insert into seasons (
        title_id, slug, name, starts_at, ends_at, status, reward_budget_wei
      ) values (
        ${input.titleId}, ${input.slug}, ${input.name}, ${input.startsAt.toISOString()}::timestamptz,
        ${input.endsAt.toISOString()}::timestamptz, ${input.status ?? 'upcoming'},
        ${input.rewardBudgetWei.toString()}::numeric
      )
      on conflict (title_id, slug) do update set
        name = excluded.name,
        starts_at = excluded.starts_at,
        ends_at = excluded.ends_at,
        status = excluded.status,
        -- Assigned, not guarded, here. LOWERING lands and is floored by seasons_within_budget,
        -- which refuses a budget below what the season has already paid — lowering a budget cannot
        -- un-pay a reward. RAISING reaches seasons_budget_raise_needs_approval, which refuses it
        -- unless the line below carries a fresh approval id.
        reward_budget_wei = excluded.reward_budget_wei,
        -- coalesce, never excluded alone: a re-open that says nothing about approvals must not
        -- blank the id that authorised the budget the season already has, or that id becomes
        -- reusable. The trigger pins it back to its old value on any change that is not a raise.
        budget_raise_approval_id = coalesce(
          ${input.budgetRaiseApprovalId ?? null}, seasons.budget_raise_approval_id
        ),
        updated_at = now()
      returning ${sql.unsafe(SEASON_COLUMNS)}
    `
  } catch (err: unknown) {
    if (isRaiseWithoutApproval(err)) {
      throw new BudgetRaiseNeedsApprovalError(input.titleId, input.slug, input.rewardBudgetWei)
    }
    throw err
  }
}

/**
 * The trigger's refusal, recognised by the name it raises under.
 *
 * Matched on the message rather than on the SQLSTATE alone because `check_violation` is also what
 * `seasons_within_budget` and `seasons_budget_positive` raise, and those are different sentences a
 * caller needs told differently. The name is the first token of the exception for exactly this.
 */
function isRaiseWithoutApproval(err: unknown): boolean {
  return (
    err instanceof Error && err.message.includes('seasons_budget_raise_needs_approval')
  )
}

export async function findSeason(sql: Db, id: string): Promise<Season | null> {
  const rows = await sql<SeasonRow[]>`
    select ${sql.unsafe(SEASON_COLUMNS)} from seasons where id = ${id}
  `
  const row = rows[0]
  return row ? toSeason(row) : null
}

export async function listSeasons(sql: Db, titleId: string): Promise<Season[]> {
  const rows = await sql<SeasonRow[]>`
    select ${sql.unsafe(SEASON_COLUMNS)} from seasons where title_id = ${titleId}
     order by starts_at desc
  `
  return rows.map(toSeason)
}

/* ------------------------------------------------------------------ the reward */

export interface RewardDeps {
  readonly sql: Db
  readonly ledger: LedgerClient
  readonly producer: string
}

export interface GrantRewardInput {
  readonly seasonId: string
  readonly userId: string
  /** The achievement key, objective id or campaign name. Part of the idempotency key. */
  readonly reason: string
  readonly amountWei: bigint
  readonly actor: string
  readonly correlationId: string
}

export interface RewardGrant {
  readonly id: string
  readonly seasonId: string
  readonly userId: string
  readonly reason: string
  readonly amountWei: bigint
  readonly journalEntryId: string
  readonly replayed: boolean
}

/**
 * Pay a reward. See the file header for the ordering and why it is that way round.
 */
export async function grantReward(
  deps: RewardDeps,
  input: GrantRewardInput,
): Promise<RewardGrant> {
  if (input.amountWei <= 0n) {
    throw new RewardError('a reward must be a positive number of wei')
  }
  const key = rewardIdempotencyKey(input.seasonId, input.userId, input.reason)

  return withOutbox(deps.sql, deps.producer, async (tx, emit) => {
    // An already-paid reward is returned rather than paid again. Checked first so the common
    // retry costs one SELECT rather than a ledger round trip.
    const existing = await tx<
      { id: string; amount_wei: string; journal_entry_id: string }[]
    >`select id, amount_wei, journal_entry_id from reward_grants where idempotency_key = ${key}`
    const already = existing[0]
    if (already) {
      return {
        id: already.id,
        seasonId: input.seasonId,
        userId: input.userId,
        reason: input.reason,
        amountWei: BigInt(already.amount_wei),
        journalEntryId: already.journal_entry_id,
        replayed: true,
      }
    }

    // 1. **THE CAP, FIRST.** A conditional UPDATE that both charges the budget and enforces it: if
    //    the season cannot afford this, no row matches and nothing has been asked of the ledger.
    //    The CHECK constraint is the backstop for anything that reaches this table another way.
    const charged = await tx<SeasonRow[]>`
      update seasons
         set rewards_granted_wei = rewards_granted_wei + ${input.amountWei.toString()}::numeric,
             updated_at = now()
       where id = ${input.seasonId}
         and rewards_granted_wei + ${input.amountWei.toString()}::numeric <= reward_budget_wei
      returning ${tx.unsafe(SEASON_COLUMNS)}
    `
    const season = charged[0]
    if (!season) {
      const current = await tx<SeasonRow[]>`
        select ${tx.unsafe(SEASON_COLUMNS)} from seasons where id = ${input.seasonId}
      `
      const row = current[0]
      if (!row) throw new RewardError('no such season')
      const parsed = toSeason(row)
      throw new BudgetExceededError(
        parsed.id,
        parsed.rewardBudgetWei - parsed.rewardsGrantedWei,
        input.amountWei,
      )
    }

    // 2. The ledger, INSIDE the transaction, with a derived key. A crash after this and before the
    //    insert below rolls the budget back too, and the retry replays the entry rather than
    //    posting a second one.
    const entry = await deps.ledger.postEntry({
      kind: 'reward_granted',
      actor: input.actor as Parameters<LedgerClient['postEntry']>[0]['actor'],
      correlationId: input.correlationId,
      idempotencyKey: key,
      description: `worlds: ${input.reason}`,
      postings: rewardPostings({ subject: `user:${input.userId}`, amount: input.amountWei }),
    })

    // 3. The local record, naming the entry. NOT NULL in the schema, because a reward with no
    //    entry is a payment that exists only in this service's opinion.
    const rows = await tx<{ id: string }[]>`
      insert into reward_grants (
        season_id, user_id, title_id, reason, amount_wei, journal_entry_id, idempotency_key
      ) values (
        ${input.seasonId}, ${input.userId}, ${season.title_id}, ${input.reason},
        ${input.amountWei.toString()}::numeric, ${entry.id}, ${key}
      )
      returning id
    `
    const granted = rows[0]
    if (!granted) throw new Error('insert returned no row')

    emit({
      topic: REWARD_GRANTED_TOPIC,
      key: granted.id,
      payload: {
        rewardId: granted.id,
        seasonId: input.seasonId,
        titleId: season.title_id,
        userId: input.userId,
        reason: input.reason,
        amountWei: input.amountWei.toString(),
        // ══════════════════════════════════════════════════════════════════════════════════════
        // **THE ASSET IS ON THE EVENT NOW, AND THE FIGURE SAYS WHAT SCALE IT IS IN.** #226.
        //
        // This payload used to carry `amountShards` and no asset code at all, which left every
        // consumer to supply the unit from the field NAME. `activity/src/classify.ts` says what
        // that costs, and it says it about this exact topic: "A quantity with no unit is not a
        // smaller version of the truth" — so it refuses to quantify a reward until a producer
        // names the asset, and its `seasonRewardSummary` carries a deliberately dead asset-code
        // branch waiting for this field. Naming it is the producer's half of that bargain.
        //
        // The amount field is renamed in the same breath rather than kept, and the two changes
        // have to travel together. A consumer reading `amountShards` off a payload that now
        // means wei would render a figure eighteen orders of magnitude out beside the code this
        // line adds. Renaming it makes that read return nothing, and every consumer of this
        // topic degrades to a sentence that names the reward without quantifying it — which is
        // the behaviour both `activity` and `notify/src/catalogue.ts` already implement for a
        // figure they cannot safely state.
        // ══════════════════════════════════════════════════════════════════════════════════════
        assetCode: REWARD_ASSET,
        journalEntryId: entry.id,
        // The budget after this grant, on the event. An alert on "the season is nearly spent" is
        // then a subscriber rather than a query somebody has to remember to write.
        budgetRemainingWei: (
          BigInt(season.reward_budget_wei) - BigInt(season.rewards_granted_wei)
        ).toString(),
      },
      actor: input.actor,
      correlationId: input.correlationId,
    })

    return {
      id: granted.id,
      seasonId: input.seasonId,
      userId: input.userId,
      reason: input.reason,
      amountWei: input.amountWei,
      journalEntryId: entry.id,
      replayed: entry.replayed,
    }
  })
}

/** What a season has spent and what it has left. The number an operator watches. */
export async function seasonBudget(
  sql: Db,
  seasonId: string,
): Promise<{ budget: bigint; granted: bigint; remaining: bigint } | null> {
  const season = await findSeason(sql, seasonId)
  if (!season) return null
  return {
    budget: season.rewardBudgetWei,
    granted: season.rewardsGrantedWei,
    remaining: season.rewardBudgetWei - season.rewardsGrantedWei,
  }
}
