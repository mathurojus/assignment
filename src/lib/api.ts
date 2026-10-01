import type { NextResponse } from "next/server";
import { ZodError } from "zod";
import { isOpenRouterError, type OpenRouterError } from "@/lib/openrouter/errors";
import { isDatabaseUnavailable } from "@/lib/db";
import { envProblems } from "@/lib/env";

/**
 * One error shape for every route, so the client has exactly one thing to parse.
 *
 * `code` is the stable machine-readable part; `message` is for humans and is
 * always safe to render. Upstream error bodies are never passed through raw,
 * because they can contain request fragments and occasionally echo the key.
 */

export type ApiErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "validation_failed"
  | "rate_limited"
  | "insufficient_credits"
  | "concurrent_limit"
  | "spend_cap"
  | "not_configured"
  | "upstream_error"
  | "upstream_credits"
  | "database_unavailable"
  | "storage_unavailable"
  | "internal_error";

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  validation_failed: 400,
  rate_limited: 429,
  insufficient_credits: 402,
  concurrent_limit: 429,
  spend_cap: 429,
  not_configured: 503,
  upstream_error: 502,
  upstream_credits: 502,
  database_unavailable: 503,
  storage_unavailable: 503,
  internal_error: 500,
};

export function apiError(code: ApiErrorCode, message: string, extra?: Record<string, unknown>) {
  const body = { error: { code, message, ...extra } };
  return NextResponse.json(body, { status: STATUS_BY_CODE[code] });
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/** Flatten a ZodError into something a form can put next to a field. */
function fieldErrors(error: ZodError) {
  const out: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "_";
    (out[key] ??= []).push(issue.message);
  }
  return out;
}

/**
 * Map any thrown value to a response.
 *
 * The mapping is deliberate rather than a generic catch-all, because the
 * difference between "you have no money" and "OpenRouter is down" is the
 * difference between a fixable user problem and a bug report.
 */
export function handleError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return apiError("validation_failed", "That request was not valid.", {
      fields: fieldErrors(error),
    });
  }

  if (isDatabaseUnavailable(error)) {
    return apiError("database_unavailable", error.message);
  }

  if (isOpenRouterError(error)) {
    const e = error as OpenRouterError;
    if (e.kind === "insufficient_credits") {
      return apiError("upstream_credits", e.userMessage, {
        upstream: "openrouter",
        status: e.status,
      });
    }
    return apiError("upstream_error", e.userMessage, {
      upstream: "openrouter",
      status: e.status,
      kind: e.kind,
    });
  }

  // A route that needs configuration which is not present. Surfaced separately
  // from internal_error so the setup banner can act on it.
  if (error instanceof NotConfiguredError) {
    return apiError("not_configured", error.message, { variable: error.variable });
  }

  if (error instanceof StorageUnavailableError) {
    return apiError("storage_unavailable", error.message);
  }

  // Anything unexpected is logged in full server-side and returned as a generic
  // message. Never leak a stack trace to the client.
  console.error("[api] unhandled error", error);
  return apiError(
    "internal_error",
    "Something went wrong on our side. The error has been logged.",
    ...(process.env.NODE_ENV === "development"
      ? { debug: error instanceof Error ? error.message : String(error) }
      : {}),
  );
}

export class NotConfiguredError extends Error {
  readonly code = "NOT_CONFIGURED";
  constructor(
    readonly variable: string,
    message?: string,
  ) {
    super(message ?? `${variable} is not set, so this feature is unavailable. See .env.example.`);
    this.name = "NotConfiguredError";
  }
}

export class StorageUnavailableError extends Error {
  readonly code = "STORAGE_UNAVAILABLE";
  constructor(message: string) {
    super(message);
    this.name = "StorageUnavailableError";
  }
}

/** Run a handler, converting any thrown value into the standard error shape. */
export async function route<T extends unknown[]>(
  handler: (...args: T) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    return await handler();
  } catch (error) {
    return handleError(error);
  }
}

export { envProblems };