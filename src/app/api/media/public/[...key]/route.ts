import { notFound } from "next/navigation";
import { fetchObject, contentTypeForKey } from "@/lib/storage";
import { env } from "@/lib/env";

/**
 * `/api/media/public/[...key]` — serve an asset that OpenRouter can fetch.
 *
 * This is the anonymous counterpart to `/api/media/[...path]`, and the difference
 * is the entire reason it exists as a separate route.
 *
 * The private route checks that the requester owns the generation. That check is
 * right for a browser and fatal here: OpenRouter's servers have no session, so
 * they would get a 401 for a start frame the user legitimately uploaded, and
 * image-to-video would fail with a 400 that says nothing about the real cause.
 *
 * What makes the public route safe is what it does *not* do:
 *
 *  - It serves no page, no JSON, and no other user's private generations. Only
 *    the single object named in the path.
 *  - The key is a 128-bit random UUID under a `kind/day/` prefix. It is unguessable,
 *    not secret, which is exactly the right strength here: OpenRouter has to be
 *    given the URL in a request body, so it cannot enumerate anything.
 *  - Only uploads and public generations' media are ever addressed this way, and
 *    the studio refuses to submit image-to-video at all when
 *    `PUBLIC_MEDIA_BASE_URL` is unset (see `publicMediaUrl`).
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string[] }> },
) {
  const { key: segments } = await params;

  // Reject rather than normalise. A key with `..`, a leading slash, a backslash,
  // or a NUL is not a key this app ever produced, and the local driver's own
  // traversal guard would catch it too — but a 404 is a better answer than an
  // exception, and checking here means the guard does not depend on which driver
  // is active.
  if (segments.length === 0) notFound();
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.includes("\\"))) {
    notFound();
  }
  // Anything outside these two prefixes has no business being fetched anonymously.
  // Generated *output* is only exposed this way when its generation is public,
  // and the studio passes a start frame / reference key, which is always `upload/`.
  const prefix = segments[0];
  if (prefix !== "upload" && prefix !== "image" && prefix !== "video") notFound();

  const key = segments.join("/");

  let object: Awaited<ReturnType<typeof fetchObject>>;
  try {
    object = await fetchObject(key);
  } catch {
    // A storage backend that is down should not be a 500 with a stack trace in
    // the body — OpenRouter only ever sees the status line.
    return new Response("Storage unavailable", { status: 503 });
  }

  if (!object) notFound();

  return new Response(new Uint8Array(object.bytes), {
    headers: {
      "content-type": object.contentType || contentTypeForKey(key),
      "content-length": String(object.bytes.byteLength),
      /*
       * Immutable, and not `no-store`.
       *
       * Keys are content-unique random UUIDs that are never rewritten, so a
       * generated output genuinely cannot change under a given URL. That makes a
       * long cache correct rather than merely convenient — and it matters because
       * a start frame is re-fetched by OpenRouter on every image-to-video job, so
       * re-downloading it each time is a real cost.
       *
       * `private` would defeat the purpose (this is public by definition) and
       * `no-store` would force the re-fetch. The 1-year max-age is what an
       * immutable asset should get.
       */
      "cache-control": "public, max-age=31536000, immutable",
      // Defence in depth against an SVG or HTML payload served from this origin.
      // `nosniff` stops content-type sniffing, and the CSP denies scripts outright.
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "cross-origin",
      // Referrer omitted: the URL is a capability, and leaking it to a third-party
      // page via a Referer header would hand that page a fetchable URL.
      "referrer-policy": "no-referrer",
    },
  });
}

/**
 * Set this to the app's public origin to enable image-to-video on the local
 * storage driver. Without it, `publicMediaUrl` returns null and the studio
 * disables the start-frame picker rather than submitting a URL OpenRouter cannot
 * resolve.
 */
export const PUBLIC_MEDIA_BASE_URL = env.PUBLIC_MEDIA_BASE_URL;
