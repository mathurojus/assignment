import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { requireDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok } from "@/lib/api";
import { isTerminal } from "@/lib/db/schema";
import { publicMediaUrl } from "@/lib/storage";
import { fromMicro, creditsMicroToDisplay } from "@/lib/openrouter/pricing";

/**
 * The signed-in user's gallery.
 *
 * Keyset pagination on `(createdAt, id)`, not OFFSET. OFFSET re-scans every
 * skipped row, so page 50 of a large gallery is 50x the work of page 1 -- and
 * with new generations arriving it also skips and repeats rows across pages. A
 * cursor on the primary-key-adjacent pair is stable under inserts.
 *
 * The composite index `generations_user_created_idx (user_id, created_at DESC)`
 * exists for exactly this query.
 */
export const dynamic = "force-dynamic";

const query = z.object({
  /** Cursor from the previous page. Opaque to the client. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
  status: z
    .enum(["all", "completed", "running", "failed"])
    .default("all"),
  /** Only public generations -- what the explore page uses, signed in or not. */
  publicOnly: z.coerce.boolean().default(false),
  /** Also return balance and today's spend, for the gallery header. */
  includeBalance: z.coerce.boolean().default(false),
});

export async function GET(request: Request) {
  const url = new URL(request.url);
  const parsed = query.safeParse(Object.fromEntries(url.searchParams));

  if (!parsed.success) {
    return apiError(
      "validation_failed",
      "That page request was not valid.",
      { fields: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) },
    );
  }

  const db = requireDb();
  const user = await getSessionUser();

  // The explore feed is public by design, so it works signed out. Everything
  // else needs a session.
  if (!user && !parsed.data.publicOnly) {
    return apiError("unauthorized", "Sign in to see your gallery.");
  }

  const conditions = [];

  if (parsed.data.publicOnly) {
    // Only completed work belongs in a public feed. A "failed" tile in the
    // explore grid is not content.
    conditions.push(eq(schema.generations.isPublic, true));
    conditions.push(eq(schema.generations.status, "completed"));
  } else if (user) {
    conditions.push(
      user.isAdmin && parsed.data.status === "all"
        ? // An admin's default view is their own work, not everybody's. The
          // all-users feed is an explicit admin action with its own route.
          eq(schema.generations.userId, user.id)
        : eq(schema.generations.userId, user.id),
    );

    if (parsed.data.status === "completed") {
      conditions.push(eq(schema.generations.status, "completed"));
    } else if (parsed.data.status === "failed") {
      conditions.push(sql`${schema.generations.status} in ('failed','cancelled','expired')`);
    } else if (parsed.data.status === "running") {
      conditions.push(
        sql`${schema.generations.status} in ('queued','submitting','generating','downloading')`,
      );
    }
  }

  if (parsed.data.cursor) {
    const decoded = decodeCursor(parsed.data.cursor);
    if (decoded) {
      conditions.push(
        sql`(${schema.generations.createdAt}, ${schema.generations.id}) < (${decoded.createdAt}, ${decoded.id}::uuid)`,
      );
    }
    // A malformed cursor is ignored rather than rejected: it is a stale URL in
    // a bookmark, not a client bug worth surfacing.
  }

  const rows = await db
    .select()
    .from(schema.generations)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    // One extra row, to learn whether another page exists without a count query.
    .orderBy(desc(schema.generations.createdAt), desc(schema.generations.id))
    .limit(parsed.data.limit + 1);

  const hasMore = rows.length > parsed.data.limit;
  const page = hasMore ? rows.slice(0, parsed.data.limit) : rows;

  // The balance rides along with the gallery rather than being its own endpoint.
  // Two numbers that always appear in the same header do not justify two round
  // trips, and the balance is needed on nearly every page anyway.
  const balance = parsed.data.includeBalance && user ? await readBalance(user.id) : null;

  return ok(
    {
      generations: page.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        terminal: isTerminal(row.status),
        model: row.model,
        prompt: row.prompt,
        preset: row.preset,
        isPublic: row.isPublic,
        outputKey: row.outputUrl,
        outputUrl: row.outputUrl ? publicMediaUrl(row.outputUrl) : null,
        mimeType: row.mimeType,
        error: row.error,
        costUsd:
          row.costActualMicro == null
            ? fromMicro(row.costEstimateMicro)
            : fromMicro(row.costActualMicro),
        createdAt: row.createdAt,
        completedAt: row.completedAt,
      })),
      nextCursor: hasMore ? encodeCursor(page[page.length - 1]) : null,
      hasMore,
      balance,
    },
    {
      headers: {
        // A gallery shows other people's work, so it is per-user.
        "cache-control": "private, no-store",
      },
    },
  );
}

async function readBalance(userId: string) {
  const db = requireDb();

  const [user] = await db
    .select({ credits: schema.users.credits, spendBlockedUntil: schema.users.spendBlockedUntil })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);

  // UTC midnight, matching how `daily_spend` rows are keyed.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const [spent] = await db
    .select({ spentMicro: schema.dailySpend.spentMicro })
    .from(schema.dailySpend)
    .where(gte(schema.dailySpend.day, today))
    .limit(1);

  return {
    credits: creditsMicroToDisplay(user?.credits ?? 0),
    spentTodayUsd: fromMicro(spent?.spentMicro ?? 0),
    spendBlockedUntil: user?.spendBlockedUntil ?? null,
  };
}

/**
 * Encode a cursor.
 *
 * Base64 of `createdAt.toISOString()|id`. Signed? No -- the cursor only selects
 * which rows to return, and the ownership filter is applied independently. A
 * forged cursor can therefore only ask for an *earlier page of your own rows*,
 * which the caller could have requested by scrolling.
 */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    // Validate both halves. An unvalidated id goes straight into SQL as
    // `${id}::uuid`, which is safe from injection because it is a parameter, but
    // it would surface as a Postgres error rather than as a bad cursor.
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}