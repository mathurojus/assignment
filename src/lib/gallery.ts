import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { requireDb, schema } from "@/lib/db";
import { isTerminal } from "@/lib/db/schema";
import { publicMediaUrl } from "@/lib/storage";
import { fromMicro, creditsMicroToDisplay } from "@/lib/openrouter/pricing";

/**
 * Reading a page of generations.
 *
 * Lives here rather than in the route handler so the gallery and explore pages can
 * render it server-side. Both alternatives to sharing it are worse: making a server
 * component `fetch` its own route handler is a real HTTP round trip to the same
 * deployment — on Vercel that consumes a function invocation, can fail on a
 * concurrency limit, and is measurably slower than a direct query — and duplicating
 * the SQL into each page guarantees the two views drift.
 */

export type GalleryScope = "mine" | "public";

export interface GalleryQuery {
  /**
   * Whose rows. `null` with `scope: "public"` is legitimate — the explore feed works
   * signed out.
   */
  userId: string | null;
  scope: GalleryScope;
  status: "all" | "completed" | "running" | "failed";
  cursor?: string | null;
  limit?: number;
}

export interface GalleryRow {
  id: string;
  type: "video" | "image";
  status: string;
  terminal: boolean;
  model: string;
  modelName: string | null;
  prompt: string;
  enhancedPrompt: string | null;
  preset: string | null;
  isPublic: boolean;
  outputKey: string | null;
  outputUrl: string | null;
  outputCount: number;
  outputs: Array<{ key: string; url: string; mimeType: string; bytes: number }>;
  mimeType: string | null;
  bytes: number | null;
  error: string | null;
  /** What we quoted. */
  costEstimateUsd: number;
  /** What OpenRouter billed. Null until the job settles, and for failures. */
  costActualUsd: number | null;
  params: Record<string, unknown>;
  createdAt: string;
  completedAt: string | null;
  /** Only present for the public scope. */
  authorName: string | null;
}

/**
 * One page of generations, newest first.
 *
 * Keyset pagination on `(created_at, id)` rather than OFFSET. OFFSET re-scans every
 * skipped row, so page 50 of a large gallery costs 50x page 1; worse, with new rows
 * arriving between requests it skips and repeats rows, which in a gallery means a
 * job appears twice or vanishes between pages. A cursor over the sort key is stable
 * under concurrent inserts.
 *
 * The composite index `generations_user_created_idx (user_id, created_at DESC)`
 * exists for exactly this query; the public feed rides
 * `generations_public_created_idx`.
 */
export async function queryGallery(q: GalleryQuery): Promise<{
  rows: GalleryRow[];
  nextCursor: string | null;
  hasMore: boolean;
}> {
  const db = requireDb();
  const limit = Math.max(1, Math.min(q.limit ?? 24, 48));

  const conditions = [];

  if (q.scope === "public") {
    // Only completed work belongs in a public feed. A "failed" tile in the explore
    // grid is not content, and neither is an in-progress one -- it would show a
    // placeholder that changes under the reader.
    conditions.push(eq(schema.generations.isPublic, true));
    conditions.push(eq(schema.generations.status, "completed"));
  } else if (q.userId) {
    conditions.push(eq(schema.generations.userId, q.userId));

    if (q.status === "completed") {
      conditions.push(eq(schema.generations.status, "completed"));
    } else if (q.status === "failed") {
      conditions.push(sql`${schema.generations.status} in ('failed','cancelled','expired')`);
    } else if (q.status === "running") {
      conditions.push(
        sql`${schema.generations.status} in ('queued','submitting','generating','downloading')`,
      );
    }
  }

  if (q.cursor) {
    const decoded = decodeCursor(q.cursor);
    // A malformed cursor is ignored rather than rejected: it is a stale bookmarked
    // URL, not a client bug worth surfacing. Ignoring it restarts from the top,
    // which is a usable outcome; a 400 would be a dead end.
    if (decoded) {
      conditions.push(
        lt(
          sql`(${schema.generations.createdAt}, ${schema.generations.id})`,
          sql`(${decoded.createdAt}, ${decoded.id}::uuid)`,
        ),
      );
    }
  }

  const rows = await db
    .select({
      gen: schema.generations,
      authorName: schema.users.name,
      authorEmail: schema.users.email,
    })
    .from(schema.generations)
    // The join is only needed for the public feed, but it is a primary-key lookup
    // on an already-selected row, so it costs nothing measurable either way and
    // keeps one query shape instead of two that differ by a join.
    .leftJoin(schema.users, eq(schema.users.id, schema.generations.userId))
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(schema.generations.createdAt), desc(schema.generations.id))
    // One extra row, to learn whether another page exists without a COUNT. A count
    // query on a growing table is a full index scan, and the answer is only used to
    // decide whether to draw a "load more" button.
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Resolve every media key to a URL in one parallel pass.
  //
  // Two reasons this is not an `await` inside the row mapper below: the mapper
  // would serialise up to 48 sequential signed-URL round trips, which is the
  // slowest part of the request by a wide margin; and putting `await` in the map
  // forces `outputUrl` to become a `Promise` on the row type, which leaks async
  // into every component that renders a tile.
  const keys = new Set<string>();
  for (const { gen } of page) {
    if (gen.outputUrl) keys.add(gen.outputUrl);
    for (const o of gen.outputs) keys.add(o.key);
  }
  const resolved = new Map<string, string | null>();
  await Promise.all(
    [...keys].map(async (key) => {
      resolved.set(key, await publicMediaUrl(key));
    }),
  );

  const url = (key: string | null): string | null =>
    key ? (resolved.get(key) ?? null) : null;

  return {
    rows: page.map(({ gen, authorName, authorEmail }) => ({
      id: gen.id,
      type: gen.type,
      status: gen.status,
      terminal: isTerminal(gen.status),
      model: gen.model,
      modelName: null,
      prompt: gen.prompt,
      enhancedPrompt: gen.enhancedPrompt,
      preset: gen.preset,
      isPublic: gen.isPublic,
      outputKey: gen.outputUrl,
      outputUrl: url(gen.outputUrl),
      outputCount: Math.max(1, gen.outputs.length),
      outputs:
        gen.outputs.length > 0
          ? gen.outputs.map((o) => ({
              key: o.key,
              url: url(o.key) ?? "",
              mimeType: o.mimeType,
              bytes: o.bytes,
            }))
          : gen.outputUrl
            ? [
                {
                  key: gen.outputUrl,
                  url: url(gen.outputUrl) ?? "",
                  mimeType: gen.mimeType ?? "application/octet-stream",
                  bytes: gen.bytes ?? 0,
                },
              ]
            : [],
      mimeType: gen.mimeType,
      bytes: gen.bytes,
      error: gen.error,
      costEstimateUsd: fromMicro(gen.costEstimateMicro),
      costActualUsd: gen.costActualMicro == null ? null : fromMicro(gen.costActualMicro),
      params: (gen.params ?? {}) as Record<string, unknown>,
      createdAt: gen.createdAt.toISOString(),
      completedAt: gen.completedAt ? gen.completedAt.toISOString() : null,
      authorName: authorName ?? authorEmail,
    })),
    nextCursor: hasMore ? encodeCursor(page[page.length - 1].gen) : null,
    hasMore,
  };
}

/** Balance and today's spend for the gallery header. */
export async function readBalance(userId: string): Promise<{
  credits: number;
  spentTodayUsd: number;
  spendBlockedUntil: string | null;
}> {
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
    spendBlockedUntil: user?.spendBlockedUntil
      ? user.spendBlockedUntil.toISOString()
      : null,
  };
}

/** Count of a user's non-terminal jobs, for the nav badge. */
export async function countRunning(userId: string): Promise<number> {
  const db = requireDb();
  const rows = await db
    .select({ id: schema.generations.id })
    .from(schema.generations)
    .where(
      and(
        eq(schema.generations.userId, userId),
        sql`${schema.generations.status} in ('queued','submitting','generating','downloading')`,
      ),
    );

  // `select({ id })` rather than `count()`: a user's running-job count is at most
  // `MAX_CONCURRENT_JOBS_PER_USER` rows, which is a handful, so counting in JS over
  // a bounded result is cheaper than a second aggregate query.
  return Array.isArray(rows) ? rows.length : 0;
}

/**
 * Encode a cursor.
 *
 * Base64 of `createdAt.toISOString()|id`. Unsigned, and that is deliberate: a
 * cursor only selects *which* rows to return, and the ownership filter is applied
 * independently of it. A forged cursor can therefore only ask for an earlier page
 * of rows the caller was already entitled to see.
 */
function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: string; id: string } | null {
  try {
    const [createdAt, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    if (!createdAt || !id) return null;
    // Validate both halves. The id goes into SQL as `${id}::uuid`, which is a bind
    // parameter and so not an injection risk, but an unvalidated one surfaces as a
    // Postgres error rather than as a bad cursor.
    if (Number.isNaN(Date.parse(createdAt))) return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null;
    return { createdAt, id: id.toLowerCase() };
  } catch {
    return null;
  }
}