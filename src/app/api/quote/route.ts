import { z } from "zod";
import { listVideoModels } from "@/lib/openrouter/models";
import { quote, usdToCreditsMicro } from "@/lib/openrouter/pricing";
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
  durationSeconds: z.number().int().min(1).max(30).optional(),
  resolution: z.string().max(20).optional(),
  aspectRatio: z.string().max(20).optional(),
  generateAudio: z.boolean().optional(),
  hasFirstFrame: z.boolean().optional(),
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