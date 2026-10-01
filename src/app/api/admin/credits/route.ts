import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { requireDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok, route } from "@/lib/api";
import { adminAdjust } from "@/lib/credits";
import { usdToCreditsMicro, creditsMicroToDisplay, fromMicro } from "@/lib/openrouter/pricing";

/**
 * Move a user's credit balance, by hand.
 *
 * The only admin action that writes money, so it is deliberately awkward:
 *
 *  - The amount is entered in **credits** in the UI and converted here with the
 *    one canonical function, so there is exactly one definition of what a credit
 *    is worth.
 *  - `reason` is required and free text, and is written into the ledger row. An
 *    unexplained balance change is the thing that makes a ledger untrustworthy.
 *  - The ledger write is not optional and cannot be skipped. It happens inside
 *    `adminAdjust`, so there is no code path here that adjusts without recording.
 *  - The response includes the resulting balance, so the operator sees the
 *    effect before navigating away.
 *
 * The ledger is append-only at the database level, so this row cannot later be
 * edited to explain itself.
 */
export const dynamic = "force-dynamic";

const body = z.object({
  userId: z.string().uuid(),
  /** Signed, in credits. Negative to deduct. Must not be zero. */
  credits: z.number().refine((n) => n !== 0, "Enter a non-zero amount."),
  reason: z.string().min(3).max(500),
  /** Optional audit detail, e.g. a support ticket reference. */
  reference: z.string().max(200).optional(),
});

export async function POST(request: Request) {
  return route(async () => {
    const user = await getSessionUser();
    if (!user) return apiError("unauthorized", "Sign in first.");
    if (!user.isAdmin) return apiError("forbidden", "This area is for administrators.");

    let parsed: z.infer<typeof body>;
    try {
      parsed = body.parse(await request.json());
    } catch (e) {
      if (e instanceof z.ZodError) {
        return apiError("validation_failed", "That adjustment was not valid.", {
          fields: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      return apiError("validation_failed", "Expected a JSON body.");
    }

    // There is exactly one conversion in the codebase.
    const micro = usdToCreditsMicro(parsed.credits / 100);

    // Refuse before touching the ledger if the target does not exist, so the
    // error says "no such user" rather than a foreign key violation.
    const db = requireDb();
    const [target] = await db
      .select({ id: schema.users.id, email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, parsed.userId))
      .limit(1);

    if (!target) {
      return apiError("not_found", "No user with that id.");
    }

    const result = await adminAdjust({
      userId: parsed.userId,
      deltaMicro: micro,
      adminId: user.id,
      note: parsed.reference
        ? `${parsed.reason} (ref: ${parsed.reference})`
        : parsed.reason,
    });

    if (!result.ok) {
      // `adminAdjust` collapses two distinct failures into one message, because
      // from the ledger's point of view both mean "no row was written". Tell the
      // operator which one it was so they can retry sensibly.
      const missing = (result.error ?? "").includes("not found");
      return apiError(
        missing ? "not_found" : "validation_failed",
        missing
          ? "No user with that id."
          : "That adjustment would push the user's balance below zero. Check the current balance in the Users tab.",
      );
    }

    return ok({
      userId: parsed.userId,
      email: target.email,
      balance: creditsMicroToDisplay(result.balanceMicro ?? 0),
      balanceUsd: fromMicro(result.balanceMicro ?? 0),
      applied: creditsMicroToDisplay(micro),
    });
  });
}

/**
 * Recent adjustments, so the operator can see what they have already done.
 *
 * Filtered to the two admin reasons rather than showing every ledger row: this is
 * the audit view for this specific action. Both are included because
 * `adminAdjust` picks the reason from the sign -- a grant is `admin_topup` and a
 * deduction is `admin_adjust` -- and an operator reviewing their own history needs
 * to see the grants too.
 */
export async function GET(request: Request) {
  const user = await getSessionUser();
  if (!user) return apiError("unauthorized", "Sign in first.");
  if (!user.isAdmin) return apiError("forbidden", "This area is for administrators.");

  const limitParam = Number(new URL(request.url).searchParams.get("limit") ?? 50);
  const limit = Number.isFinite(limitParam)
    ? Math.min(Math.max(1, Math.floor(limitParam)), 200)
    : 50;

  const rows = await requireDb()
    .select()
    .from(schema.creditLedger)
    .where(inArray(schema.creditLedger.reason, ["admin_adjust", "admin_topup"]))
    .orderBy(desc(schema.creditLedger.createdAt), desc(schema.creditLedger.id))
    .limit(limit);

  return ok({
    adjustments: rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      deltaCredits: creditsMicroToDisplay(r.delta),
      reason: r.reason,
      balanceAfter: creditsMicroToDisplay(r.balanceAfter),
      metadata: r.metadata,
      createdAt: r.createdAt,
    })),
  });
}