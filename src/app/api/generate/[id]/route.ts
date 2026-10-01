import { and, eq, sql } from "drizzle-orm";
import { requireDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok } from "@/lib/api";
import { isTerminal } from "@/lib/db/schema";
import { publicMediaUrl } from "@/lib/storage";
import { fromMicro } from "@/lib/openrouter/pricing";

/**
 * One generation's state.
 *
 * This is the polling endpoint the browser hits while a job runs, so it is
 * deliberately cheap: a single indexed primary-key lookup, no joins, and no
 * upstream call. The worker owns state transitions; this route only reports
 * them.
 *
 * Ownership is enforced here rather than trusted from the URL. A generation id
 * is a UUID, which is not a secret -- guessing is impractical but not impossible,
 * and a gallery route that serves other people's prompts and videos on a
 * guessed id is a real disclosure bug rather than a theoretical one.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getSessionUser();
  if (!user) {
    return apiError("unauthorized", "Sign in to view this generation.");
  }

  const db = requireDb();

  const [row] = await db.select().from(schema.generations).where(eq(schema.generations.id, id)).limit(1);

  if (!row) {
    return apiError("not_found", "No generation with that id.");
  }

  // A public generation is visible to anyone signed in, including its prompt.
  if (row.userId !== user.id && !row.isPublic && !user.isAdmin) {
    // 404 rather than 403: confirming the id exists tells a prober that this
    // uuid belongs to somebody. The same shape as a resource that does not exist
    // is the point.
    return apiError("not_found", "No generation with that id.");
  }

  const terminal = isTerminal(row.status);

  return ok(
    {
      id: row.id,
      type: row.type,
      status: row.status,
      terminal,
      model: row.model,
      prompt: row.prompt,
      enhancedPrompt: row.enhancedPrompt,
      preset: row.preset,
      params: row.params,
      isPublic: row.isPublic,

      /** Storage keys, not URLs. The client builds a route through them. */
      outputKey: row.outputUrl,
      outputUrl: row.outputUrl ? publicMediaUrl(row.outputUrl) : null,
      /**
       * Every output, for an `n > 1` image job.
       *
       * Falls back to the single `outputUrl` for rows written before the
       * `outputs` column existed, so a job from an older deploy still renders
       * instead of appearing to have produced nothing.
       */
      outputs: (
        row.outputs.length > 0
          ? row.outputs
          : row.outputUrl
            ? [{ key: row.outputUrl, mimeType: row.mimeType ?? "application/octet-stream", bytes: row.bytes ?? 0 }]
            : []
      ).map((o) => ({
        key: o.key,
        url: publicMediaUrl(o.key),
        mimeType: o.mimeType,
        bytes: o.bytes,
      })),
      sourceImageKey: row.sourceImageUrl,
      sourceImageUrl: row.sourceImageUrl ? publicMediaUrl(row.sourceImageUrl) : null,
      mimeType: row.mimeType,
      bytes: row.bytes,

      error: row.error,

      cost: {
        estimateUsd: fromMicro(row.costEstimateMicro),
        actualUsd: row.costActualMicro == null ? null : fromMicro(row.costActualMicro),
        /** What the user was ultimately charged, once reconciled. */
        chargedUsd:
          row.costActualMicro == null
            ? terminal && row.status === "completed"
              ? fromMicro(row.costEstimateMicro)
              : null
            : fromMicro(row.costActualMicro),
      },

      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt,
    },
    {
      headers: {
        // A running job changes constantly; a finished one never does.
        "cache-control": terminal ? "private, max-age=60" : "no-store",
      },
    },
  );
}

/**
 * Mark a generation public or private.
 *
 * `PATCH`, not a separate `POST /publish`, because this is a partial update of an
 * existing resource and the client is toggling one field.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  const user = await getSessionUser();
  if (!user) {
    return apiError("unauthorized", "Sign in first.");
  }

  let body: { isPublic?: unknown };
  try {
    body = (await request.json()) as { isPublic?: unknown };
  } catch {
    return apiError("validation_failed", "Expected a JSON body.");
  }

  if (typeof body.isPublic !== "boolean") {
    return apiError("validation_failed", "Send { \"isPublic\": true | false }.");
  }

  const db = requireDb();

  const [updated] = await db
    .update(schema.generations)
    .set({ isPublic: body.isPublic, updatedAt: new Date() })
    .where(
      and(
        eq(schema.generations.id, id),
        // The owner's own row, or anything, if an admin.
        user.isAdmin
          ? sql`true`
          : eq(schema.generations.userId, user.id),
      ),
    )
    .returning({ isPublic: schema.generations.isPublic });

  if (!updated) {
    return apiError("not_found", "No generation with that id.");
  }

  return ok({ id, isPublic: updated.isPublic });
}