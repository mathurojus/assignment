import { env } from "@/lib/env";
import {
  InsufficientCreditsError,
  OpenRouterError,
  RateLimitedError,
  TimeoutError,
  type OpenRouterErrorKind,
} from "./errors";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Headers OpenRouter documents as required for attribution.
 *
 * Both are set on every request rather than only the ones where it seems to
 * matter, because a request without them is harder to support when something
 * goes wrong upstream.
 */
function attributionHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (env.NEXT_PUBLIC_SITE_URL) h["HTTP-Referer"] = env.NEXT_PUBLIC_SITE_URL;
  h["X-Title"] = "Vantage";
  return h;
}

function kindForStatus(status: number): OpenRouterErrorKind {
  if (status === 402) return "insufficient_credits";
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  if (status >= 400) return "bad_request";
  return "unknown";
}

function retryAfterMsFrom(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : undefined;
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called before each retry. Used for logging, not control flow. */
  onRetry?: (info: { attempt: number; delayMs: number; error: OpenRouterError }) => void;
  /** Deterministic jitter source, for tests. */
  random?: () => number;
}

export interface RequestOptions extends RetryOptions {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
  /** Abort after this many ms and throw TimeoutError. */
  timeoutMs?: number;
  /** Interpret a non-2xx as this instead of inferring from the status code. */
  fetchImpl?: FetchLike;
  /** What to do with the response body: parse as JSON (default) or hand back raw bytes. */
  responseType?: "json" | "binary";
}

/**
 * The single network chokepoint.
 *
 * Everything that talks to OpenRouter goes through this, which is what makes
 * "retries, exponential backoff, timeouts, typed errors" a property of the
 * integration rather than something each call site remembers to do.
 */
export async function openrouterFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const {
    method = "GET",
    body,
    headers: extraHeaders,
    attempts = 4,
    baseDelayMs = 500,
    maxDelayMs = 20_000,
    timeoutMs = 60_000,
    signal,
    onRetry,
    random = Math.random,
    fetchImpl,
    responseType = "json",
  } = options;

  const url = path.startsWith("http") ? path : `${OPENROUTER_BASE}${path}`;
  const doFetch = fetchImpl ?? ((u: string, i?: RequestInit) => fetch(u, i));

  let lastError: OpenRouterError | undefined;

  for (let attempt = 0; attempt < attempts; attempt++) {
    // Per-attempt timeout, composed with any caller-supplied abort signal so a
    // request can be bounded by both "too slow" and "caller gave up".
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

    try {
      const res = await doFetch(url, {
        method,
        signal: combined,
        headers: {
          ...attributionHeaders(),
          ...(env.OPENROUTER_API_KEY ? { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` } : {}),
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...extraHeaders,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (res.ok) {
        // Binary passthrough for video content downloads. Parsing those as JSON
        // is how you end up with a saved HTML error page named output.mp4.
        if (responseType === "binary") {
          const buffer = Buffer.from(await res.arrayBuffer());
          return {
            bytes: buffer,
            contentType: res.headers.get("content-type") ?? "application/octet-stream",
          } as T;
        }

        const text = await res.text();
        if (!text) return undefined as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new OpenRouterError({
            kind: "malformed_response",
            message: "OpenRouter returned a body that is not valid JSON",
            status: res.status,
            retryable: false,
          });
        }
      }

      // A 4xx that is not retryable, or a 401/402, fails immediately.
      const kind = kindForStatus(res.status);
      const retryAfterMs = retryAfterMsFrom(res);
      const requestId =
        res.headers.get("x-request-id") ?? res.headers.get("cf-ray") ?? undefined;

      let payload: unknown;
      const text = await res.text();
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text.slice(0, 400);
      }

      // `??` and `||` cannot be mixed without parentheses, and they are not
        // interchangeable here: a present-but-empty message should fall through
        // to the status line rather than produce an empty error string.
        const structured = (payload as { error?: { message?: string } })?.error?.message;
        const raw = typeof payload === "string" ? payload : "";
        const upstreamMessage = structured ?? (raw || `HTTP ${res.status}`);

      const error =
        kind === "insufficient_credits"
          ? new InsufficientCreditsError({ message: upstreamMessage, requestId })
          : kind === "rate_limited"
            ? new RateLimitedError({ retryAfterMs, requestId })
            : new OpenRouterError({
                kind,
                status: res.status,
                message: upstreamMessage,
                code: (payload as { error?: { code?: string } })?.error?.code,
                requestId,
                retryAfterMs,
                body: payload,
              });

      // Not retryable -> surface now rather than burning attempts.
      if (!error.retryable) throw error;
      lastError = error;
    } catch (caught) {
      if (caught instanceof OpenRouterError) {
        if (!caught.retryable) throw caught;
        lastError = caught;
      } else if (isAbort(caught, signal)) {
        // Caller cancelled. Respect it: do not retry.
        throw new OpenRouterError({ kind: "aborted", message: "Request aborted by caller", retryable: false });
      } else if (isTimeout(caught)) {
        lastError = new TimeoutError(timeoutMs);
      } else {
        lastError = new OpenRouterError({
          kind: "network",
          message: caught instanceof Error ? caught.message : "Network request failed",
          retryable: true,
        });
      }
    }

    if (attempt === attempts - 1) break;

    // Exponential backoff with full jitter. Honour Retry-After when the server
    // bothered to send one, because ignoring an explicit instruction from a
    // rate limiter is how you get a longer ban.
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
    const delayMs = lastError.retryAfterMs ?? Math.round(exponential * (0.5 + random() * 0.5));

    onRetry?.({ attempt: attempt + 1, delayMs, error: lastError });

    if (signal?.aborted) break;
    await sleep(delayMs, signal);
  }

  throw lastError ?? new OpenRouterError({ kind: "unknown", message: "Request failed", retryable: false });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new OpenRouterError({ kind: "aborted", message: "Aborted while backing off" }));
      },
      { once: true },
    );
  });
}

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  return e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

export { attributionHeaders };