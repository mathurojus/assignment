import { z } from "zod";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok } from "@/lib/api";
import { isDatabaseUnavailable } from "@/lib/db";
import {
  adminJobs,
  adminLedger,
  adminOverview,
  adminUsers,
} from "@/lib/admin";

/**
 * Admin data as JSON.
 *
 * The queries live in `@/lib/admin`, shared with the server-rendered `/admin` page.
 *
 * Read-only, with one exception: a credit adjustment goes through
 * `POST /api/admin/credits`, not through a `PATCH` here. An adjustment needs its own
 * request shape — an amount, a reason, an operator id — and folding it into a tab
 * query would mean the most dangerous operation in the app was a field on a GET.
 */
export const dynamic = "force-dynamic";

const query = z.object({
  tab: z.enum(["overview", "jobs", "users", "ledger"]).default("overview"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return apiError("unauthorized", "Sign in first.");
  if (!user.isAdmin) return apiError("forbidden", "This area is for administrators.");

  const url = new URL(request.url);
  const parsed = query.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) {
    return apiError("validation_failed", "That tab request was not valid.");
  }

  const { tab, limit } = parsed.data;

  try {
    if (tab === "users") return ok({ users: await adminUsers(limit) });
    if (tab === "ledger") return ok({ entries: await adminLedger(limit) });
    if (tab === "jobs") return ok({ jobs: await adminJobs(limit) });

    return ok({ totals: await adminOverview(), tabs: ["overview", "jobs", "users", "ledger"] });
  } catch (error) {
    if (isDatabaseUnavailable(error)) {
      return apiError("database_unavailable", error.message);
    }
    throw error;
  }
}