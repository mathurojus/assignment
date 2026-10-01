import { sql } from "drizzle-orm";
import { requireDb, schema } from "./db";
import { MICRO, MICRO_PER_CREDIT } from "./db/schema";
import { env } from "@/lib/env";
import { usdToCreditsMicro } from "@/lib/openrouter/pricing";

/**
 * Credit accounting.
 *
 * ---------------------------------------------------------------------------
 * WHY THE ADVISORY LOCK IS HERE
 * ---------------------------------------------------------------------------
 * Video generation is expensive, so two users' requests must not be able to
 * read the same balance, both decide they can afford it, and both spend it.
 * Every money-moving path here runs inside a transaction that begins with
 *
 *     SELECT pg_advisory_xact_lock(hashtext($userId))
 *
 * That serialises all credit and concurrency operations for one user. It is
 * taken first, released automatically at commit or rollback, and needs no
 * cleanup path. Two concurrent submits therefore execute one after the other,
 * and the second sees the first's committed balance.
 *
 * A conditional UPDATE alone would not be enough, because the *concurrency
 * check* (how many jobs are in flight) is a separate read that the UPDATE does
 * not cover. Without the lock, both requests count zero running jobs and both
 * proceed.
 */

export type DebitResult =
  | { ok: true; balanceMicro: number }
  | { ok: false; reason: "insufficient_credits" | "concurrent_limit" | "rate_limited" | "spend_cap" | "user_missing"; detail?: string };

export interface ReserveInput {
  userId: string;
  /** micro-credits to hold. */
  amount: number;
  generationId?: string;
  costEstimateMicro?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Hold credits for a job, enforcing every limit at once, atomically.
 *
 * The order of checks matters. Rate limit and concurrency are checked before
 * balance, because a user who is being throttled should be told that rather
 * than told they are poor, and neither check should have the side effect of
 * reserving money.
 */
export async function reserveCredits(input: ReserveInput): Promise<DebitResult> {
  const db = requireDb();
  const { userId, amount } = input;
  if (amount <= 0) return { ok: true, balanceMicro: 0 };

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    const [user] = await tx
      .select({
        id: schema.users.id,
        credits: schema.users.credits,
      })
      .from(schema.users)
      .where(sql`${schema.users.id} = ${userId}::uuid`)
      .limit(1);

    if (!user) return { ok: false, reason: "user_missing" as const };

    // --- rate limit: fixed window, current hour --------------------------
    const windowStart = new Date();
    windowStart.setMinutes(0, 0, 0);

    const [limit] = await tx
      .select()
      .from(schema.rateLimits)
      .where(
        sql`${schema.rateLimits.userId} = ${userId}::uuid AND ${schema.rateLimits.windowStart} = ${windowStart.toISOString()}`,
      )
      .limit(1);

    const used = limit?.count ?? 0;
    if (used >= env.RATE_LIMIT_JOBS_PER_HOUR) {
      return {
        ok: false,
        reason: "rate_limited" as const,
        detail: `Limit of ${env.RATE_LIMIT_JOBS_PER_HOUR} jobs per hour reached. Try again in a few minutes.`,
      };
    }

    // --- concurrency ------------------------------------------------------
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.generations)
      .where(
        sql`${schema.generations.userId} = ${userId}::uuid AND ${schema.generations.status} in ('queued','submitting','generating','downloading')`,
      );

    if ((count ?? 0) >= env.MAX_CONCURRENT_JOBS_PER_USER) {
      return {
        ok: false,
        reason: "concurrent_limit" as const,
        detail: `You already have ${count} job${count === 1 ? "" : "s"} running. The limit is ${env.MAX_CONCURRENT_JOBS_PER_USER} at once.`,
      };
    }

    // --- global daily spend cap ------------------------------------------
    // Estimated spend for today, plus anything already held by running jobs.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const capMicro = Math.round(env.GLOBAL_DAILY_SPEND_CAP_USD * MICRO);

    const [{ spent }] = await tx
      .select({ spent: sql<number>`coalesce((SELECT ${schema.dailySpend.spentMicro} FROM ${schema.dailySpend} WHERE ${schema.dailySpend.day} = ${today.toISOString()}), 0)::bigint` });

    const estimate = input.costEstimateMicro ?? 0;
    if (capMicro > 0 && Number(spent) + estimate > capMicro) {
      return {
        ok: false,
        reason: "spend_cap" as const,
        detail: `The service-wide daily generation cap ($${env.GLOBAL_DAILY_SPEND_CAP_USD}) has been reached. Try again tomorrow.`,
      };
    }

    // --- balance ----------------------------------------------------------
    // The conditional UPDATE is the actual debit. It is one statement, so it is
    // atomic even without the lock; the lock is what makes the checks above
    // consistent. The CHECK constraint on users.credits is the last backstop.
    if (user.credits < amount) {
      return {
        ok: false,
        reason: "insufficient_credits" as const,
        detail: `This needs ${(amount / MICRO_PER_CREDIT).toFixed(2)} credits and you have ${(user.credits / MICRO_PER_CREDIT).toFixed(2)}.`,
      };
    }

    const [updated] = await tx
      .update(schema.users)
      .set({ credits: sql`${schema.users.credits} - ${amount}`, updatedAt: new Date() })
      .where(sql`${schema.users.id} = ${userId}::uuid AND ${schema.users.credits} >= ${amount}`)
      .returning({ credits: schema.users.credits });

    // The WHERE guard lost the race, which the lock should have prevented.
    // If it happens anyway, the CHECK constraint is the backstop.
    if (!updated) {
      return { ok: false, reason: "insufficient_credits" as const };
    }

    await tx.insert(schema.creditLedger).values({
      userId,
      generationId: input.generationId,
      delta: -amount,
      reason: "job_reserve",
      balanceAfter: updated.credits,
      metadata: input.metadata ?? {},
    });

    await tx
      .insert(schema.rateLimits)
      .values({ userId, windowStart: windowStart.toISOString(), count: used + 1 })
      .onConflictDoUpdate({
        target: [schema.rateLimits.userId, schema.rateLimits.windowStart],
        set: { count: used + 1 },
      });

    if (capMicro > 0 && estimate > 0) {
      await tx
        .insert(schema.dailySpend)
        .values({ day: today.toISOString(), spentMicro: estimate })
        .onConflictDoUpdate({
          target: schema.dailySpend.day,
          set: {
            spentMicro: sql`${schema.dailySpend.spentMicro} + ${estimate}`,
            updatedAt: new Date(),
          },
        });
    }

    return { ok: true, balanceMicro: updated.credits };
  });
}

/**
 * Return held credits. Used on failure, cancel, expiry, and for the difference
 * between estimate and actual cost.
 *
 * `ledger` is always written. A refund that only changes the balance is
 * invisible when someone later asks "why did this user lose 40 credits".
 */
export async function releaseCredits(input: {
  userId: string;
  amount: number;
  generationId?: string;
  reason: "job_refund" | "job_reconcile";
  metadata?: Record<string, unknown>;
}): Promise<number | null> {
  const db = requireDb();
  const { userId, amount } = input;
  if (amount <= 0) return null;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    const [updated] = await tx
      .update(schema.users)
      .set({ credits: sql`${schema.users.credits} + ${amount}`, updatedAt: new Date() })
      .where(sql`${schema.users.id} = ${userId}::uuid`)
      .returning({ credits: schema.users.credits });

    if (!updated) return null;

    await tx.insert(schema.creditLedger).values({
      userId,
      generationId: input.generationId,
      delta: amount,
      reason: input.reason,
      balanceAfter: updated.credits,
      metadata: input.metadata ?? {},
    });

    return updated.credits;
  });
}

/**
 * Settle a finished job: charge what it actually cost, refund the difference.
 *
 * Reconciliation rather than "charge the estimate and hope". A user who is
 * quoted $0.05 and billed $0.012 should end up 0.038 credits richer, and the
 * ledger should show both the hold and the refund.
 */
export async function settleGeneration(input: {
  userId: string;
  generationId: string;
  heldMicro: number;
  actualUsd: number | null;
  metadata?: Record<string, unknown>;
}): Promise<{ chargedMicro: number; refundedMicro: number; balanceMicro: number | null }> {
  const actualMicro =
    input.actualUsd === null ? input.heldMicro : Math.round(input.actualUsd * MICRO);
  const creditsCharged = usdToCreditsMicro(input.actualUsd ?? 0);

  // What the hold was worth, in credits. Anything the actual cost did not use
  // goes back.
  const refund = Math.max(0, input.heldMicro - creditsCharged);
  const extraCharge = Math.max(0, creditsCharged - input.heldMicro);

  let balanceMicro: number | null = null;

  if (refund > 0) {
    balanceMicro = await releaseCredits({
      userId: input.userId,
      amount: refund,
      generationId: input.generationId,
      reason: "job_reconcile",
      metadata: { ...input.metadata, heldMicro: input.heldMicro, actualMicro },
    });
  } else if (extraCharge > 0) {
    // The real cost exceeded the reservation. This is possible on per-token
    // pricing. Take it rather than letting the user underpay silently.
    balanceMicro = await releaseCredits({
      userId: input.userId,
      amount: -extraCharge,
      generationId: input.generationId,
      reason: "job_reconcile",
      metadata: { ...input.metadata, heldMicro: input.heldMicro, actualMicro },
    });
  }

  return { chargedMicro: creditsCharged, refundedMicro: refund, balanceMicro };
}

/** Grant credits at signup. Idempotent per user so a re-provision cannot double-grant. */
export async function grantSignupCredits(userId: string, email: string): Promise<number> {
  const db = requireDb();
  const amount = Math.round(env.FREE_STARTING_CREDITS * MICRO_PER_CREDIT);
  if (amount <= 0) return 0;

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${userId}))`);

    // Provision the user if the trigger has not already done it.
    const [existing] = await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(sql`${schema.users.id} = ${userId}::uuid`)
      .limit(1);

    if (existing) {
      // Already provisioned. The database trigger handles the grant, so there
      // is nothing to do here. Re-running must not mint credits.
      const [u] = await tx
        .select({ credits: schema.users.credits })
        .from(schema.users)
        .where(sql`${schema.users.id} = ${userId}::uuid`)
        .limit(1);
      return u?.credits ?? 0;
    }

    const [inserted] = await tx
      .insert(schema.users)
      .values({
        id: userId,
        email,
        credits: amount,
        isAdmin: env.ADMIN_EMAILS.some((e) => e.toLowerCase() === email.toLowerCase()),
      })
      .returning({ credits: schema.users.credits });

    await tx.insert(schema.creditLedger).values({
      userId,
      delta: amount,
      reason: "signup_grant",
      balanceAfter: inserted.credits,
      metadata: { source: "signup" },
    });

    return inserted.credits;
  });
}

/** Admin credit adjustment. Always writes a ledger row. */
export async function adminAdjust(input: {
  userId: string;
  deltaMicro: number;
  adminId: string;
  note?: string;
}): Promise<{ ok: boolean; balanceMicro?: number; error?: string }> {
  const db = requireDb();
  if (input.deltaMicro === 0) return { ok: false, error: "Adjustment must be non-zero." };

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.userId}))`);

    const [updated] = await tx
      .update(schema.users)
      .set({ credits: sql`${schema.users.credits} + ${input.deltaMicro}`, updatedAt: new Date() })
      .where(sql`${schema.users.id} = ${input.userId}::uuid AND ${schema.users.credits} + ${input.deltaMicro} >= 0`)
      .returning({ credits: schema.users.credits });

    if (!updated) {
      return { ok: false, error: "User not found, or the adjustment would make their balance negative." };
    }

    await tx.insert(schema.creditLedger).values({
      userId: input.userId,
      delta: input.deltaMicro,
      reason: input.deltaMicro > 0 ? "admin_topup" : "admin_adjust",
      balanceAfter: updated.credits,
      metadata: { adminId: input.adminId, note: input.note ?? null },
    });

    return { ok: true, balanceMicro: updated.credits };
  });
}