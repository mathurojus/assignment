import { timingSafeEqual } from "node:crypto";
import { advanceGeneration, claimDueJobs, expireStaleJobs } from "@/lib/generation";
import { env } from "@/lib/env";
import { apiError, handleError } from "@/lib/api";

/**
 * Advance due jobs. One idempotent endpoint, three interchangeable drivers.
 *
 * Why one route rather than a queue:
 *
 * Video generation is asynchronous by nature -- a job is queued, submitted,
 * polled for minutes, then downloaded. Something has to come back and ask "is it
 * done yet". On the free tier the options are narrow:
 *
 *   - A long-lived worker process: free, but only if you have a machine that
 *     stays up. Not available on Vercel.
 *   - Vercel Cron: the Hobby plan allows **one cron per day**, which is useless
 *     for a job that finishes in three minutes. The plan limit is the whole
 *     reason this design exists.
 *   - The browser: while a user is watching a job, their page pings this route.
 *     Costs nothing, needs no infrastructure, and is available on every plan.
 *   - `npm run worker`: the same route in a loop, for local development and for
 *     anywhere that does have a long-lived box.
 *
 * So all three call the same function, and the route is written to be safe to
 * call from all three at once: `claimDueJobs` uses `FOR UPDATE SKIP LOCKED`, and
 * every transition inside `advanceGeneration` is a guarded UPDATE. Two ticks
 * racing is not a correctness problem, it is duplicated work that resolves to
 * the same answer.
 *
 * Auth is `WORKER_SECRET` compared with `timingSafeEqual`. If the variable is
 * unset the route is open, which is the right default for local development but
 * is called out loudly in the response and in the README.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface TickResult {
  claimed: number;
  progressed: number;
  skipped: number;
  expired: number;
  errors: number;
  /**
   * False means this endpoint is unauthenticated. Surfaced in the response
   * rather than only in the docs, so a deployed instance that forgot
   * WORKER_SECRET shows it in the logs the first time someone calls it.
   */
  authenticated: boolean;
  /** Per-job detail, for debugging a stuck generation from the browser. */
  jobs: Array<{ id: string; result: string; error?: string }>;
}

export async function POST(request: Request) {
  try {
    if (!isAuthorised(request)) {
      return apiError(
        "unauthorized",
        "This worker endpoint requires WORKER_SECRET to be set and sent as a bearer token.",
      );
    }

    const batchSize = Number(
      new URL(request.url).searchParams.get("limit") ?? env.WORKER_BATCH_SIZE,
    );
    const limit = Number.isFinite(batchSize)
      ? Math.min(Math.max(1, Math.floor(batchSize)), 25)
      : env.WORKER_BATCH_SIZE;

    const expired = await expireStaleJobs();
    const ids = await claimDueJobs(limit);

    const result: TickResult = {
      claimed: ids.length,
      progressed: 0,
      skipped: 0,
      expired,
      errors: 0,
      authenticated: Boolean(env.WORKER_SECRET),
      jobs: [],
    };

    // Sequential, not Promise.all. Each step talks to OpenRouter, and a batch of
    // parallel submissions can trip the account's rate limit -- which shows up
    // as 429s on jobs that would otherwise have succeeded. Sequential also keeps
    // the serverless execution window predictable.
    for (const id of ids) {
      try {
        const outcome = await advanceGeneration(id);
        if (outcome === "progressed") result.progressed += 1;
        else result.skipped += 1;
        result.jobs.push({ id, result: outcome });
      } catch (error) {
        result.errors += 1;
        const message = error instanceof Error ? error.message : String(error);
        result.jobs.push({ id, result: "error", error: message });
        console.error(`[worker] job ${id} failed:`, message);
      }
    }

    return Response.json(result);
  } catch (error) {
    return handleError(error);
  }
}

/** Convenience for `npm run worker` and cron, which send no auth header. */
export async function GET(request: Request) {
  return POST(request);
}

function isAuthorised(request: Request): boolean {
  const secret = env.WORKER_SECRET;

  // Unset means open. Documented, and reported in the response body so it is
  // visible in the logs of a deployed instance that forgot to set it.
  if (!secret) return true;

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";

  if (!token) return false;

  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}