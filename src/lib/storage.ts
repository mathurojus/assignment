import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";

/**
 * Object storage with two drivers.
 *
 *  local    -> ./storage/local, served by a Next route handler.
 *             Zero setup and zero egress cost, which is what you want on the
 *             free tier and it makes `npm run dev` work before anything is
 *             configured.
 *  supabase -> a Supabase Storage bucket. Needed on Vercel, where the server
 *             filesystem is read-only and disappears between invocations.
 *
 * The driver is chosen by STORAGE_DRIVER. Both satisfy the same interface, so
 * nothing above this file needs to know which is active.
 */

export type StorageKind = "video" | "image" | "upload";

export interface StoredObject {
  /** Storage key. Opaque; never a public URL. */
  key: string;
  bytes: number;
  contentType: string;
}

export interface PutOptions {
  contentType: string;
  kind: StorageKind;
  /**
   * Force a specific extension, used by the upload route.
   *
   * Optional because generated output derives its extension from the content type
   * the upstream API told us, and that derivation is already correct. The upload
   * route needs this because it must distinguish a user-supplied name from the
   * validated MIME type — and it is an override rather than a fourth argument
   * precisely so the generated path cannot be given a wrong extension by accident.
   */
  extensionOverride?: string;
}

export class StorageError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "StorageError";
  }
}

const EXTENSIONS: Record<string, string[]> = {
  "video/mp4": [".mp4"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
};

/**
 * The extension to write, chosen from the *content type* alone.
 *
 * Deliberately not derived from the client's filename. A filename is attacker
 * controlled, so `victim.png.html` or `../../x.mp4` would ride straight through
 * a naive `path.extname()` call. The content type is the only trustworthy
 * input, and an unknown type gets no extension rather than a guess.
 */
function extensionFor(contentType: string): string {
  return EXTENSIONS[contentType]?.[0] ?? "";
}

function buildKey(kind: StorageKind, contentType: string, override?: string): string {
  // The override is sanitised at the boundary before it gets here, and re-checked
  // here: `PutOptions` is a plain interface that any caller could construct, so the
  // storage layer does not take the caller's word for it.
  const ext =
    override && /^\.[a-z0-9]{1,8}$/.test(override) ? override : extensionFor(contentType);
  const day = new Date().toISOString().slice(0, 10);
  // Random rather than content-addressed: two identical renders are two
  // objects, and the random name avoids leaking a guessable hash.
  return `${kind}/${day}/${randomUUID()}${ext}`;
}

// ---------------------------------------------------------------------------
// Local driver
// ---------------------------------------------------------------------------

const LOCAL_ROOT = path.join(process.cwd(), "storage", "local");

function resolveLocal(key: string): string {
  const full = path.join(LOCAL_ROOT, key);
  // Refuse anything that escapes the root. Keys are server-generated today, but
  // a storage layer that trusts its input is one refactor away from a
  // path-traversal bug.
  const normalisedRoot = path.resolve(LOCAL_ROOT);
  const normalisedFull = path.resolve(full);
  if (!normalisedFull.startsWith(normalisedRoot + path.sep)) {
    throw new StorageError("Refusing to access a path outside the storage root");
  }
  return normalisedFull;
}

const local = {
  async put(data: Buffer | Uint8Array, opts: PutOptions): Promise<StoredObject> {
    const key = buildKey(opts.kind, opts.contentType, opts.extensionOverride);
    const target = resolveLocal(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return { key, bytes: data.byteLength, contentType: opts.contentType };
  },
  async get(key: string): Promise<Buffer | null> {
    try {
      return await fs.readFile(resolveLocal(key));
    } catch {
      return null;
    }
  },
  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(resolveLocal(key));
    } catch {
      // Already gone. Nothing to do.
    }
  },
  /** Stable route on our own origin, which works without Supabase. */
  async url(key: string): Promise<string> {
    return `/api/media/${encodeURIComponent(key)}`;
  },
};

// ---------------------------------------------------------------------------
// Supabase driver
// ---------------------------------------------------------------------------

const supabase = {
  async put(data: Buffer | Uint8Array, opts: PutOptions): Promise<StoredObject> {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const client = await getSupabaseAdmin();
    const key = buildKey(opts.kind, opts.contentType, opts.extensionOverride);
    const { error } = await client.storage
      .from(env.STORAGE_BUCKET)
      .upload(key, data, { contentType: opts.contentType, upsert: false });
    if (error) throw new StorageError(`Supabase upload failed: ${error.message}`, error);
    return { key, bytes: data.byteLength, contentType: opts.contentType };
  },
  async get(key: string): Promise<Buffer | null> {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const client = await getSupabaseAdmin();
    const { data, error } = await client.storage.from(env.STORAGE_BUCKET).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  },
  async delete(key: string): Promise<void> {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const client = await getSupabaseAdmin();
    await client.storage.from(env.STORAGE_BUCKET).remove([key]);
  },
  async url(key: string): Promise<string> {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const client = await getSupabaseAdmin();
    // Signed, not public. A 1 hour window is plenty: it is issued at read time
    // for the requester's own browser, not embedded in a shared link.
    const { data, error } = await client.storage
      .from(env.STORAGE_BUCKET)
      .createSignedUrl(key, 3600, { download: false });
    if (error || !data) return `/api/media/${encodeURIComponent(key)}`;
    return data.signedUrl;
  },
};

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface Storage {
  put(data: Buffer | Uint8Array, opts: PutOptions): Promise<StoredObject>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  url(key: string): Promise<string>;
}

export const storage: Storage = env.STORAGE_DRIVER === "supabase" ? supabase : local;

/**
 * A URL OpenRouter's servers can fetch.
 *
 * This is not the same problem as "a URL the user's browser can load". Our own
 * `/api/media/...` route requires the requester's session, so OpenRouter would
 * get a redirect to a login page and the video job would fail with a 400 that
 * says nothing useful.
 *
 * So: with the local driver and no public origin, image-to-video genuinely
 * cannot work, and the honest thing is to say so instead of sending a URL that
 * will not resolve.
 */
export async function publicMediaUrl(key: string): Promise<string | null> {
  if (env.STORAGE_DRIVER === "supabase") {
    const { getSupabaseAdmin } = await import("@/lib/supabase/admin");
    const client = await getSupabaseAdmin();
    const { data, error } = await client.storage
      .from(env.STORAGE_BUCKET)
      .createSignedUrl(key, 3600, { download: false });
    if (!error && data) return data.signedUrl;
    return null;
  }

  if (!env.PUBLIC_MEDIA_BASE_URL) return null;
  return `${env.PUBLIC_MEDIA_BASE_URL}/api/media/public/${key}`;
}

/**
 * An extension for a user-supplied filename, or "" when the type is unknown.
 *
 * The mapping is MIME-first and filename-second, deliberately. A caller-supplied
 * filename is attacker-controlled data: `evil.html` uploaded as a video would be
 * served with a `text/html` content type from our own origin, which turns any
 * arbitrary-URL bug elsewhere into stored XSS on this app's domain. So the content
 * type decides the extension, and the caller's filename is only consulted after the
 * MIME type has been rejected as one we do not accept.
 */
export function extensionForUpload(name: string, contentType: string): string {
  const fromMime = EXTENSIONS[contentType];
  if (fromMime) return fromMime[0];

  // Not a type we store. Still sanitise: a filename is a string, not a path, and
  // the extension is reduced to `[a-z0-9]{1,8}` or dropped.
  const ext = name.includes(".") ? (name.split(".").pop() ?? "") : "";
  return /^[a-z0-9]{1,8}$/i.test(ext) ? `.${ext.toLowerCase()}` : "";
}

/**
 * Bytes, and how to serve them.
 *
 * A `Buffer` rather than a stream because the local driver writes with
 * `fs.readFile` anyway, and the Supabase driver's `download` is an arrayBuffer
 * behind a REST call. A `ReadableStream` here would be a stream that is always
 * fully buffered before it starts, which is a more misleading type than an honest
 * Buffer.
 */
export interface FetchedObject {
  bytes: Buffer;
  contentType: string;
}

/** Read an object, or null when it is not there. */
export async function fetchObject(key: string): Promise<FetchedObject | null> {
  const bytes = await storage.get(key);
  if (!bytes) return null;
  return { bytes, contentType: contentTypeForKey(key) };
}

/**
 * The content type to serve a stored object with.
 *
 * Derived from the key's extension, which is the same MIME table `put` used to
 * choose that extension — so the two cannot disagree. An unrecognised extension
 * falls back to `application/octet-stream`, which makes the browser download the
 * file rather than trying to interpret it. That is the safe default: rendering
 * unknown bytes as a guessed type is how a stored-XSS bug happens.
 */
export function contentTypeForKey(key: string): string {
  const ext = key.includes(".") ? (key.split(".").pop() ?? "").toLowerCase() : "";
  if (!ext) return "application/octet-stream";
  for (const [mime, exts] of Object.entries(EXTENSIONS)) {
    if (exts.includes(ext)) return mime;
  }
  return "application/octet-stream";
}

export function isStorageReady(): boolean {
  return env.STORAGE_DRIVER === "local" || Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
}