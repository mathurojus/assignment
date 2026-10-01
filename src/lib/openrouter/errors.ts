/**
 * Typed errors for the OpenRouter client.
 *
 * The important one is `InsufficientCreditsError`, and the important property
 * is that it is **never retried**. Retrying a 402 cannot succeed, it just burns
 * wall-clock time and, in a retry loop with backoff, hides the real failure
 * behind a generic timeout.
 */

export type OpenRouterErrorKind =
  | "auth"
  | "insufficient_credits"
  | "rate_limited"
  | "bad_request"
  | "not_found"
  | "server"
  | "network"
  | "timeout"
  | "aborted"
  | "malformed_response"
  | "unknown";

export class OpenRouterError extends Error {
  readonly kind: OpenRouterErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly requestId?: string;
  /** Whether retrying this could plausibly succeed. */
  readonly retryable: boolean;
  /** Seconds the upstream asked us to wait, from Retry-After. */
  readonly retryAfterMs?: number;
  readonly body?: unknown;

  constructor(init: {
    kind: OpenRouterErrorKind;
    message: string;
    status?: number;
    code?: string;
    requestId?: string;
    retryable?: boolean;
    retryAfterMs?: number;
    body?: unknown;
  }) {
    super(init.message);
    this.name = "OpenRouterError";
    this.kind = init.kind;
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.retryable = init.retryable ?? defaultRetryable(init.kind);
    this.retryAfterMs = init.retryAfterMs;
    this.body = init.body;
  }

  /** Safe to show a user. Never includes the key or the full upstream body. */
  get userMessage(): string {
    switch (this.kind) {
      case "insufficient_credits":
        return "Your OpenRouter account is out of credit. Add funds at openrouter.ai/credits, then retry.";
      case "auth":
        return "OPENROUTER_API_KEY is missing or invalid. Check your .env.local.";
      case "rate_limited":
        return "OpenRouter is rate limiting this key. Waiting and retrying.";
      case "bad_request":
        return `OpenRouter rejected the request: ${this.message}`;
      case "not_found":
        return "That model does not exist on OpenRouter any more. Pick another from the list.";
      case "timeout":
        return "OpenRouter did not respond in time. The job may still be running upstream; retrying is safe.";
      case "network":
        return "Could not reach OpenRouter. Check your network connection.";
      case "server":
        return `OpenRouter had an internal error (${this.status ?? "5xx"}). This is usually transient.`;
      default:
        return "Unexpected error talking to OpenRouter.";
    }
  }
}

/** 402. Not retryable, and the single most important distinction here. */
export class InsufficientCreditsError extends OpenRouterError {
  constructor(init: { message?: string; requestId?: string } = {}) {
    super({
      kind: "insufficient_credits",
      status: 402,
      message: init.message ?? "OpenRouter account has insufficient credit",
      requestId: init.requestId,
      retryable: false,
    });
    this.name = "InsufficientCreditsError";
  }
}

export class RateLimitedError extends OpenRouterError {
  constructor(init: { retryAfterMs?: number; requestId?: string } = {}) {
    super({
      kind: "rate_limited",
      status: 429,
      message: "Rate limited by OpenRouter",
      requestId: init.requestId,
      retryable: true,
      retryAfterMs: init.retryAfterMs,
    });
    this.name = "RateLimitedError";
  }
}

export class TimeoutError extends OpenRouterError {
  constructor(ms: number) {
    super({ kind: "timeout", message: `Request timed out after ${ms}ms`, retryable: true });
    this.name = "TimeoutError";
  }
}

function defaultRetryable(kind: OpenRouterErrorKind): boolean {
  switch (kind) {
    case "server":
    case "network":
    case "timeout":
    case "rate_limited":
    case "malformed_response":
      return true;
    // A 400 is the request's fault. A 401 will not fix itself. A 402 will
    // never fix itself without the user topping up.
    case "bad_request":
    case "auth":
    case "insufficient_credits":
    case "not_found":
    case "aborted":
    case "unknown":
      return false;
  }
}

export function isOpenRouterError(e: unknown): e is OpenRouterError {
  return e instanceof OpenRouterError;
}