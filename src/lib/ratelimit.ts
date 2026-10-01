import { sql } from "drizzle-orm";
import { executeRows, requireDb, schema } from "./db";

/**
 * Fixed-window counters for things that are not money.
 *
 * Credit accounting is in `credits.ts` because it needs real transactions and
 * advisory locks. This is deliberately much simpler: a counter for how many
 * times somebody may hit an endpoint that costs the operator money without
 * taking any money from them, where a lost or double-counted increment costs
 * nothing more than one extra request.
 *
 * That framing is why this file has no advisory lock and no transaction. A race
 * here can let one extra request through. The same race in the credit path
 * would mint credits, which is why that path does not use this file.
 */

export type Bucket = "enhance" | "upload" | "feedback";

export interface BucketState {
  allowed: boolean;
  /** Requests remaining in the current window. */
  remaining: number;
  limit: number;
  /** Seconds until the window resets. Always at least 1, so clients can poll. */
  retryAfterSeconds: number;
}

/**
 * How many requests per hour, per bucket.
 *
 * Enhancement is the tightest because it is the only one that costs money per
 * call with no revenue attached. Uploads cost bandwidth. Feedback costs nothing
 * and is capped only to bound table growth from a script.
 */
const LIMITS: Record<Bucket, number> = {
  enhance: 20,
  upload: 60,
  feedback: 10,
};

const WINDOW_MS = 60 * 60 * 1000;

/**
 * Consume one unit from a bucket.
 *
 * The increment and the read happen in one statement via
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. Two statements would race:
 * both could read `count = 19`, both decide there is room, and both write 20 --
 * allowing 21 through. The upsert takes a row lock, so the second statement
 * blocks and then re-reads the already-incremented value.
 *
 * `>= limit` rather than `>` because the row is incremented before the check, so
 * the stored count is the number of requests *including* this one.
 */
export async function userRateBucket(
  bucket: Bucket,
  userId: string,
): Promise<BucketState> {
  const limit = LIMITS[bucket];
  const windowStart = new Date();
  windowStart.setMinutes(0, 0, 0);

  const db = requireDb();

  const [row] = await executeRows<{ count: number }>(sql`
    INSERT INTO rate_limits (user_id, window_start, count)
    VALUES (${userId}::uuid, ${windowStart}, 1)
    ON CONFLICT (user_id, window_start)
    DO UPDATE SET count = rate_limits.count + 1
    RETURNING count
  `);

  const count = Number(row?.count ?? 1);
  const resetAt = new Date(windowStart.getTime() + WINDOW_MS);

  return {
    // `count` already includes this request, so 20 means "the 20th is allowed".
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
  };
}

/**
 * Peek without consuming.
 *
 * For routes that want to reject up front with a useful message but must not
 * penalise a request that then fails validation.
 */
export async function peekRateBucket(bucket: Bucket, userId: string): Promise<BucketState> {
  const limit = LIMITS[bucket];
  const windowStart = new Date();
  windowStart.setMinutes(0, 0, 0);

  const db = requireDb();
  const [row] = await db
    .select({ count: schema.rateLimits.count })
    .from(schema.rateLimits)
    .where(
      sql`${schema.rateLimits.userId} = ${userId}::uuid AND ${schema.rateLimits.windowStart} = ${windowStart}`,
    )
    .limit(1);

  const count = row?.count ?? 0;
  const resetAt = new Date(windowStart.getTime() + WINDOW_MS);

  return {
    allowed: count < limit,
    remaining: Math.max(0, limit - count),
    limit,
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000)),
  };
}
