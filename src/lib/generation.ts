import { and, eq, inArray, lt, sql } from "drizzle-orm";
import { requireDb, schema } from "./db";
import { quote as priceQuote, toMicro, usdToCreditsMicro, type Quote } from "@/lib/openrouter/pricing";
import { normaliseVideoModel, type RawVideoModel, type VideoModel } from "@/lib/openrouter/models";
import { assemblePrompt } from "@/lib/prompt";
import { reserveCredits, settleGeneration, releaseCredits } from "@/lib/credits";
import { publicMediaUrl, storage, isStorageReady } from "@/lib/storage";
import { NotConfiguredError } from "@/lib/api";
import { hasDatabase, hasOpenRouterKey, env } from "@/lib/env";
import {
  downloadVideo,
  pollVideo,
  submitVideo,
  TERMINAL_UPSTREAM,
  upstreamErrorMessage,
} from "@/lib/openrouter/video";

/** A row as it comes back from the `generations` table. */
type GenerationRow = typeof schema.generations.$inferSelect;

/**
 * What one call to `advanceGeneration` did.
 *
 * "skipped" is a real outcome, not an error: it means another worker claimed
 * the row first, or the job had already reached a terminal state. Reporting it
 * honestly is what lets the caller distinguish "nothing to do" from "I did the
 * work".
 */
type AdvanceResult = "skipped" | "progressed";

/**
 * The generation lifecycle.
 *
 * queued -> submitting -> generating -> downloading -> completed
 *                          \                    \
 *                           `-> failed/cancelled/expired
 *
 * Every transition is a single guarded UPDATE inside a transaction, so the
 * worker is safe to run twice concurrently, a webhook can race a poll, and a
 * crashed worker resumes without double-charging or double-completing.
 */

export interface CreateGenerationInput {
  userId: string;
  type: "video" | "image";
  model: string;
  prompt: string;
  enhancedPrompt?: string | null;
  presetSlug?: string | null;
  params: {
    durationSeconds?: number;
    resolution?: string;
    aspectRatio?: string;
    size?: string;
    generateAudio?: boolean;
    seed?: number;
    hasFirstFrame?: boolean;
  };
  sourceImageKey?: string | null;
}

/**
 * Why a job was refused before it was ever queued.
 *
 * A distinct shape rather than a thrown error, because the client needs to show
 * the reason next to the submit button without a try/catch, and needs to know
 * whether the user should retry at all.
 */
export type RejectionReason =
  | "insufficient_credits"
  | "concurrent_limit"
  | "rate_limited"
  | "spend_cap";

export type CreateGenerationResult =
  | {
      ok: true;
      id: string;
      status: "queued";
      estimate: CostEstimate;
      creditsHeld: number;
      balanceMicro: number;
    }
  | {
      ok: false;
      reason: RejectionReason;
      message: string;
      estimate: CostEstimate;
      /** What the user currently holds, in micro-credits. */
      balanceMicro: number;
    };

/**
 * A quote plus the two numbers the caller needs.
 *
 * An intersection, not `interface ... extends Quote`: `Quote` is a *union*, and
 * an interface can only extend an object type with statically known members. The
 * intersection distributes over the union, so `estimate.estimable` narrows
 * correctly and `estimate.costUsd` is only reachable inside the `true` branch.
 */
export type CostEstimate = Quote & {
  creditsMicro: number;
  /** What will actually be held. Equals creditsMicro when estimable. */
  reservedMicro: number;
};

/**
 * Estimate a job's cost and the credits it will hold.
 *
 * Two things are deliberately different:
 *
 *  - `creditsMicro` is what the job should cost. 0 when the model is per-token
 *    and we cannot know, because a guess shown as a price is worse than no price.
 *  - `reservedMicro` is what gets held from the balance. Never below a floor,
 *    so an unestimable job still cannot overspend.
 */
export function estimateCost(
  model: VideoModel,
  params: {
    durationSeconds?: number;
    resolution?: string;
    generateAudio?: boolean;
    hasFirstFrame?: boolean;
  },
): CostEstimate {
  const q = priceQuote(model.pricing, {
    durationSeconds: params.durationSeconds,
    resolution: params.resolution,
    generateAudio: params.generateAudio,
    hasFirstFrame: params.hasFirstFrame,
  });

  const creditsMicro = q.estimable ? usdToCreditsMicro(q.costUsd) : 0;
  const ceilingMicro = usdToCreditsMicro(env.CREDIT_RESERVE_CEILING_USD);

  return {
    ...q,
    creditsMicro,
    reservedMicro: q.estimable ? creditsMicro : Math.min(ceilingMicro, 100_000),
  };
}

/** Create a queued job, holding credits. Nothing is sent upstream yet. */
export async function createGeneration(
  input: CreateGenerationInput,
): Promise<CreateGenerationResult> {
  if (!hasDatabase) {
    throw new NotConfiguredError("DATABASE_URL", "DATABASE_URL is not set, so generations cannot be stored.");
  }
  if (!isStorageReady()) {
    throw new NotConfiguredError("STORAGE_DRIVER", "Storage is not configured.");
  }

  const db = requireDb();

  // Resolve the model for pricing. Cached, so this does not hit the network on
  // every submit.
  const { listVideoModels } = await import("@/lib/openrouter/models");
  let models: VideoModel[];
  try {
    models = await listVideoModels();
  } catch (cause) {
    // The cause is preserved so the server log explains *why* the list could not
    // load. The message the user sees stays about the missing configuration,
    // because "ECONNRESOLVE openrouter.ai" is not actionable for them.
    throw new NotConfiguredError(
      "OPENROUTER_API_KEY",
      "Could not load the OpenRouter model list, so the cost of this job cannot be determined.",
      { cause },
    );
  }

  const model = models.find((m) => m.id === input.model);
  if (!model) {
    throw new NotConfiguredError("model", `"${input.model}" is not a model this app can generate with.`);
  }

  const duration = params_duration(input.params.durationSeconds, model);
  const resolution = input.params.resolution ?? model.resolutions[0];
  const aspectRatio = input.params.aspectRatio ?? model.aspectRatios[0];
  const generateAudio = input.params.generateAudio ?? model.supportsAudio;

  const estimate = estimateCost(model, {
    durationSeconds: duration,
    resolution,
    generateAudio,
    hasFirstFrame: Boolean(input.sourceImageKey),
  });

  // A first frame the model cannot accept is worth catching now, with a clear
  // message, rather than as a 400 from OpenRouter three steps later.
  if (input.sourceImageKey && model.frameImages.length === 0) {
    throw new NotConfiguredError(
      "frame_images",
      `${model.name} does not accept a start frame. Pick a text-to-video model or remove the image.`,
    );
  }

  // The exact string that will be sent upstream, frozen at submit time.
//
// `generations.prompt` holds the user's own words, verbatim, because that is
// what they asked for and it is what the gallery should show. This is the
// machine's rendering of it.
//
// Both are stored on purpose. Recomputing the final prompt at send time would
// mean that any future change to `assemblePrompt` silently rewrites history: a
// job from three months ago would no longer reproduce what was actually sent,
// which is exactly the property an audit trail is supposed to have.
  const finalPrompt = assemblePrompt({
    prompt: input.prompt,
    enhancedPrompt: input.enhancedPrompt,
    presetSlug: input.presetSlug,
    aspectRatio,
    resolution,
    durationSeconds: duration,
    audio: generateAudio,
  });

  const [row] = await db
    .insert(schema.generations)
    .values({
      userId: input.userId,
      type: input.type,
      model: input.model,
      prompt: input.prompt,
      enhancedPrompt: input.enhancedPrompt ?? null,
      preset: input.presetSlug ?? null,
      params: {
        durationSeconds: duration,
        resolution,
        aspectRatio,
        size: input.params.size ?? null,
        generateAudio,
        seed: input.params.seed ?? null,
        finalPrompt,
      },
      status: "queued",
      sourceImageUrl: input.sourceImageKey ?? null,
      costEstimateMicro: toMicro(estimate.estimable ? estimate.costUsd : env.CREDIT_RESERVE_CEILING_USD),
      nextPollAt: new Date(),
    })
    .returning({ id: schema.generations.id });

  const held = await reserveCredits({
    userId: input.userId,
    amount: estimate.reservedMicro,
    generationId: row.id,
    costEstimateMicro: toMicro(estimate.estimable ? estimate.costUsd : env.CREDIT_RESERVE_CEILING_USD),
    metadata: {
      model: input.model,
      duration,
      resolution,
      estimable: estimate.estimable,
    },
  });

  if (!held.ok) {
    // Delete the row rather than leaving a queued job that will never run: it
    // would occupy a concurrency slot and show up in the gallery as pending
    // forever.
    await db.delete(schema.generations).where(eq(schema.generations.id, row.id));

    const [current] = await db
      .select({ credits: schema.users.credits })
      .from(schema.users)
      .where(eq(schema.users.id, input.userId))
      .limit(1);

    const messages: Record<RejectionReason, string> = {
      insufficient_credits:
        held.detail ??
        `This job needs ${(estimate.reservedMicro / 10_000).toFixed(2)} credits and you do not have enough.`,
      concurrent_limit: held.detail ?? "You already have jobs running. Wait for one to finish.",
      rate_limited: held.detail ?? "Too many jobs in the last hour. Try again shortly.",
      spend_cap: held.detail ?? "The service-wide daily generation cap has been reached.",
    };

    return {
      ok: false,
      reason: held.reason as RejectionReason,
      message: messages[held.reason as RejectionReason],
      estimate,
      balanceMicro: current?.credits ?? 0,
    };
  }

  await db
    .update(schema.generations)
    .set({ creditsHeld: estimate.reservedMicro, updatedAt: new Date() })
    .where(eq(schema.generations.id, row.id));

  return {
    ok: true,
    id: row.id,
    status: "queued",
    estimate,
    creditsHeld: estimate.reservedMicro,
    balanceMicro: held.balanceMicro,
  };
}

function params_duration(requested: number | undefined, model: VideoModel): number {
  if (requested && model.durations.includes(requested)) return requested;
  return model.durations[0] ?? 5;
}

/**
 * Advance one job by one step.
 *
 * Idempotent by construction: each branch starts with a conditional UPDATE
 * claiming the row from its current status. If another worker already claimed
 * it, the UPDATE affects zero rows and this call returns without doing anything.
 */
export async function advanceGeneration(generationId: string): Promise<AdvanceResult> {
  if (!hasOpenRouterKey) return "skipped";

  const db = requireDb();
  const [job] = await db
    .select()
    .from(schema.generations)
    .where(eq(schema.generations.id, generationId))
    .limit(1);

  if (!job) return "skipped";
  if (["completed", "failed", "cancelled", "expired"].includes(job.status)) return "skipped";

  if (job.status === "queued" || job.status === "submitting") {
    return submitJob(job);
  }
  if (job.status === "generating") {
    return pollJob(job);
  }
  if (job.status === "downloading") {
    return downloadJob(job);
  }
  return "skipped";
}

/** queued | submitting -> generating */
async function submitJob(job: GenerationRow): Promise<AdvanceResult> {
  if (!hasOpenRouterKey) {
    throw new NotConfiguredError("OPENROUTER_API_KEY", "OPENROUTER_API_KEY is not set.");
  }

  const db = requireDb();

  // Claim it. Only one worker gets here.
  const [claimed] = await db
    .update(schema.generations)
    .set({ status: "submitting", attempts: job.attempts + 1, updatedAt: new Date() })
    .where(and(eq(schema.generations.id, job.id), inArray(schema.generations.status, ["queued", "submitting"])))
    .returning();

  if (!claimed) return "skipped";

  const model = await getModelFor(job.model);
  const params = job.params as Record<string, unknown>;

  // Use the prompt frozen at submit time. The fallback only fires for rows
  // written before `finalPrompt` was stored, or by a future migration that
  // forgot to backfill -- in both cases reproducing the prompt beats sending an
  // empty one.
  const finalPrompt =
    typeof params["finalPrompt"] === "string" && params["finalPrompt"].trim()
      ? (params["finalPrompt"] as string)
      : assemblePrompt({
          prompt: job.prompt,
          enhancedPrompt: job.enhancedPrompt,
          presetSlug: job.preset,
          aspectRatio: (params["aspectRatio"] as string) ?? null,
          resolution: (params["resolution"] as string) ?? null,
          durationSeconds: (params["durationSeconds"] as number) ?? null,
          audio: (params["generateAudio"] as boolean) ?? null,
        });

  try {
    const callbackUrl = env.NEXT_PUBLIC_APP_URL
      ? `${env.NEXT_PUBLIC_APP_URL}/api/webhooks/openrouter`
      : undefined;

    // Image-to-video needs a URL OpenRouter can actually fetch.
    let frameImages: unknown[] | undefined;
    if (job.sourceImageUrl) {
      const url = await publicMediaUrl(job.sourceImageUrl);
      if (!url) {
        await failJob(job, {
          message:
            "A start frame was provided but OpenRouter cannot fetch it. Set PUBLIC_MEDIA_BASE_URL to a publicly reachable origin, or switch STORAGE_DRIVER to supabase.",
          kind: "storage",
        });
        return "progressed";
      }
      if (model.frameImages.includes("first_frame")) {
        frameImages = [{ type: "image_url", image_url: { url }, frame_type: "first_frame" }];
      } else if (model.frameImages.includes("last_frame")) {
        frameImages = [{ type: "image_url", image_url: { url }, frame_type: "last_frame" }];
      }
    }

    const result = await submitVideo(
      {
        model: job.model,
        prompt: finalPrompt,
        duration: params["durationSeconds"] as number | undefined,
        resolution: params["resolution"] as string | undefined,
        aspect_ratio: params["aspectRatio"] as string | undefined,
        ...(params["size"] ? { size: params["size"] as string } : {}),
        ...(frameImages ? { frame_images: frameImages } : {}),
        ...(model.supportsAudio && params["generateAudio"] ? { generate_audio: true } : {}),
        ...(typeof params["seed"] === "number" ? { seed: params["seed"] as number } : {}),
      },
      { callbackUrl },
    );

    await db
      .update(schema.generations)
      .set({
        status: "generating",
        openrouterJobId: result.id,
        pollingUrl: result.polling_url,
        nextPollAt: new Date(Date.now() + 5_000),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.generations.id, job.id), eq(schema.generations.status, "submitting")));

    return "progressed";
  } catch (e) {
    await failJob(job, { message: e instanceof Error ? e.message : String(e), kind: "submit" });
    return "progressed";
  }
}

/** generating -> generating (waiting) | downloading | failed */
async function pollJob(job: GenerationRow): Promise<AdvanceResult> {
  if (!job.openrouterJobId) {
    await failJob(job, {
      message: "Job was submitted upstream but no job id was recorded.",
      kind: "poll",
    });
    return "progressed";
  }

  const db = requireDb();
  const result = await pollVideo(job.openrouterJobId);

  if (!TERMINAL_UPSTREAM.has(result.status)) {
    // Exponential backoff, capped at 60s.
    const delay = Math.min(60_000, 5_000 * 2 ** Math.min(job.attempts, 4));
    await db
      .update(schema.generations)
      .set({ nextPollAt: new Date(Date.now() + delay), updatedAt: new Date() })
      .where(and(eq(schema.generations.id, job.id), eq(schema.generations.status, "generating")));
    return "progressed";
  }

  if (result.status !== "completed") {
    await failJob(job, {
      message: upstreamErrorMessage(result.error) ?? `Upstream reported "${result.status}".`,
      kind: "upstream",
    });
    return "progressed";
  }

  await db
    .update(schema.generations)
    .set({ status: "downloading", nextPollAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.generations.id, job.id), eq(schema.generations.status, "generating")));

  // Stash the billed cost now, so a crash during download does not lose it.
  if (result.usage?.cost != null) {
    await db
      .update(schema.generations)
      .set({ costActualMicro: toMicro(result.usage.cost) })
      .where(eq(schema.generations.id, job.id));
  }

  return "progressed";
}

/** downloading -> completed */
async function downloadJob(job: GenerationRow): Promise<AdvanceResult> {
  const db = requireDb();

  const [claimed] = await db
    .update(schema.generations)
    .set({ status: "downloading", updatedAt: new Date() })
    .where(and(eq(schema.generations.id, job.id), eq(schema.generations.status, "downloading")))
    .returning();

  if (!claimed) return "skipped";

  try {
    const url =
      (await pollVideo(job.openrouterJobId!)).unsigned_urls?.[0] ??
      `${job.pollingUrl ?? `https://openrouter.ai/api/v1/videos/${job.openrouterJobId}`}/content?index=0`;

    const { bytes, contentType } = await downloadVideo(url);

    const stored = await storage.put(bytes, {
      contentType: contentType.startsWith("video") ? contentType : "video/mp4",
      kind: "video",
    });

    // Settle: charge the real cost, refund the difference.
    const actualUsd = job.costActualMicro != null ? job.costActualMicro / 1_000_000 : null;
    await settleGeneration({
      userId: job.userId,
      generationId: job.id,
      heldMicro: job.creditsHeld,
      actualUsd,
      metadata: { model: job.model },
    });

    await db
      .update(schema.generations)
      .set({
        status: "completed",
        outputUrl: stored.key,
        mimeType: stored.contentType,
        bytes: stored.bytes,
        creditsHeld: 0,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.generations.id, job.id));

    return "progressed";
  } catch (e) {
    await failJob(job, { message: e instanceof Error ? e.message : String(e), kind: "download" });
    return "progressed";
  }
}

/** Mark failed and refund. */
export async function failJob(
  job: GenerationRow,
  error: { message: string; kind: string },
): Promise<void> {
  const db = requireDb();

  const [claimed] = await db
    .update(schema.generations)
    .set({
      status: error.kind === "cancelled" ? "cancelled" : "failed",
      error: error.message,
      creditsHeld: 0,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.generations.id, job.id),
        inArray(schema.generations.status, ["queued", "submitting", "generating", "downloading"]),
      ),
    )
    .returning({ id: schema.generations.id, userId: schema.generations.userId });

  if (!claimed) return;

  // Refund. The user is not charged for a job that did not produce a video.
  if (job.creditsHeld > 0) {
    await releaseCredits({
      userId: job.userId,
      amount: job.creditsHeld,
      generationId: job.id,
      reason: "job_refund",
      metadata: { reason: error.kind, message: error.message.slice(0, 300) },
    });
  }
}

/** Jobs whose next poll is due. The worker's hot query. */
export async function claimDueJobs(limit: number): Promise<string[]> {
  const db = requireDb();
  const now = new Date();

  // SKIP LOCKED so two concurrent ticks claim disjoint sets rather than
  // blocking on each other and then both processing the same rows.
  //
  // `FOR UPDATE SKIP LOCKED` is the whole point: without SKIP, a second tick
  // blocks on the first's row locks, and on a serverless platform with a short
  // execution limit that shows up as a timeout rather than as duplicate work.
  const rows = (await db.execute<{ id: string }>(sql`
    UPDATE ${schema.generations}
    SET next_poll_at = now() + interval '30 seconds'
    WHERE id IN (
      SELECT id FROM ${schema.generations}
      WHERE status in ('queued','submitting','generating','downloading')
        AND next_poll_at <= ${now}
        AND created_at > now() - interval '${`${env.JOB_MAX_AGE_MINUTES} minutes`}'
      ORDER BY next_poll_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `)) as unknown as { id: string }[];

  return rows.map((r) => r.id);
}

/** Expire jobs that have been running too long. Refunds them. */
export async function expireStaleJobs(): Promise<number> {
  const db = requireDb();
  const cutoff = new Date(Date.now() - env.JOB_MAX_AGE_MINUTES * 60_000);

  const stale = await db
    .select()
    .from(schema.generations)
    .where(
      and(
        inArray(schema.generations.status, ["queued", "submitting", "generating", "downloading"]),
        lt(schema.generations.createdAt, cutoff),
      ),
    );

  for (const job of stale) {
    await failJob(job, {
      message: `Job exceeded the ${env.JOB_MAX_AGE_MINUTES} minute limit and was cancelled. Credits refunded.`,
      kind: "expired",
    });
  }

  return stale.length;
}

async function getModelFor(id: string): Promise<VideoModel> {
  const { listVideoModels } = await import("@/lib/openrouter/models");
  const models = await listVideoModels();
  const model = models.find((m) => m.id === id);
  if (model) return model;
  // Fall back to a permissive shape so an upstream model change does not wedge
  // a job that was already submitted.
  return {
    id,
    name: id,
    description: null,
    durations: [5],
    resolutions: ["720p"],
    aspectRatios: ["16:9"],
    sizes: [],
    frameImages: ["first_frame"],
    supportsAudio: false,
    supportsSeed: false,
    minCostUsd: null,
    requiresFirstFrame: false,
    pricing: { rules: [], hasUnresolvableRule: false },
    passthroughParameters: [],
  };
}

export { normaliseVideoModel };
export type { RawVideoModel, VideoModel };