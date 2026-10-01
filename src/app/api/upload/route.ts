import { apiError, ok } from "@/lib/api";
import { env } from "@/lib/env";
import { getSessionUser } from "@/lib/supabase/server";
import { storage, extensionForUpload, StorageError } from "@/lib/storage";

/**
 * `POST /api/upload` — accept a user-supplied image for use as a start frame or a
 * reference.
 *
 * Returns a storage key, not a URL. Two reasons: a key is a fraction of the size,
 * and it forces the later read through `/api/media`, which checks ownership. If
 * this returned a URL directly, that check would be bypassable by anyone who
 * captured one.
 */
export const dynamic = "force-dynamic";

/**
 * The cap, and why it is 4 MB rather than something comfortable.
 *
 * Vercel caps a function's **request** body at 4.5 MB. A 32 MB allowance here
 * would therefore have been a limit the app advertises and the platform silently
 * enforces first: the browser uploads 6 MB, gets `413 FUNCTION_PAYLOAD_TOO_LARGE`
 * with no explanation, and the app's own message never runs. Worse, the failure
 * would look like a bug rather than a limit, and only on Vercel.
 *
 * 4 MB sits under the platform ceiling with room for multipart framing overhead,
 * and is still generous for the actual use: the largest still any current model
 * emits is a few megabytes.
 *
 * Raise it with `MAX_UPLOAD_MB` when self-hosting behind something with a larger
 * body limit. Raising it on Vercel buys nothing.
 */
const MAX_MB = env.MAX_UPLOAD_MB;
const MAX_BYTES = MAX_MB * 1024 * 1024;

/**
 * Only formats a model can actually accept as an input image.
 *
 * An allowlist, not a blocklist. A blocklist has to enumerate every bad thing; an
 * allowlist only has to name the good ones, and everything unknown is refused by
 * default. This is also what stops a `.html` upload from being served back from
 * our own origin with a `text/html` type.
 */
const ACCEPTED = new Set(["image/png", "image/jpeg", "image/webp"]);

export async function POST(request: Request) {
  const user = await getSessionUser();
  if (!user) return apiError("unauthorized", "Sign in to upload an image.");

  if (!request.headers.get("content-type")?.includes("multipart/form-data")) {
    return apiError(
      "validation_failed",
      "Send the file as multipart/form-data with a field named 'file'.",
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    // A body that is not parseable as multipart is malformed, not a server fault.
    return apiError("validation_failed", "The upload could not be read. Try again.");
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return apiError("validation_failed", "No file was included.");
  }

  if (file.size === 0) {
    return apiError("validation_failed", "That file is empty.");
  }

  if (file.size > MAX_BYTES) {
    return apiError(
      "validation_failed",
      `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is ${MAX_MB} MB - a 4K photo is well under it, so the file is probably a video.`,
    );
  }

  // The browser-reported type is a hint, not evidence. It is the only input
  // available before the bytes are read, so it is checked here and the extension
  // is then derived from it rather than from the filename.
  const contentType = (file.type || "").toLowerCase().split(";")[0].trim();
  if (!ACCEPTED.has(contentType)) {
    return apiError(
      "validation_failed",
      `Only PNG, JPEG and WebP images can be uploaded${contentType ? `; this was ${contentType}` : ""}.`,
    );
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await file.arrayBuffer());
  } catch {
    return apiError("validation_failed", "The file could not be read.");
  }

  try {
    const stored = await storage.put(bytes, {
      kind: "upload",
      // Extension comes from the validated MIME type, so `photo.png.html` cannot
      // choose what this is served as later.
      contentType,
      extensionOverride: extensionForUpload(file.name, contentType),
    });

    return ok({
      key: stored.key,
      bytes: stored.bytes,
      contentType: stored.contentType,
    });
  } catch (error) {
    if (error instanceof StorageError) {
      return apiError("storage_unavailable", error.message);
    }
    throw error;
  }
}

/**
 * The reason this route refuses to echo back a URL.
 *
 * Exported so the note above is not just a comment nobody sees: if someone later
 * adds `url` to the response for convenience, the temptation is documented here.
 */
export const UPLOAD_RETURNS_KEY_NOT_URL = true;
