import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import { createTestDb, testUserId, type TestDb } from "./helpers/test-db";
import * as schema from "@/lib/db/schema";
import type { GenerationStatus } from "@/lib/db/schema";
import {
  reserveCredits,
  releaseCredits,
  settleGeneration,
  adminAdjust,
  grantSignupCredits,
  type DbOverride,
} from "@/lib/credits";

/**
 * Credit deduction, against a real Postgres (PGlite).
 *
 * The tests that matter here are the concurrent ones. "Deduct twice in
 * sequence" is arithmetic. "Deduct twice at the same time" is a database
 * question, and it is the question that decides whether a user can be charged
 * more than they have.
 */

let t: TestDb;
const tx = () => t.db as unknown as DbOverride;

const CREDIT = 10_000; // 1 credit in micro-credits
const USER = testUserId("credits-user");

async function seedUser(creditsMicro: number, id = USER) {
  await t.db.insert(schema.users).values({ id, email: `${id}@example.com`, credits: creditsMicro });
  return id;
}

async function balanceOf(id: string): Promise<number> {
  const [row] = await t.db.select({ credits: schema.users.credits }).from(schema.users).where(eq(schema.users.id, id));
  return row?.credits ?? -1;
}

async function ledgerOf(id: string) {
  return t.db.select().from(schema.creditLedger).where(eq(schema.creditLedger.userId, id));
}

/**
 * A real `generations` row.
 *
 * `credit_ledger.generation_id` is a real foreign key, so settling against a
 * made-up uuid fails on the constraint. That is the database doing its job, and
 * it means these tests cannot drift into asserting on behaviour that the schema
 * would never permit.
 */
async function seedGeneration(
  userId: string,
  status: GenerationStatus = "generating",
): Promise<string> {
  const [row] = await t.db
    .insert(schema.generations)
    .values({
      userId,
      type: "video",
      model: "test/model",
      prompt: "a test",
      params: {},
      status,
    })
    .returning({ id: schema.generations.id });
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDb();
}, 60_000);

afterAll(async () => {
  await t?.close();
});

beforeEach(async () => {
  await t.truncate();
});

describe("reserveCredits", () => {
  it("holds credits and writes a ledger row that matches the balance", async () => {
    await seedUser(10 * CREDIT);

    const result = await reserveCredits({ userId: USER, amount: 3 * CREDIT, metadata: { model: "x" } }, tx());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.balanceMicro).toBe(7 * CREDIT);
    expect(await balanceOf(USER)).toBe(7 * CREDIT);

    const ledger = await ledgerOf(USER);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].delta).toBe(-3 * CREDIT);
    expect(ledger[0].balanceAfter).toBe(7 * CREDIT);
    expect(ledger[0].reason).toBe("job_reserve");
  });

  it("refuses when the balance is short and changes nothing", async () => {
    await seedUser(2 * CREDIT);

    const result = await reserveCredits({ userId: USER, amount: 5 * CREDIT }, tx());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("insufficient_credits");
    expect(await balanceOf(USER)).toBe(2 * CREDIT);
    // Critically: no ledger row, so there is no phantom spend.
    expect(await ledgerOf(USER)).toHaveLength(0);
  });

  it("allows spending the balance down to exactly zero", async () => {
    await seedUser(3 * CREDIT);
    const result = await reserveCredits({ userId: USER, amount: 3 * CREDIT }, tx());
    expect(result.ok).toBe(true);
    expect(await balanceOf(USER)).toBe(0);
  });

  // ---- the concurrency tests -------------------------------------------

  it("does not overdraw when two spends race", async () => {
    // 10 credits, two concurrent 8-credit spends. One must win.
    await seedUser(10 * CREDIT);

    const [a, b] = await Promise.all([
      reserveCredits({ userId: USER, amount: 8 * CREDIT }, tx()),
      reserveCredits({ userId: USER, amount: 8 * CREDIT }, tx()),
    ]);

    const succeeded = [a, b].filter((r) => r.ok).length;
    expect(succeeded).toBe(1);
    expect(await balanceOf(USER)).toBe(2 * CREDIT);
    expect(await ledgerOf(USER)).toHaveLength(1);
  });

  it("does not overdraw when eight spends race", async () => {
    await seedUser(3 * CREDIT);

    const results = await Promise.all(
      Array.from({ length: 8 }, () => reserveCredits({ userId: USER, amount: CREDIT }, tx())),
    );

    const succeeded = results.filter((r) => r.ok).length;
    expect(succeeded).toBe(3);
    expect(await balanceOf(USER)).toBe(0);
    // Never negative, and one ledger row per successful spend.
    expect(await ledgerOf(USER)).toHaveLength(3);
  });

  it("never lets the balance go negative, even with 20 racing spends", async () => {
    await seedUser(5 * CREDIT);

    await Promise.all(
      Array.from({ length: 20 }, () => reserveCredits({ userId: USER, amount: CREDIT }, tx())),
    );

    expect(await balanceOf(USER)).toBe(0);
    expect(await ledgerOf(USER)).toHaveLength(5);
  });

  it("the ledger reconciles to the balance", async () => {
    await seedUser(20 * CREDIT);
    for (let i = 0; i < 6; i++) {
      await reserveCredits({ userId: USER, amount: 2 * CREDIT }, tx());
    }
    await releaseCredits({ userId: USER, amount: 3 * CREDIT, reason: "job_refund" }, tx());

    const ledger = await ledgerOf(USER);
    const delta = ledger.reduce((acc, row) => acc + row.delta, 0);

    // The ledger records *movement*, not the balance. The opening 20 credits
    // were seeded directly rather than granted through the ledger, so the
    // reconciliation is opening + sum(deltas) == balance.
    expect(delta).toBe(-12 * CREDIT + 3 * CREDIT);
    expect(20 * CREDIT + delta).toBe(await balanceOf(USER));

    // And each row's balanceAfter must equal opening + running sum, which is
    // what makes the ledger auditable without trusting the users table.
    const OPENING = 20 * CREDIT;
    let running = OPENING;
    for (const row of ledger) {
      running += row.delta;
      expect(row.balanceAfter).toBe(running);
    }
  });

  // ---- limits -----------------------------------------------------------

  it("enforces the concurrency limit", async () => {
    await seedUser(100 * CREDIT);
    // Two in-flight jobs means the third is refused, even with credits to spare.
    for (let i = 0; i < 2; i++) {
      await t.db.insert(schema.generations).values({
        userId: USER,
        type: "video",
        model: "test/model",
        prompt: "p",
        params: {},
        status: "generating",
      });
    }

    const result = await reserveCredits({ userId: USER, amount: CREDIT }, tx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("concurrent_limit");
  });

  it("counts only non-terminal jobs toward the concurrency limit", async () => {
    await seedUser(100 * CREDIT);
    for (const status of ["completed", "failed", "cancelled", "expired"] as const) {
      await t.db.insert(schema.generations).values({
        userId: USER,
        type: "video",
        model: "test/model",
        prompt: "p",
        params: {},
        status,
      });
    }

    const result = await reserveCredits({ userId: USER, amount: CREDIT }, tx());
    expect(result.ok).toBe(true);
  });

  it("enforces the rate limit and counts it in the window", async () => {
    await seedUser(1000 * CREDIT);
    const windowStart = new Date();
    windowStart.setMinutes(0, 0, 0);

    // Pre-load the window to the limit.
    await t.db.insert(schema.rateLimits).values({
      userId: USER,
      windowStart,
      count: 10,
    });

    const result = await reserveCredits({ userId: USER, amount: CREDIT }, tx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("rate_limited");
    // And it must not have taken the money.
    expect(await balanceOf(USER)).toBe(1000 * CREDIT);
  });

  it("does not count a rate-limited attempt against the user", async () => {
    await seedUser(1000 * CREDIT);
    const windowStart = new Date();
    windowStart.setMinutes(0, 0, 0);
    await t.db.insert(schema.rateLimits).values({
      userId: USER,
      windowStart,
      count: 99,
    });

    await reserveCredits({ userId: USER, amount: CREDIT }, tx());

    const [row] = await t.db.select().from(schema.rateLimits);
    expect(row?.count).toBe(99);
  });
});

describe("settleGeneration", () => {
  it("refunds the difference when the actual cost is lower", async () => {
    await seedUser(10 * CREDIT);
    const job = await seedGeneration(USER);
    await reserveCredits({ userId: USER, amount: 5 * CREDIT, generationId: job }, tx());

    const settled = await settleGeneration(
      {
        userId: USER,
        generationId: job,
        heldMicro: 5 * CREDIT,
        actualUsd: 0.02, // 2 credits
      },
      tx(),
    );

    expect(settled.chargedMicro).toBe(2 * CREDIT);
    expect(settled.refundedMicro).toBe(3 * CREDIT);
    // Net cost is 2 credits: started at 10, held 5, refunded 3.
    expect(await balanceOf(USER)).toBe(8 * CREDIT);

    // Both legs must be on the ledger: the hold and the reconciliation.
    const ledger = await ledgerOf(USER);
    expect(ledger.map((r) => r.reason)).toEqual(["job_reserve", "job_reconcile"]);
  });

  it("charges the extra when per-token pricing exceeded the ceiling", async () => {
    await seedUser(10 * CREDIT);
    const job = await seedGeneration(USER);
    await reserveCredits({ userId: USER, amount: 2 * CREDIT, generationId: job }, tx());

    const settled = await settleGeneration(
      {
        userId: USER,
        generationId: job,
        heldMicro: 2 * CREDIT,
        actualUsd: 0.05, // 5 credits, more than the 2 held
      },
      tx(),
    );

    expect(settled.chargedMicro).toBe(5 * CREDIT);
    expect(settled.refundedMicro).toBe(0);
    // Net cost is 5 credits.
    expect(await balanceOf(USER)).toBe(5 * CREDIT);

    // The overage is a negative release, recorded rather than absorbed.
    const reconcile = (await ledgerOf(USER)).find((r) => r.reason === "job_reconcile");
    expect(reconcile?.delta).toBe(-3 * CREDIT);
  });

  it("refunds the whole hold when there is no cost (a failure)", async () => {
    await seedUser(10 * CREDIT);
    const job = await seedGeneration(USER);
    await reserveCredits({ userId: USER, amount: 4 * CREDIT, generationId: job }, tx());

    await settleGeneration(
      { userId: USER, generationId: job, heldMicro: 4 * CREDIT, actualUsd: 0 },
      tx(),
    );

    expect(await balanceOf(USER)).toBe(10 * CREDIT);
  });

  it("holds the full amount when the real cost is unknown", async () => {
    await seedUser(10 * CREDIT);
    const job = await seedGeneration(USER);
    await reserveCredits({ userId: USER, amount: 3 * CREDIT, generationId: job }, tx());

    const settled = await settleGeneration(
      { userId: USER, generationId: job, heldMicro: 3 * CREDIT, actualUsd: null },
      tx(),
    );

    // Unknown cost must not become a free job, and must not lose the hold.
    expect(await balanceOf(USER)).toBe(7 * CREDIT);
    expect(settled.refundedMicro).toBe(0);
    // ...and must not write a meaningless zero-value reconciliation row either.
    expect((await ledgerOf(USER)).filter((r) => r.reason === "job_reconcile")).toHaveLength(0);
  });
});

describe("ledger integrity", () => {
  /**
   * Drizzle wraps a driver error in its own `DrizzleQueryError`, whose message is
   * "Failed query: <sql>" and which carries the real Postgres message on
   * `cause`. Asserting on the outer message would pass for *any* failure,
   * including a typo in the SQL, so these tests walk the chain to prove the
   * *trigger* is what stopped the write.
   */
  async function expectTriggerRejection(fn: () => Promise<unknown>, operation: string) {
    let error: unknown;
    try {
      await fn();
    } catch (e) {
      error = e;
    }
    expect(error, "expected the statement to be rejected").toBeInstanceOf(Error);

    const chain: string[] = [];
    for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
      chain.push(e.message);
    }
    const text = chain.join("\n");
    // Only this trigger emits this wording, so matching it proves the trigger
    // fired rather than some unrelated constraint.
    expect(text).toMatch(/credit_ledger is append-only/i);
    // It interpolates TG_OP, so the rejection names the offending statement.
    expect(text).toContain(operation);
  }

  it("rejects UPDATE on the ledger", async () => {
    await seedUser(5 * CREDIT);
    await reserveCredits({ userId: USER, amount: CREDIT }, tx());

    await expectTriggerRejection(
      () => t.db.execute(sql`UPDATE credit_ledger SET delta = 999999 WHERE user_id = ${USER}::uuid`),
      "UPDATE",
    );
  });

  it("rejects DELETE on the ledger", async () => {
    await seedUser(5 * CREDIT);
    await reserveCredits({ userId: USER, amount: CREDIT }, tx());

    await expectTriggerRejection(
      () => t.db.execute(sql`DELETE FROM credit_ledger WHERE user_id = ${USER}::uuid`),
      "DELETE",
    );
  });

  it("refuses a negative balance even if application code asks for one", async () => {
    await seedUser(1 * CREDIT);
    // Bypass reserveCredits entirely and go straight for a raw negative write.
    await expect(
      t.db.execute(sql`UPDATE users SET credits = -500 WHERE id = ${USER}::uuid`),
    ).rejects.toThrow();
    expect(await balanceOf(USER)).toBe(1 * CREDIT);
  });

  it("rejects a zero-value ledger row", async () => {
    await seedUser(5 * CREDIT);
    await expect(
      t.db.insert(schema.creditLedger).values({
        userId: USER,
        delta: 0,
        reason: "job_refund",
        balanceAfter: 5 * CREDIT,
      }),
    ).rejects.toThrow();
  });
});

describe("adminAdjust", () => {
  it("topping up writes a ledger row", async () => {
    await seedUser(1 * CREDIT);

    const result = await adminAdjust({
      userId: USER,
      deltaMicro: 10 * CREDIT,
      adminId: "admin-1",
      note: "goodwill",
    }, tx());

    expect(result.ok).toBe(true);
    expect(await balanceOf(USER)).toBe(11 * CREDIT);

    const ledger = await ledgerOf(USER);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].reason).toBe("admin_topup");
  });

  it("refuses an adjustment that would go negative", async () => {
    await seedUser(1 * CREDIT);

    const result = await adminAdjust({
      userId: USER,
      deltaMicro: -50 * CREDIT,
      adminId: "admin-1",
    }, tx());

    expect(result.ok).toBe(false);
    expect(await balanceOf(USER)).toBe(1 * CREDIT);
    expect(await ledgerOf(USER)).toHaveLength(0);
  });

  it("refuses a zero adjustment", async () => {
    await seedUser(1 * CREDIT);
    const result = await adminAdjust({ userId: USER, deltaMicro: 0, adminId: "a" }, tx());
    expect(result.ok).toBe(false);
  });
});

describe("grantSignupCredits", () => {
  it("creates the user and grants once", async () => {
    const id = testUserId("signup-user");

    await grantSignupCredits(id, "new@example.com", tx());

    const balance = await balanceOf(id);
    expect(balance).toBeGreaterThan(0);
    expect(await ledgerOf(id)).toHaveLength(1);
  });

  it("does not double-grant on a second call", async () => {
    const id = testUserId("signup-user-2");

    await grantSignupCredits(id, "again@example.com", tx());
    const first = await balanceOf(id);
    await grantSignupCredits(id, "again@example.com", tx());
    const second = await balanceOf(id);

    expect(second).toBe(first);
    expect(await ledgerOf(id)).toHaveLength(1);
  });

  it("does not race when two first-requests arrive together", async () => {
    const id = testUserId("signup-user-3");

    await Promise.all([
      grantSignupCredits(id, "race@example.com", tx()),
      grantSignupCredits(id, "race@example.com", tx()),
      grantSignupCredits(id, "race@example.com", tx()),
    ]);

    expect(await ledgerOf(id)).toHaveLength(1);
  });
});