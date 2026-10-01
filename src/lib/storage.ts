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
  /** Original filename, used only to derive an extension. */
  filename?: string;
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

function extensionFor(contentType: string, filename?: string): string {
  const allowed = EXTENSIONS[contentType];
  if (!allowed) {
    // Unknown type: no extension rather than trusting the client's filename.
    return "";
  }
  return allowed[0];
}

function buildKey(kind: StorageKind, contentType: string, filename?: string): string {
  const ext = extensionFor(contentType, filename);
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
    const key = buildKey(opts.kind, opts.contentType, opts.filename);
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
    const key = buildKey(opts.kind, opts.contentType, opts.filename);
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

export function isStorageReady(): boolean {
  return env.STORAGE_DRIVER === "local" || Boolean(env.SUPABASE_SERVICE_ROLE_KEY);
}