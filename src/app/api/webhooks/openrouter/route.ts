import { createHmac, timingSafeEqual } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { requireDb, schema } from "@/lib/db";
import { env } from "@/lib/env";
import { apiError, handleError } from "@/lib/api";

/**
 * OpenRouter webhook receiver.
 *
 * Entirely optional. Polling already works, and on Vercel Hobby the polling
 * driver is the browser, which is the only thing that works on that plan
 * anyway. This route exists for deployments that *do* have a reliable
 * background process, or that want completion notifications without the user
 * keeping a tab open.
 *
 * Two details are load-bearing and easy to get wrong:
 *
 *  1. The signature is computed over `"{timestamp},{rawBody}"`, not over the
 *     parsed and re-serialised JSON. `await req.json()` then
 *     `JSON.stringify()` does not round-trip byte-for-byte -- key order and
 *     whitespace survive only by luck -- so a body that re-serialises
 *     identically is not guaranteed and the signature will fail intermittently.
 *     The raw text is used.
 *
 *  2. Replays are rejected. A signature is valid forever otherwise, so anyone
 *     who captured one could re-deliver an old "completed" event.
 */
export const dynamic = "force-dynamic";

const REPLAY_WINDOW_SECONDS = 300;

interface WebhookEvent {
  id?: string;
  /** The upstream job id. Named differently across event types. */
  job_id?: string;
  generation_id?: string;
  type?: string;
  status?: string;
  data?: Record<string, unknown>;
}

export async function POST(request: Request) {
  try {
    const raw = await request.text();

    if (!env.OPENROUTER_WEBHOOK_SECRET) {
      return apiError(
        "not_configured",
        "OPENROUTER_WEBHOOK_SECRET is not set, so webhooks cannot be verified and are rejected. " +
          "Polling continues to work without it.",
      );
    }

    const signature = request.headers.get("x-openrouter-signature");
    if (!signature) {
      return apiError("unauthorized", "Missing X-OpenRouter-Signature header.");
    }

    if (!verifySignature(raw, signature)) {
      return apiError("unauthorized", "Webhook signature did not verify.");
    }

    let event: WebhookEvent;
    try {
      event = JSON.parse(raw) as WebhookEvent;
    } catch {
      return apiError("validation_failed", "Body was not valid JSON.");
    }

    const jobId = event.job_id ?? event.generation_id ?? event.id;
    if (!jobId) {
      // Acknowledged rather than rejected: a well-signed event we do not
      // understand is not an error, and returning 4xx would make OpenRouter
      // retry it forever.
      return Response.json({ ok: true, ignored: "no job id in payload" });
    }

    const status = normaliseStatus(event.status ?? event.type ?? "");
    if (!status) {
      return Response.json({ ok: true, ignored: `unrecognised status "${event.status ?? event.type}"` });
    }

    // Idempotent by construction: only rows that are still in a non-terminal
    // state are touched, so redelivery is a no-op.
    const result = await requireDb()
      .update(schema.generations)
      .set({
        // A webhook says "your job is ready"; it does not download anything.
        // Move it to `downloading` and let the next tick pick it up, so all
        // media handling stays in one place.
        status: status === "completed" ? "downloading" : status,
        error: status === "failed" ? extractError(event) : sql`error`,
        nextPollAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.generations.openrouterJobId, jobId),
          inArray(schema.generations.status, ["queued", "submitting", "generating", "downloading"]),
        ),
      )
      .returning({ id: schema.generations.id });

    // The billed cost, when the webhook happens to carry it. Recorded here so a
    // crash during download does not lose it.
    const cost = extractCost(event);
    if (cost != null && result.length > 0) {
      await requireDb()
        .update(schema.generations)
        .set({ costActualMicro: Math.round(cost * 1_000_000) })
        .where(eq(schema.generations.id, result[0].id));
    }

    return Response.json({ ok: true, updated: result.length });
  } catch (error) {
    return handleError(error);
  }
}

/**
 * Verify `X-OpenRouter-Signature: t={ts},v1={hmac}`.
 *
 * Returns false rather than throwing on anything malformed: a bad signature is
 * an expected input, not an exceptional one.
 */
export function verifySignature(raw: string, header: string, secret = env.OPENROUTER_WEBHOOK_SECRET): boolean {
  if (!secret) return false;

  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const [k, v] = p.split("=", 2);
      return [k?.trim(), v?.trim()];
    }),
  ) as { t?: string; v1?: string };

  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return false;

  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > REPLAY_WINDOW_SECONDS) return false;

  const expected = createHmac("sha256", secret).update(`${timestamp},${raw}`).digest("hex");

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  // A malformed hex string decodes to a different length, and timingSafeEqual
  // throws on that. Compare lengths first.
  if (a.length !== b.length || a.length === 0) return false;

  return timingSafeEqual(a, b);
}

function normaliseStatus(status: string): "completed" | "failed" | "cancelled" | "expired" | null {
  const s = status.toLowerCase().replace(/^video\./, "");
  if (s === "completed" || s === "complete" || s === "succeeded") return "completed";
  if (s === "failed" || s === "error") return "failed";
  if (s === "cancelled" || s === "canceled") return "cancelled";
  if (s === "expired") return "expired";
  return null;
}

function extractError(event: WebhookEvent): string {
  const data = event.data ?? {};
  const message = data["error"];
  if (typeof message === "string") return message;
  if (message && typeof message === "object" && "message" in message) {
    return String((message as { message: unknown }).message);
  }
  return "Upstream reported a failure.";
}

function extractCost(event: WebhookEvent): number | null {
  const data = event.data ?? {};
  const usage = data["usage"];
  if (usage && typeof usage === "object" && "cost" in usage) {
    const cost = (usage as { cost: unknown }).cost;
    if (typeof cost === "number" && Number.isFinite(cost)) return cost;
  }
  return null;
}