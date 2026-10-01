import { listImageModels, listVideoModels, VideoModelsUnavailableError } from "@/lib/openrouter/models";
import { quote } from "@/lib/openrouter/pricing";
import { presets, presetCategories } from "@/lib/presets";
import { env, features } from "@/lib/env";
import { hasOpenRouterKey } from "@/lib/env";

/**
 * Everything the generate page needs, in one request.
 *
 * The model list, the camera presets and the cost engine all live on the
 * server. Shipping the raw `pricing_skus` map to the browser would leak the
 * shape of the cost engine into client code that has no business parsing it, so
 * each model carries a pre-resolved "from $x" and the quote itself is a server
 * route.
 *
 * Cached for five minutes. The upstream list changes rarely and this page is
 * opened often.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const video = await listVideoModels();

    // Image models are for start frames. A failure here should not take the
    // whole page down -- text-to-video still works without them.
    let images: Awaited<ReturnType<typeof listImageModels>> = [];
    let imagesError: string | null = null;
    try {
      images = await listImageModels();
    } catch (e) {
      imagesError =
        e instanceof VideoModelsUnavailableError
          ? "Could not load the image model list. Start-frame generation is unavailable."
          : "Could not load the image model list.";
    }

    return Response.json(
      {
        video: video.map((m) => ({
          id: m.id,
          name: m.name,
          description: m.description,
          durations: m.durations,
          resolutions: m.resolutions,
          aspectRatios: m.aspectRatios,
          frameImages: m.frameImages,
          supportsAudio: m.supportsAudio,
          supportsSeed: m.supportsSeed,
          fromUsd: m.minCostUsd,
          /**
           * A single cheapest example quote, so the picker can show a real
           * number per model. `null` means the model is priced per video token
           * and we will not guess -- see pricing.ts.
           */
          sample: (() => {
            const q = quote(m.pricing, {
              durationSeconds: m.durations[0],
              resolution: m.resolutions[0],
              hasFirstFrame: false,
            });
            return q.estimable ? { usd: q.costUsd, basis: q.basis } : null;
          })(),
          priceable: !m.pricing.hasUnresolvableRule,
        })),
        images: images.map((m) => ({
          id: m.id,
          name: m.name,
          resolutions: m.resolutions,
          aspectRatios: m.aspectRatios,
          acceptsReferences: m.acceptsReferences,
        })),
        imagesError,
        presets: presets.map((p) => ({
          slug: p.slug,
          name: p.name,
          category: p.category,
          description: p.description,
          accent: p.accent ?? null,
        })),
        presetCategories: presetCategories(),
        credits: {
          /** 1 credit = $0.01, stated once for the client formatter. */
          usdPerCredit: 0.01,
          freeStartingCredits: env.FREE_STARTING_CREDITS,
          reserveCeilingUsd: env.CREDIT_RESERVE_CEILING_USD,
        },
        limits: {
          jobsPerHour: env.RATE_LIMIT_JOBS_PER_HOUR,
          concurrent: env.MAX_CONCURRENT_JOBS_PER_USER,
        },
        capabilities: {
          canGenerate: hasOpenRouterKey && features.database,
          imageToVideo: features.imageToVideo,
          enhancer: hasOpenRouterKey,
          /** The reason the generate button is disabled, in one sentence. */
          blockedReason: !hasOpenRouterKey
            ? "Add OPENROUTER_API_KEY to .env.local to generate."
            : !features.database
              ? "The local demo database is unavailable."
              : null,
        },
      },
      { headers: { "cache-control": "private, max-age=300" } },
    );
  } catch (error) {
    if (error instanceof VideoModelsUnavailableError) {
      return Response.json(
        {
          error: {
            code: "upstream_error",
            message: error.message,
          },
        },
        { status: 502 },
      );
    }
    console.error("[api/models] unexpected", error);
    return Response.json(
      { error: { code: "internal_error", message: "Could not load the model list." } },
      { status: 500 },
    );
  }
}
