/**
 * Right to erasure — `identity.user.deleted`, handled.
 *
 * Rule 6 of docs/ecosystem/03 §2: every service storing a `user_id` subscribes to this event and
 * erases. This service stores one in six places and stored NONE of them on request until now
 * (micro-org#491). A deletion elsewhere in the estate reported success while every profile,
 * inventory item, achievement and reward grant here stood untouched — including `age_bracket` and
 * `parental_controls`, which are the two columns in this schema most obviously about a child.
 *
 * ## Why some rows are kept
 *
 * "Delete everything" is not available and "blank the names" is not compliance, so every table
 * gets a decision and the decision is written down here rather than in a document that can drift
 * away from the code. Two rows are retained, both for reasons Article 17(3) actually names, and
 * both are narrowed to the identifier rather than kept whole.
 *
 * ## The placeholder
 *
 * ONE random uuid per erasure, from `randomUUID()`, never derived from the real id. A hash of a
 * uuid is not an anonymisation: the candidate space is whatever list of users an attacker already
 * has, and checking it is one hash each. Nothing anywhere stores the mapping, so the placeholder
 * is a dead end by construction.
 *
 * It is REUSED across the rows this erasure retains, which is the same declared tradeoff
 * `aetherholm/src/erasure.ts` makes: the retained rows stay linked to one another. That is
 * unavoidable once anything is retained at all — a grant's season, amount and timestamp link it to
 * its neighbours regardless of what the id column says.
 *
 * `provisions.subject` carries billing's spelling (`user:<uuid>`, see `userIdOf`), so it takes
 * `erased:<the same uuid>`; every bare-`uuid` column takes the uuid itself.
 *
 * ## The decisions
 *
 * | table                  | action    | reasoning, and the lawful basis where a row is kept |
 * | ---------------------- | --------- | --------------------------------------------------- |
 * | `player_profiles`      | DELETE    | The personal record itself: a chosen display name, an avatar, reputation, sanctions, `age_bracket` and `parental_controls`. Nothing in this schema references it — no foreign key points here — so nothing else is diminished by its going, and no basis to keep any of it survives the request. Deleted whole. |
 * | `player_achievements`  | DELETE    | Pure personal progress: which achievements this person unlocked. The `achievements` rows themselves are catalogue, are not personal data, and are untouched. |
 * | `inventory_items`      | DELETE    | Personal property. A row may be LISTED (`listed_at`/`listing_urn`), and deleting it leaves the market holding a listing whose item no longer exists — which is correct rather than unfortunate: the seller has gone, and a listing that could still be bought would be selling a departed person's possessions. micro-market's own erasure handles its side. |
 * | `reward_grants`        | ANONYMISE | Retained. `journal_entry_id` ties the row to a posting in the ledger and `reward_grants_key_uniq` is what stops one season's reward being granted twice; dropping the row would break the link between a ledger entry and its cause and re-open the double-grant. Basis: Art. 17(3)(b) — a financial record the platform is obliged to keep. Only `user_id` is personal data here: the season, title, reason and amount are facts about a grant, not about a person. |
 * | `provisions`           | ANONYMISE | Retained for the same reason `aetherholm` retains its copy: this is the entitlement idempotency record, unique on `entitlement_id`, and losing it turns one purchase into two provisions. `subject` takes the erased spelling and `metadata` is swept for the raw id; the entitlement, sku, scope and urn stay. Basis: Art. 17(3)(b). `lease_owner` is NOT touched — it is the worker instance holding the provisioning lease (`provisioning.ts` writes `input.owner`), not a person. |
 * | `outbox`               | REDACT    | The outbound delivery journal. Published rows have discharged their purpose but are retained as an audit trail, and unpublished ones must still be delivered — so the id is swept out of `key`, `actor` and `payload` in place rather than the rows being dropped, which would lose an undelivered event. Every subscriber is erasing the same person on the same signal. |
 * | `inbox`, `jobs`        | —         | Neither holds a user id: the inbox is `(topic, event_id)` and every job payload keys on a provision or a title. Asserted, not assumed — `erasure.test.ts` sweeps every table in the schema for the raw uuid, which is the check that catches the column this table forgot. |
 * | `titles`, `seasons`, `achievements` | — | Catalogue and geography. No user id in any of them. |
 *
 * ## What this does NOT do
 *
 * It does not touch a title's own store. Aetherholm keeps its cities and battles in its own
 * database and erases them on the same event, which is why both services subscribe rather than one
 * calling the other: a fan-out that depended on this service reaching every title would fail
 * silently the day a title was down, and an erasure that fails silently is the worst kind.
 */

import { randomUUID } from 'node:crypto'
import type { Tx } from './outbox.ts'

export const USER_DELETED_TOPIC = 'identity.user.deleted'

export interface ErasureOutcome {
  readonly profiles: number
  readonly achievements: number
  readonly inventory: number
  readonly grants: number
  readonly provisions: number
  readonly outbox: number
}

/**
 * Erase one user, in one transaction.
 *
 * Counts are returned rather than logged here, and the caller logs the counts and never the id —
 * writing the erased id into a log would recreate, in the one store nothing erases, exactly what
 * the request was to remove.
 */
export async function eraseUser(tx: Tx, userId: string): Promise<ErasureOutcome> {
  const placeholder = randomUUID()
  const erasedSubject = `erased:${placeholder}`
  const subject = `user:${userId}`
  // For the jsonb and text sweeps. The id is a uuid, so a substring match cannot catch a shorter
  // string by accident, and matching ANYWHERE is the point: a payload may nest it at any depth.
  const anywhere = `%${userId}%`

  /* ------------------------------------------------------------------ deleted outright */

  const profiles = await tx`delete from player_profiles where user_id = ${userId} returning 1`
  const achievements = await tx`delete from player_achievements where user_id = ${userId} returning 1`
  const inventory = await tx`delete from inventory_items where user_id = ${userId} returning 1`

  /* ------------------------------------------------------------------ retained, narrowed */

  // The ledger link and the double-grant guard survive; the person does not. See the table above.
  const grants = await tx`
    update reward_grants set user_id = ${placeholder} where user_id = ${userId} returning 1
  `

  // `subject` is billing's spelling; `metadata` is swept because the bridge copies the entitlement
  // payload into it verbatim and that payload names the buyer.
  const provisions = await tx`
    update provisions
       set subject  = ${erasedSubject},
           metadata = replace(metadata::text, ${userId}, ${placeholder})::jsonb,
           updated_at = now()
     where subject = ${subject} or metadata::text like ${anywhere}
    returning 1
  `

  /* ------------------------------------------------------------------ redacted in place */

  // Rows are NOT dropped: an unpublished row still has to be delivered, and dropping it would lose
  // the event rather than anonymise it.
  const outbox = await tx`
    update outbox
       set key     = replace(key, ${userId}, ${placeholder}),
           actor   = case when actor is null then null else replace(actor, ${userId}, ${placeholder}) end,
           payload = replace(payload::text, ${userId}, ${placeholder})::jsonb
     where key like ${anywhere} or actor like ${anywhere} or payload::text like ${anywhere}
    returning 1
  `

  return {
    profiles: profiles.length,
    achievements: achievements.length,
    inventory: inventory.length,
    grants: grants.length,
    provisions: provisions.length,
    outbox: outbox.length,
  }
}
