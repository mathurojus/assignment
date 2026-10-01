import { desc, sql } from "drizzle-orm";
import { requireDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok } from "@/lib/api";
import { fromMicro, creditsMicroToDisplay } from "@/lib/openrouter/pricing";
import { isDatabaseUnavailable } from "@/lib/db";

/**
 * Admin overview: what has been generated, what it cost, and who is spending.
 *
 * Read-only. The one mutating admin action is a credit adjustment, and it lives
 * in `POST /api/admin/credits` because that action needs its own confirmation
 * flow.
 */
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return apiError("unauthorized", "Sign in first.");
  if (!user.isAdmin) return apiError("forbidden", "This area is for administrators.");

  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") ?? "overview";

  const db = requireDb();

  try {
    if (tab === "users") {
      const rows = await db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          name: schema.users.name,
          credits: schema.users.credits,
          isAdmin: schema.users.isAdmin,
          createdAt: schema.users.createdAt,
          spendBlockedUntil: schema.users.spendBlockedUntil,
          jobCount: sql<number>`(
            SELECT count(*)::int FROM ${schema.generations}
            WHERE ${schema.generations.userId} = ${schema.users.id}
          )`,
          totalSpendUsd: sql<number>`coalesce((
            SELECT sum(-${schema.creditLedger.delta}) FROM ${schema.creditLedger}
            WHERE ${schema.creditLedger.userId} = ${schema.users.id}
              AND ${schema.creditLedger.delta} < 0
          ), 0)`,
        })
        .from(schema.users)
        // Largest spender first. That is who an operator needs to see when the
        // OpenRouter bill is the thing they are looking at.
        .orderBy(desc(sql`coalesce((
            SELECT sum(-${schema.creditLedger.delta}) FROM ${schema.creditLedger}
            WHERE ${schema.creditLedger.userId} = ${schema.users.id}
              AND ${schema.creditLedger.delta} < 0
          ), 0)`))
        .limit(100);

      return ok({
        users: rows.map((r) => ({
          id: r.id,
          email: r.email,
          name: r.name,
          credits: creditsMicroToDisplay(r.credits),
          isAdmin: r.isAdmin,
          jobCount: r.jobCount,
          totalSpendUsd: fromMicro(r.totalSpendUsd),
          createdAt: r.createdAt,
          spendBlockedUntil: r.spendBlockedUntil,
        })),
      });
    }

    if (tab === "ledger") {
      const rows = await db
        .select()
        .from(schema.creditLedger)
        .orderBy(desc(schema.creditLedger.createdAt), desc(schema.creditLedger.id))
        .limit(200);

      return ok({
        entries: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          generationId: r.generationId,
          delta: r.delta,
          deltaCredits: creditsMicroToDisplay(r.delta),
          reason: r.reason,
          balanceAfter: creditsMicroToDisplay(r.balanceAfter),
          metadata: r.metadata,
          createdAt: r.createdAt,
        })),
      });
    }

    if (tab === "jobs") {
      const rows = await db
        .select()
        .from(schema.generations)
        .orderBy(desc(schema.generations.createdAt))
        .limit(100);

      return ok({
        jobs: rows.map((r) => ({
          id: r.id,
          userId: r.userId,
          model: r.model,
          status: r.status,
          error: r.error,
          attempts: r.attempts,
          estimateUsd: fromMicro(r.costEstimateMicro),
          actualUsd: r.costActualMicro == null ? null : fromMicro(r.costActualMicro),
          createdAt: r.createdAt,
          completedAt: r.completedAt,
        })),
      });
    }

    // ---- overview -------------------------------------------------------
    const statusRows = (await db.execute<{ status: string; count: number }>(sql`
      SELECT status, count(*)::int AS count
      FROM ${schema.generations}
      GROUP BY status
    `)) as unknown as Array<{ status: string; count: number }>;

    const [money] = await db.execute<{ spent: number; held: number }>(sql`
      SELECT
        coalesce(sum(${schema.dailySpend.spentMicro}), 0)::bigint AS spent,
        coalesce((
          SELECT sum(${schema.generations.creditsHeld})
          FROM ${schema.generations}
          WHERE ${schema.generations.status} IN ('queued','submitting','generating','downloading')
        ), 0)::bigint AS held
      FROM ${schema.dailySpend}
      WHERE ${schema.dailySpend.day} >= date_trunc('day', now())
    `);

    const [userCount] = await db.execute<{ count: number }>(sql`
      SELECT count(*)::int AS count FROM ${schema.users}
    `);

    return ok({
      totals: {
        users: userCount?.count ?? 0,
        spentTodayUsd: fromMicro(Number(money?.spent ?? 0)),
        // Credits currently reserved across in-flight jobs. `daily_spend` only
        // records settled spend, so reservations can only come from here.
        creditsHeldMicro: Number(money?.held ?? 0),
        creditsHeld: creditsMicroToDisplay(Number(money?.held ?? 0)),
      },
      byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
      tabs: ["overview", "jobs", "users", "ledger"],
    });
  } catch (error) {
    if (isDatabaseUnavailable(error)) return apiError("database_unavailable", error.message);
    throw error;
  }
}