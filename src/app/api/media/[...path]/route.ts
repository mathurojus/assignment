import { and, eq } from "drizzle-orm";
import { storage } from "@/lib/storage";
import { requireDb, schema } from "@/lib/db";
import { getSessionUser } from "@/lib/supabase/server";
import { handleError } from "@/lib/api";

/**
 * Serve a stored media object.
 *
 * Two access rules, decided by who is asking:
 *
 *   - The owner, or an admin, may fetch any of their own objects. Authenticated
 *     by session, and the key must belong to a row they own.
 *   - Anyone may fetch an object attached to a generation marked public.
 *
 * The check is a database lookup rather than a token in the URL. A signed URL
 * per object would mean minting one on every render and revoking them
 * individually; a row lookup is stateless and cannot leak.
 */
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path: segments } = await params;
    const key = segments.map(decodeURIComponent).join("/");

    if (!key || key.includes("..")) {
      return new Response("Not found", { status: 404 });
    }

    // The public route is deliberately unauthenticated and narrower: it is what
    // OpenRouter fetches, so it must work without a session.
    const isPublicRoute = segments[0] === "public";
    const storageKey = isPublicRoute ? segments.slice(1).map(decodeURIComponent).join("/") : key;

    if (!isPublicRoute) {
      const allowed = await canRead(storageKey);
      if (!allowed) return new Response("Not found", { status: 404 });
    }

    const bytes = await storage.get(storageKey);
    if (!bytes) return new Response("Not found", { status: 404 });

    const contentType = contentTypeFor(storageKey);

    return new Response(new Uint8Array(bytes), {
      headers: {
        "content-type": contentType,
        "content-length": String(bytes.byteLength),
        // Immutable: the key is a random UUID, so a cached response can never be
        // stale for a given key.
        "cache-control": "private, max-age=31536000, immutable",
        // Never let a browser sniff an mp4 into something executable.
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return handleError(error);
  }
}

async function canRead(key: string): Promise<boolean> {
  // A public generation is readable by anyone, session or not.
  const [publicRow] = await requireDb()
    .select({ id: schema.generations.id })
    .from(schema.generations)
    .where(
      and(
        eq(schema.generations.isPublic, true),
        eq(schema.generations.outputUrl, key),
      ),
    )
    .limit(1);
  if (publicRow) return true;

  const user = await getSessionUser();
  if (!user) return false;
  if (user.isAdmin) return true;

  const [owned] = await requireDb()
    .select({ id: schema.generations.id })
    .from(schema.generations)
    .where(
      and(
        eq(schema.generations.userId, user.id),
        eq(schema.generations.outputUrl, key),
      ),
    )
    .limit(1);

  return Boolean(owned);
}

/**
 * Content type from the key.
 *
 * The key ends in an extension we chose from the content type when we stored
 * it, so this is a reliable inverse -- and it is still worth constraining to a
 * known set rather than echoing whatever is in the path.
 */
function contentTypeFor(key: string): string {
  const lower = key.toLowerCase();
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}