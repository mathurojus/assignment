import { z } from "zod";
import { listVideoModels, listImageModels } from "@/lib/openrouter/models";
import { quote, usdToCreditsMicro } from "@/lib/openrouter/pricing";
import { imagePricingFor, quoteImage } from "@/lib/openrouter/image-pricing";
import { assemblePrompt } from "@/lib/prompt";
import { getPreset } from "@/lib/presets";
import { env } from "@/lib/env";

/**
 * Price a job before committing to it.
 *
 * Separate from `POST /api/generate` because the UI needs a number while the
 * user is still deciding, and re-quoting costs nothing. It also lets the UI show
 * the *reason* a price is unavailable instead of rendering a bare "—".
 */
export const dynamic = "force-dynamic";

const body = z.object({
  model: z.string().min(1),
  /** Video and image pricing are different shapes; the type picks the engine. */
  type: z.enum(["video", "image"]).default("video"),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  resolution: z.string().max(20).optional(),
  aspectRatio: z.string().max(20).optional(),
  generateAudio: z.boolean().optional(),
  hasFirstFrame: z.boolean().optional(),
  /** Image jobs only. */
  count: z.number().int().min(1).max(10).optional(),
  /** Image jobs only: how many reference images are being sent. */
  referenceCount: z.number().int().min(0).max(16).optional(),
  presetSlug: z.string().max(60).optional(),
  /** When true, returns the exact prompt string that would be sent. */
  includePrompt: z.boolean().optional(),
  /** When supplied, the prompt is enhanced in the quote rather than at submit. */
  prompt: z.string().max(4000).optional(),
  enhancedPrompt: z.string().max(4000).optional(),
});

export async function POST(request: Request) {
  let parsed: z.infer<typeof body>;
  try {
    parsed = body.parse(await request.json());
  } catch (e) {
    if (e instanceof z.ZodError) {
      return Response.json(
        {
          error: {
            code: "validation_failed",
            message: "That quote request was not valid.",
            fields: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        },
        { status: 400 },
      );
    }
    return Response.json(
      { error: { code: "bad_request", message: "Expected a JSON body." } },
      { status: 400 },
    );
  }

  if (parsed.type === "image") return quoteImageRequest(parsed);

  const models = await listVideoModels();
  const model = models.find((m) => m.id === parsed.model);

  if (!model) {
    return Response.json(
      {
        error: {
          code: "not_found",
          message: `"${parsed.model}" is not a model this app can generate with. It may have been removed from OpenRouter.`,
        },
      },
      { status: 404 },
    );
  }

  const duration = model.durations.includes(parsed.durationSeconds ?? -1)
    ? (parsed.durationSeconds as number)
    : model.durations[0];

  const resolution =
    parsed.resolution && model.resolutions.includes(parsed.resolution)
      ? parsed.resolution
      : model.resolutions[0];

  const result = quote(model.pricing, {
    durationSeconds: duration,
    resolution,
    generateAudio: parsed.generateAudio ?? model.supportsAudio,
    hasFirstFrame: parsed.hasFirstFrame ?? false,
  });

  const credits = result.estimable ? usdToCreditsMicro(result.costUsd) : null;

  const response: Record<string, unknown> = {
    type: "video",
    model: model.id,
    durationSeconds: duration,
    resolution,
    // `estimable` first so the client can narrow the union with a single check.
    ...(result.estimable
      ? {
          estimable: true as const,
          costUsd: result.costUsd,
          credits,
          basis: result.basis,
          ruleKey: result.ruleKey,
        }
      : {
          estimable: false as const,
          reason: result.reason,
          basis: result.basis,
          ruleKey: result.ruleKey ?? null,
          credits: null,
          costUsd: null,
          /**
           * What will actually be held. Shown so the user knows the hold even
           * though the charge is not yet knowable.
           */
          reservedUsd: Math.min(env.CREDIT_RESERVE_CEILING_USD, 1),
        }),
  };

  if (parsed.includePrompt && parsed.prompt) {
    const preset = getPreset(parsed.presetSlug);
    response.finalPrompt = assemblePrompt({
      prompt: parsed.prompt,
      enhancedPrompt: parsed.enhancedPrompt,
      presetSlug: parsed.presetSlug,
      aspectRatio: parsed.aspectRatio ?? model.aspectRatios[0],
      resolution,
      durationSeconds: duration,
      audio: parsed.generateAudio ?? model.supportsAudio,
    });
    response.negativePrompt = preset?.negativeFragment ?? null;
  }

  return Response.json(response, { headers: { "cache-control": "no-store" } });
}

/**
 * The image branch of the quote.
 *
 * Separate function rather than an inline `if` because image pricing needs a
 * second upstream call and a different parameter set, and mixing that into the
 * video body would leave both halves reading as if they shared a shape they do
 * not.
 */
async function quoteImageRequest(parsed: z.infer<typeof body>): Promise<Response> {
  const models = await listImageModels();
  const model = models.find((m) => m.id === parsed.model);

  if (!model) {
    return Response.json(
      {
        error: {
          code: "not_found",
          message: `"${parsed.model}" is not an image model this app can generate with. It may have been removed from OpenRouter.`,
        },
      },
      { status: 404 },
    );
  }

  const count = Math.min(parsed.count ?? 1, model.maxImages || 1);
  const resolution =
    parsed.resolution && model.resolutions.includes(parsed.resolution)
      ? parsed.resolution
      : (model.resolutions[0] ?? null);
  const aspectRatio =
    parsed.aspectRatio && model.aspectRatios.includes(parsed.aspectRatio)
      ? parsed.aspectRatio
      : (model.aspectRatios[0] ?? null);

  const pricing = await imagePricingFor(model.id);
  const result = quoteImage(pricing, {
    count,
    resolution,
    referenceCount: parsed.referenceCount ?? 0,
  });

  const response: Record<string, unknown> = {
    type: "image",
    model: model.id,
    count,
    resolution,
    aspectRatio,
    ...(result.estimable
      ? {
          estimable: true as const,
          costUsd: result.costUsd,
          credits: usdToCreditsMicro(result.costUsd),
          basis: result.basis,
          unit: result.unit,
        }
      : {
          estimable: false as const,
          reason: result.reason,
          basis: result.basis,
          credits: null,
          costUsd: null,
          reservedUsd: Math.min(env.CREDIT_RESERVE_CEILING_USD, 1),
        }),
  };

  if (parsed.includePrompt && parsed.prompt) {
    const preset = getPreset(parsed.presetSlug);
    response.finalPrompt = assemblePrompt({
      prompt: parsed.prompt,
      enhancedPrompt: parsed.enhancedPrompt,
      presetSlug: parsed.presetSlug,
      aspectRatio,
      resolution,
      durationSeconds: null,
      audio: null,
    });
    response.negativePrompt = preset?.negativeFragment ?? null;
  }

  return Response.json(response, { headers: { "cache-control": "no-store" } });
}