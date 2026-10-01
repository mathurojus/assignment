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
  generateImages,
  pollVideo,
  submitVideo,
  TERMINAL_UPSTREAM,
  upstreamErrorMessage,
} from "@/lib/openrouter/video";
import { imagePricingFor, quoteImage, type ImagePricing } from "@/lib/openrouter/image-pricing";
import type { ImageModel } from "@/lib/openrouter/models";

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
    /** Image jobs: how many images to produce. Clamped to the model's maximum. */
    count?: number;
    /** Image jobs: "low" | "medium" | "high", when the model offers it. */
    quality?: string;
    /** Image jobs: "png" | "jpeg" | "webp", when the model offers it. */
    outputFormat?: string;
  };
  sourceImageKey?: string | null;
  /** Whether this job may appear in the public explore feed. */
  isPublic?: boolean;
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

/**
 * A cost estimate as the API returns it, for either job type.
 *
 * The intersection of the video and image quotes: what the UI needs to render a
 * price and an "unpriceable" reason. The richer per-type fields (`ruleKey`,
 * `unit`) are internal to the cost engine and never reach a client.
 */
export interface JobEstimate {
  estimable: boolean;
  /** null when not estimable. Never 0 — a real free job does not exist upstream. */
  costUsd: number | null;
  /** Human-readable explanation of the number, or of why there is none. */
  basis: string;
  /** Why it is not estimable. Present exactly when `estimable` is false. */
  reason?: string;
  /** What the hold was, in micro-credits. */
  reservedMicro: number;
}

export type CreateGenerationResult =
  | {
      ok: true;
      id: string;
      status: "queued";
      estimate: JobEstimate;
      creditsHeld: number;
      balanceMicro: number;
    }
  | {
      ok: false;
      reason: RejectionReason;
      message: string;
      estimate: JobEstimate;
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

/**
 * The image equivalent of `estimateCost`.
 *
 * A separate function rather than a parameterised `estimateCost` because the two
 * quote unions have different shapes (`ruleKey` and `unit` exist on one and not
 * the other) and a merged signature would make both call sites cast.
 */
export interface ImageCostEstimate {
  estimable: boolean;
  costUsd: number | null;
  reason?: string;
  basis: string;
  creditsMicro: number;
  reservedMicro: number;
}

export function estimateImageCost(
  pricing: ImagePricing,
  params: { count?: number; resolution?: string | null; referenceCount?: number },
): ImageCostEstimate {
  const q = quoteImage(pricing, {
    count: params.count ?? 1,
    resolution: params.resolution,
    referenceCount: params.referenceCount,
  });

  if (!q.estimable) {
    const ceilingMicro = usdToCreditsMicro(env.CREDIT_RESERVE_CEILING_USD);
    return {
      estimable: false,
      costUsd: null,
      reason: q.reason,
      basis: q.basis,
      creditsMicro: 0,
      reservedMicro: Math.min(ceilingMicro, 100_000),
    };
  }

  const creditsMicro = usdToCreditsMicro(q.costUsd);
  return {
    estimable: true,
    costUsd: q.costUsd,
    basis: q.basis,
    creditsMicro,
    // Hold slightly above the estimate so a real cost a hair higher than the
    // quote cannot turn a successful generation into an unfunded one. The excess
    // is refunded on settle, and that refund is on the same transaction as the
    // charge.
    reservedMicro: Math.max(creditsMicro, Math.round(creditsMicro * 1.02)),
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

/**
   * Resolved parameters and estimate for one job.
   *
   * Video and image pricing come from different upstream endpoints with
   * different shapes, so this is one function with two branches rather than two
   * functions with a shared return type: the prompt assembly, the insert and the
   * credit hold that follow are identical, and duplicating those to avoid a
   * branch would put two copies of the money code in one file.
   */
  const { listVideoModels, listImageModels } = await import("@/lib/openrouter/models");

  if (input.type === "image") {
    let imageModels: ImageModel[];
    try {
      imageModels = await listImageModels();
    } catch (cause) {
      throw new NotConfiguredError(
        "OPENROUTER_API_KEY",
        "Could not load the OpenRouter image model list, so the cost of this job cannot be determined.",
        { cause },
      );
    }

    const model = imageModels.find((m) => m.id === input.model);
    if (!model) {
      throw new NotConfiguredError(
        "model",
        `"${input.model}" is not an image model this app can generate with.`,
      );
    }

    if (input.sourceImageKey && !model.acceptsReferences) {
      throw new NotConfiguredError(
        "input_references",
        `${model.name} does not accept reference images. Pick a model that does, or remove the image.`,
      );
    }

    // Clamp rather than reject. A client asking for 50 images on a model that
    // caps at 6 has made a mistake, but failing the whole job over a field with
    // an obvious answer — the model's own maximum — is worse than correcting it.
    // The count that was actually used is stored in `params`, so the gallery
    // shows what happened rather than what was asked for.
    const count = Math.max(
      1,
      Math.min(Math.floor(input.params.count ?? 1), model.maxImages || 1),
    );

    const resolution = pick(input.params.resolution, model.resolutions);
    const aspectRatio = pick(input.params.aspectRatio, model.aspectRatios);

    // Image pricing needs a second, per-model upstream call: the model list has
    // no prices. Cached for an hour per process, so this is one round trip per
    // model per cold start.
    const pricing = await imagePricingFor(input.model);

    const estimate = estimateImageCost(pricing, {
      count,
      resolution,
      referenceCount: input.sourceImageKey ? 1 : 0,
    });

    return insertQueued({
      input,
      params: {
        count,
        resolution,
        aspectRatio,
        quality: input.params.quality ?? null,
        outputFormat: input.params.outputFormat ?? null,
        seed: input.params.seed ?? null,
        finalPrompt: assemblePrompt({
          prompt: input.prompt,
          enhancedPrompt: input.enhancedPrompt,
          presetSlug: input.presetSlug,
          aspectRatio,
          resolution,
          durationSeconds: null,
          audio: null,
        }),
      },
      estimate,
    });
  }

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
  return insertQueued({
    input,
    params: {
      durationSeconds: duration,
      resolution,
      aspectRatio,
      size: input.params.size ?? null,
      generateAudio,
      seed: input.params.seed ?? null,
      finalPrompt: assemblePrompt({
        prompt: input.prompt,
        enhancedPrompt: input.enhancedPrompt,
        presetSlug: input.presetSlug,
        aspectRatio,
        resolution,
        durationSeconds: duration,
        audio: generateAudio,
      }),
    },
    estimate: toJobEstimate(estimate),
  });
}

/**
 * The estimate as the rest of `createGeneration` needs it, from either branch.
 *
 * A tiny adapter rather than a union so the insert and hold below do not have to
 * narrow on `estimable` twice for two different quote shapes.
 */
type NormalisedEstimate = JobEstimate;

/** Drop the video-quote-only fields and add the missing `costUsd: null`. */
function toJobEstimate(q: Quote & { creditsMicro: number; reservedMicro: number }): NormalisedEstimate {
  return q.estimable
    ? { estimable: true, costUsd: q.costUsd, basis: q.basis, reservedMicro: q.reservedMicro }
    : {
        estimable: false,
        costUsd: null,
        basis: q.basis,
        reason: q.reason,
        reservedMicro: q.reservedMicro,
      };
}

/** Insert the queued row and take the credit hold. */
async function insertQueued(args: {
  input: CreateGenerationInput;
  params: Record<string, unknown>;
  estimate: NormalisedEstimate;
}): Promise<CreateGenerationResult> {
  const { input, params, estimate } = args;
  const db = requireDb();

  // An unestimable job still records *something* as its estimate: the ceiling it
  // is holding against. Recording zero would make "we held a dollar" and "this
  // was free" indistinguishable in the admin stats.
  const estimateMicro =
    estimate.estimable && estimate.costUsd !== null
      ? toMicro(estimate.costUsd)
      : toMicro(env.CREDIT_RESERVE_CEILING_USD);

  const [row] = await db
    .insert(schema.generations)
    .values({
      userId: input.userId,
      type: input.type,
      model: input.model,
      prompt: input.prompt,
      enhancedPrompt: input.enhancedPrompt ?? null,
      preset: input.presetSlug ?? null,
      params,
      status: "queued",
      sourceImageUrl: input.sourceImageKey ?? null,
      isPublic: input.isPublic ?? false,
      costEstimateMicro: estimateMicro,
      nextPollAt: new Date(),
    })
    .returning({ id: schema.generations.id });

  const held = await reserveCredits({
    userId: input.userId,
    amount: estimate.reservedMicro,
    generationId: row.id,
    costEstimateMicro: estimateMicro,
    metadata: {
      model: input.model,
      type: input.type,
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

/**
 * The requested value if the model supports it, otherwise the model's own first.
 *
 * Falling back rather than rejecting is what keeps a model list that changed
 * upstream from turning every save into an error. The value that was actually
 * used is stored, so nothing downstream is misled about what happened.
 */
function pick(requested: string | undefined | null, supported: string[]): string | null {
  if (requested && supported.includes(requested)) return requested;
  return supported[0] ?? null;
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

  // Images have no polling phase: `/images` blocks and returns base64. So an
  // image job runs `queued -> submitting -> completed` in a single call, and the
  // `generating` / `downloading` states below are video-only. The claim-and-
  // guard shape is the same in both, so a concurrent tick still cannot run one
  // job twice.
  if (job.type === "image") {
    return submitImageJob(job);
  }

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

/**
 * queued | submitting -> completed, for image jobs.
 *
 * Runs the whole thing in one call: the upstream request, storing every returned
 * image, settling the credits, and marking the row done. There is no intermediate
 * state to persist because there is no gap between the request and the result —
 * splitting it would only add a place for a crash to strand a paid-for job.
 */
async function submitImageJob(job: GenerationRow): Promise<AdvanceResult> {
  if (!hasOpenRouterKey) {
    throw new NotConfiguredError("OPENROUTER_API_KEY", "OPENROUTER_API_KEY is not set.");
  }

  const db = requireDb();

  // Claim it, from either status, so a retry after a crash mid-request can still
  // take it. `attempts` increments on every claim, which is what `expireStaleJobs`
  // reads to give up eventually.
  const [claimed] = await db
    .update(schema.generations)
    .set({ status: "submitting", attempts: job.attempts + 1, updatedAt: new Date() })
    .where(
      and(
        eq(schema.generations.id, job.id),
        inArray(schema.generations.status, ["queued", "submitting"]),
      ),
    )
    .returning();

  if (!claimed) return "skipped";

  const params = job.params as Record<string, unknown>;

  try {
    // Reference images need a URL OpenRouter can fetch, exactly as a video start
    // frame does.
    let references: Array<{ type: "image_url"; image_url: { url: string } }> | undefined;
    if (job.sourceImageUrl) {
      const url = await publicMediaUrl(job.sourceImageUrl);
      if (!url) {
        await failJob(job, {
          message:
            "A reference image was provided but OpenRouter cannot fetch it. Set PUBLIC_MEDIA_BASE_URL to a publicly reachable origin, or switch STORAGE_DRIVER to supabase.",
          kind: "storage",
        });
        return "progressed";
      }
      references = [{ type: "image_url", image_url: { url } }];
    }

    const result = await generateImages({
      model: job.model,
      prompt: finalPromptFor(job),
      ...(typeof params["count"] === "number" ? { n: params["count"] as number } : {}),
      ...(typeof params["resolution"] === "string" && params["resolution"]
        ? { resolution: params["resolution"] as string }
        : {}),
      ...(typeof params["aspectRatio"] === "string" && params["aspectRatio"]
        ? { aspect_ratio: params["aspectRatio"] as string }
        : {}),
      ...(typeof params["quality"] === "string" && params["quality"]
        ? { quality: params["quality"] as string }
        : {}),
      ...(typeof params["outputFormat"] === "string" && params["outputFormat"]
        ? { output_format: params["outputFormat"] as string }
        : {}),
      ...(typeof params["seed"] === "number" ? { seed: params["seed"] as number } : {}),
      ...(references ? { input_references: references } : {}),
    });

    const outputs: Array<{ key: string; mimeType: string; bytes: number }> = [];

    for (const item of result.data ?? []) {
      // Base64 is the documented shape. A `url` would mean OpenRouter started
      // returning hosted assets, which is worth handling rather than crashing on
      // — but it is not something this has been observed to do, so the message
      // says so instead of pretending.
      if (!item.b64_json) {
        throw new Error(
          "OpenRouter returned an image without base64 data. This app expects b64_json and does not yet handle a hosted URL.",
        );
      }

      const mediaType = item.media_type ?? "image/png";
      const bytes = Buffer.from(item.b64_json, "base64");
      const stored = await storage.put(bytes, { contentType: mediaType, kind: "image" });
      outputs.push({ key: stored.key, mimeType: stored.contentType, bytes: stored.bytes });
    }

    if (outputs.length === 0) {
      throw new Error("OpenRouter reported success but returned no images.");
    }

    const totalBytes = outputs.reduce((n, o) => n + o.bytes, 0);

    // Settle first. If the charge or refund fails, the row stays in `submitting`
    // and `expireStaleJobs` refunds it — the alternative is marking it completed
    // with credits still held, which is money the operator never gets back.
    const actualUsd = result.usage?.cost != null ? result.usage.cost : null;
    await settleGeneration({
      userId: job.userId,
      generationId: job.id,
      heldMicro: job.creditsHeld,
      actualUsd,
      metadata: { model: job.model, images: outputs.length },
    });

    await db
      .update(schema.generations)
      .set({
        status: "completed",
        outputUrl: outputs[0].key,
        outputs,
        mimeType: outputs[0].mimeType,
        bytes: totalBytes,
        costActualMicro: actualUsd != null ? toMicro(actualUsd) : null,
        creditsHeld: 0,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.generations.id, job.id));

    return "progressed";
  } catch (e) {
    await failJob(job, { message: e instanceof Error ? e.message : String(e), kind: "submit" });
    return "progressed";
  }
}

/**
 * The prompt frozen at submit time, with a fallback for rows that predate it.
 *
 * Identical to the video path's fallback and for the same reason: a job from
 * before `finalPrompt` existed, or one written by a migration that forgot to
 * backfill, must still send something rather than an empty prompt.
 */
function finalPromptFor(job: GenerationRow): string {
  const params = job.params as Record<string, unknown>;
  if (typeof params["finalPrompt"] === "string" && params["finalPrompt"].trim()) {
    return params["finalPrompt"] as string;
  }
  return assemblePrompt({
    prompt: job.prompt,
    enhancedPrompt: job.enhancedPrompt,
    presetSlug: job.preset,
    aspectRatio: (params["aspectRatio"] as string) ?? null,
    resolution: (params["resolution"] as string) ?? null,
    durationSeconds: null,
    audio: null,
  });
}

/**
 * The video variant of `finalPromptFor`.
 *
 * Same frozen-prompt rule, but the fallback passes the video-only fields
 * (`durationSeconds`, audio) so a pre-`finalPrompt` row reconstructs the prompt
 * it would have had, rather than a video prompt with the duration omitted.
 */
function finalPromptForVideo(job: GenerationRow): string {
  const params = job.params as Record<string, unknown>;
  if (typeof params["finalPrompt"] === "string" && params["finalPrompt"].trim()) {
    return params["finalPrompt"] as string;
  }
  return assemblePrompt({
    prompt: job.prompt,
    enhancedPrompt: job.enhancedPrompt,
    presetSlug: job.preset,
    aspectRatio: (params["aspectRatio"] as string) ?? null,
    resolution: (params["resolution"] as string) ?? null,
    durationSeconds: (params["durationSeconds"] as number) ?? null,
    audio: (params["generateAudio"] as boolean) ?? null,
  });
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

  // Use the prompt frozen at submit time. See `finalPromptFor` for why the
  // fallback exists and why it is safe.
  const finalPrompt = finalPromptForVideo(job);

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
        // One output for a video, written to the same column image jobs use, so
        // every reader of a generation's media has one place to look.
        outputs: [{ key: stored.key, mimeType: stored.contentType, bytes: stored.bytes }],
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
