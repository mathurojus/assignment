import { desc, sql } from "drizzle-orm";
import { requireDb, schema } from "@/lib/db";
import { fromMicro, creditsMicroToDisplay } from "@/lib/openrouter/pricing";

/**
 * The operator's queries.
 *
 * Shared by `/admin` (server-rendered) and `/api/admin/stats` (JSON), for the same
 * reason the gallery is shared: an admin page that fetches its own API route pays a
 * function invocation and a network round trip to render the numbers, and the two
 * copies of the SQL would drift.
 *
 * Every function here is read-only except `adjust`, which delegates to
 * `adminAdjust` in `@/lib/credits` -- the one place that is allowed to write to the
 * ledger.
 */

export interface AdminTotals {
  users: number;
  spentTodayUsd: number;
  /** Credits reserved by jobs that have not settled. */
  creditsHeld: number;
  creditsHeldMicro: number;
  /** Sum of the counts, so the page does not have to know the status enum. */
  byStatus: Record<string, number>;
}

export async function adminOverview(): Promise<AdminTotals> {
  const db = requireDb();

  const statusRows = (await db.execute<{ status: string; count: number }>(sql`
    SELECT status, count(*)::int AS count
    FROM ${schema.generations}
    GROUP BY status
  `)) as unknown as Array<{ status: string; count: number }>;

  const [money] = await db.execute<{ spent: string; held: string }>(sql`
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

  // `bigint` comes back from `postgres-js` as a string, not a number: it does not
  // fit in a JS number for a large ledger and silently losing the low digits is
  // worse than parsing it. `fromMicro` then works on a real number.
  const held = Number(money?.held ?? 0);

  return {
    users: userCount?.count ?? 0,
    spentTodayUsd: fromMicro(Number(money?.spent ?? 0)),
    creditsHeldMicro: held,
    creditsHeld: creditsMicroToDisplay(held),
    byStatus: Object.fromEntries(statusRows.map((r) => [r.status, r.count])),
  };
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string | null;
  credits: number;
  isAdmin: boolean;
  createdAt: string;
  spendBlockedUntil: string | null;
  jobCount: number;
  totalSpendUsd: number;
}

/**
 * Every account, largest spender first.
 *
 * That ordering is the whole point: an operator looking at an OpenRouter bill wants
 * to know who is spending it, not who signed up first.
 *
 * Capped at 200 rows with a comment saying so. This is a browse list, not an
 * export -- a genuinely large instance needs a paginated export, and pretending
 * otherwise would mean shipping an endpoint that silently returns a prefix of the
 * users table and presents it as the user list.
 */
export async function adminUsers(limit = 200): Promise<AdminUserRow[]> {
  const db = requireDb();

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
      totalSpendMicro: sql<string>`coalesce((
        SELECT sum(-${schema.creditLedger.delta}) FROM ${schema.creditLedger}
        WHERE ${schema.creditLedger.userId} = ${schema.users.id}
          AND ${schema.creditLedger.delta} < 0
      ), 0)`,
    })
    .from(schema.users)
    .orderBy(desc(sql`coalesce((
        SELECT sum(-${schema.creditLedger.delta}) FROM ${schema.creditLedger}
        WHERE ${schema.creditLedger.userId} = ${schema.users.id}
          AND ${schema.creditLedger.delta} < 0
      ), 0)`))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    credits: creditsMicroToDisplay(r.credits),
    isAdmin: r.isAdmin,
    createdAt: r.createdAt.toISOString(),
    spendBlockedUntil: r.spendBlockedUntil ? r.spendBlockedUntil.toISOString() : null,
    jobCount: r.jobCount,
    totalSpendUsd: fromMicro(Number(r.totalSpendMicro ?? 0)),
  }));
}

export interface AdminJobRow {
  id: string;
  userId: string;
  type: string;
  model: string;
  status: string;
  error: string | null;
  attempts: number;
  estimateUsd: number;
  actualUsd: number | null;
  createdAt: string;
  completedAt: string | null;
}

/** Every job, newest first. The view an operator uses to find stuck generations. */
export async function adminJobs(limit = 200): Promise<AdminJobRow[]> {
  const db = requireDb();

  const rows = await db
    .select()
    .from(schema.generations)
    .orderBy(desc(schema.generations.createdAt), desc(schema.generations.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    type: r.type,
    model: r.model,
    status: r.status,
    error: r.error,
    attempts: r.attempts,
    estimateUsd: fromMicro(r.costEstimateMicro),
    actualUsd: r.costActualMicro == null ? null : fromMicro(r.costActualMicro),
    createdAt: r.createdAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  }));
}

export interface AdminLedgerRow {
  id: number;
  userId: string;
  generationId: string | null;
  deltaCredits: number;
  reason: string;
  balanceAfter: number;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

/**
 * The ledger, newest first.
 *
 * Read-only by construction — there is no update or delete function anywhere in
 * this file, and the database rejects both at the schema level. See
 * `ledgerImmutabilitySql` in `src/lib/db/schema.ts`.
 */
export async function adminLedger(limit = 200): Promise<AdminLedgerRow[]> {
  const db = requireDb();

  const rows = await db
    .select()
    .from(schema.creditLedger)
    .orderBy(desc(schema.creditLedger.createdAt), desc(schema.creditLedger.id))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    generationId: r.generationId,
    deltaCredits: creditsMicroToDisplay(r.delta),
    reason: r.reason,
    balanceAfter: creditsMicroToDisplay(r.balanceAfter),
    metadata: (r.metadata ?? null) as Record<string, unknown> | null,
    createdAt: r.createdAt.toISOString(),
  }));
}