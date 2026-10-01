import { z } from "zod";
import { queryGallery, readBalance, type GalleryRow } from "@/lib/gallery";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok } from "@/lib/api";

/**
 * The gallery feed as JSON.
 *
 * Thin on purpose. The query, the cursor and the row mapping live in
 * `@/lib/gallery`, shared with the server-rendered gallery and explore pages --
 * see the note at the top of that file for why the pages do not call this route.
 *
 * Two consumers: the client gallery's infinite scroll, and anything that wants the
 * feed without rendering a page.
 */
export const dynamic = "force-dynamic";

const query = z.object({
  /** Cursor from the previous page. Opaque to the client. */
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(48).default(24),
  status: z.enum(["all", "completed", "running", "failed"]).default("all"),
  /** Only public completed generations -- what the explore page uses, signed in or not. */
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

  const user = await getSessionUser();

  // The explore feed is public by design, so it works signed out. Everything else
  // needs a session.
  if (!user && !parsed.data.publicOnly) {
    return apiError("unauthorized", "Sign in to see your gallery.");
  }

  const { rows, nextCursor, hasMore } = await queryGallery({
    userId: user?.id ?? null,
    scope: parsed.data.publicOnly ? "public" : "mine",
    status: parsed.data.status,
    cursor: parsed.data.cursor ?? null,
    limit: parsed.data.limit,
  });

  const balance = parsed.data.includeBalance && user ? await readBalance(user.id) : null;

  return ok(
    { generations: rows.map(toWire), nextCursor, hasMore, balance },
    {
      // A gallery shows other people's prompts and media, so it is per-user even
      // for the public feed: an intermediary cache would serve one signed-in
      // reader another's account name.
      headers: { "cache-control": "private, no-store" },
    },
  );
}

/**
 * The wire shape.
 *
 * Explicit rather than spreading the row: `GalleryRow` carries `params`, the
 * enhanced prompt and the per-output list, which a grid does not need and which
 * would triple the size of a 24-item page. Field-by-field also means a column
 * added for a page's own use cannot leak into the API by accident.
 */
function toWire(row: GalleryRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    terminal: row.terminal,
    model: row.model,
    prompt: row.prompt,
    preset: row.preset,
    isPublic: row.isPublic,
    outputKey: row.outputKey,
    outputUrl: row.outputUrl,
    /** How many images this job produced. The tile shows the first. */
    outputCount: row.outputCount,
    mimeType: row.mimeType,
    error: row.error,
    /** The settled cost, or the estimate while the job is still running. */
    costUsd: row.costActualUsd ?? row.costEstimateUsd,
    settled: row.costActualUsd !== null,
    createdAt: row.createdAt,
    completedAt: row.completedAt,
    ...(row.authorName ? { authorName: row.authorName } : {}),
  };
}