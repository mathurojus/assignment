import { openrouterFetch } from "./client";
import { imageGenerateBody, videoGenerateBody } from "./schemas";
import { env } from "@/lib/env";

/**
 * Submitting a video and reading its result.
 *
 * The upstream contract, from the docs plus a live `GET /videos/models`:
 *
 *   POST /videos              -> 202 { id, polling_url, status: "pending" }
 *   GET  /videos/{id}         -> { status, unsigned_urls?, usage?: { cost } }
 *   GET  /videos/{id}/content -> the bytes (needs the Authorization header)
 *
 * Documented statuses are pending | in_progress | completed | failed.
 * `cancelled` and `expired` appear only as webhook events, never in the poll
 * response table -- which is itself the answer to "can we cancel a job": see
 * PLAN.md Q3.
 */

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

export interface VideoSubmitResult {
  id: string;
  polling_url: string;
  status: string;
}

export async function submitVideo(
  body: unknown,
  opts: { callbackUrl?: string; signal?: AbortSignal } = {},
): Promise<VideoSubmitResult> {
  const parsed = videoGenerateBody.parse(body);
  const payload: Record<string, unknown> = { ...parsed };

  // Only attach a callback when it is actually reachable. Sending a callback_url
  // that resolves nowhere means relying on a webhook we will never receive.
  if (opts.callbackUrl && env.OPENROUTER_WEBHOOK_SECRET) {
    payload.callback_url = opts.callbackUrl;
  }

  return openrouterFetch<VideoSubmitResult>("/videos", {
    method: "POST",
    body: payload,
    // Submission itself should be quick; the video generation is async.
    timeoutMs: 30_000,
    attempts: 3,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export type UpstreamStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | string; // forward-compatible: do not choke on a status we have not seen

export interface VideoPollResult {
  id: string;
  status: UpstreamStatus;
  generation_id?: string | null;
  model?: string | null;
  unsigned_urls?: string[] | null;
  usage?: { cost?: number | null; is_byok?: boolean | null } | null;
  error?: string | { message?: string } | null;
}

export const TERMINAL_UPSTREAM: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export async function pollVideo(jobId: string, signal?: AbortSignal): Promise<VideoPollResult> {
  return openrouterFetch<VideoPollResult>(`/videos/${encodeURIComponent(jobId)}`, {
    timeoutMs: 20_000,
    attempts: 2,
    ...(signal ? { signal } : {}),
  });
}

/** Normalise the `error` field, which the docs show as sometimes a string. */
export function upstreamErrorMessage(error: VideoPollResult["error"]): string | null {
  if (!error) return null;
  if (typeof error === "string") return error;
  return error.message ?? null;
}

/**
 * Fetch the video bytes.
 *
 * `unsigned_urls` are NOT presigned: the Authorization header is still
 * required. This is the detail the docs call out and it is easy to miss, which
 * would surface as an HTML error page saved as a .mp4.
 */
export async function downloadVideo(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ bytes: Buffer; contentType: string }> {
  const target = url.includes("/content")
    ? url
    : `${url.replace(/\/$/, "")}/content?index=0`;

  // responseType "binary" is load-bearing: these URLs are not presigned, the
  // Authorization header is still required, and the body is mp4 bytes rather
  // than JSON.
  return openrouterFetch<{ bytes: Buffer; contentType: string }>(target, {
    method: "GET",
    attempts: 3,
    responseType: "binary",
    timeoutMs: opts.timeoutMs ?? 180_000,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export interface ImageGenerateResult {
  created: number;
  data: Array<{ b64_json?: string; url?: string; media_type?: string }>;
  usage?: { cost?: number | null; total_tokens?: number } | null;
}

/**
 * Generate images.
 *
 * Note the response carries **base64, not a URL**. There is no hosted asset to
 * hand to OpenRouter's video endpoint, so a generated start frame must be
 * uploaded to our own storage and re-read as a URL before it can be used as a
 * `frame_images` input. That is why storage is not optional plumbing here.
 */
export async function generateImages(
  body: unknown,
  opts: { signal?: AbortSignal } = {},
): Promise<ImageGenerateResult> {
  const parsed = imageGenerateBody.parse(body);
  return openrouterFetch<ImageGenerateResult>("/images", {
    method: "POST",
    body: parsed,
    // Image generation is synchronous and slow: the docs show 94s for gpt-image-2.
    timeoutMs: 300_000,
    attempts: 2,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

// ---------------------------------------------------------------------------
// Chat (prompt enhancer)
// ---------------------------------------------------------------------------

export interface ChatResult {
  choices: Array<{ message: { content: string | null } }>;
  usage?: { cost?: number | null; total_tokens?: number } | null;
}

export async function chat(
  body: { model: string; messages: Array<{ role: "system" | "user"; content: string }>; temperature?: number; max_tokens?: number },
  opts: { signal?: AbortSignal } = {},
): Promise<ChatResult> {
  return openrouterFetch<ChatResult>("/chat/completions", {
    method: "POST",
    body,
    timeoutMs: 60_000,
    attempts: 3,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}