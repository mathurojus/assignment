import { z } from "zod";
import { getSessionUser } from "@/lib/supabase/server";
import { moderate, publicReason } from "@/lib/moderation";
import { createGeneration } from "@/lib/generation";
import { NotConfiguredError, apiError, ok, route } from "@/lib/api";
import { getPreset } from "@/lib/presets";
import { isStorageReady, publicMediaUrl, storage } from "@/lib/storage";
import { creditsMicroToDisplay } from "@/lib/openrouter/pricing";

/**
 * Submit a generation.
 *
 * The order of operations here is deliberate and is the whole design of this
 * endpoint:
 *
 *   1. authenticate
 *   2. moderate the prompt          <- before we spend anything
 *   3. validate the parameters      <- before we spend anything
 *   4. reserve credits              <- atomically, inside the lifecycle fn
 *   5. queue the job
 *
 * Nothing that can fail expensively happens before the credit hold. A user who
 * is blocked, malformed, or over their limit never reaches OpenRouter, so a
 * rejected request costs the operator nothing.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const generateBody = z
  .object({
    type: z.enum(["video", "image"]).default("video"),
    model: z.string().min(1).max(200),
    prompt: z.string().min(1).max(8000),
    enhancedPrompt: z.string().max(8000).optional(),
    presetSlug: z.string().max(60).optional(),
    durationSeconds: z.number().int().min(1).max(30).optional(),
    resolution: z.string().max(20).optional(),
    aspectRatio: z.string().max(20).optional(),
    size: z.string().max(40).optional(),
    generateAudio: z.boolean().optional(),
    seed: z.number().int().optional(),
    /** Image jobs only. Clamped to the model's own maximum before use. */
    count: z.number().int().min(1).max(10).optional(),
    /** Image jobs only. */
    quality: z.string().max(20).optional(),
    /** Image jobs only: png | jpeg | webp. */
    outputFormat: z.string().max(20).optional(),
    isPublic: z.boolean().optional(),
    /** Base64 or data URL, for a generated start frame or a reference image. */
    sourceImageDataUrl: z.string().max(10_000_000).optional(),
  })
  .refine((v) => !(v.type === "video" && !v.model), {
    message: "A video job needs a model.",
  });

export async function POST(request: Request) {
  return route(async () => {
    const user = await getSessionUser();
    if (!user) {
      return apiError(
        "unauthorized",
        "Sign in to generate. If sign-in is not configured, see .env.example.",
      );
    }

    let parsed: z.infer<typeof generateBody>;
    try {
      parsed = generateBody.parse(await request.json());
    } catch (e) {
      if (e instanceof z.ZodError) {
        return apiError("validation_failed", "That generation request was not valid.", {
          fields: e.issues.map((i) => ({
            path: i.path.join("."),
            message: i.message,
          })),
        });
      }
      return apiError("validation_failed", "Expected a JSON body.");
    }

    // --- moderation, before anything costs money -------------------------
    const verdict = moderate(parsed.prompt);
    if (!verdict.allowed) {
      return apiError("validation_failed", publicReason(verdict) ?? "That prompt was blocked.", {
        moderated: true,
        // The category is for logs, not for the user: naming it tells an abuser
        // exactly which word to swap for a synonym.
        category: verdict.category,
      });
    }

    if (verdict.severity === "warn" && verdict.reason) {
      // Allowed. The UI shows the notice; nothing is blocked.
      console.warn(
        `[moderation] warn user=${user.id} category=${verdict.category} jobType=${parsed.type}`,
      );
    }

    if (parsed.presetSlug && !getPreset(parsed.presetSlug)) {
      return apiError("validation_failed", `"${parsed.presetSlug}" is not a camera preset.`);
    }

    // --- start frame or reference image ---------------------------------
    let sourceImageKey: string | null = null;
    if (parsed.sourceImageDataUrl) {
      if (!isStorageReady()) {
        throw new NotConfiguredError("STORAGE_DRIVER", "Media storage is not configured.");
      }
      const stored = await storeDataUrl(parsed.sourceImageDataUrl);
      sourceImageKey = stored;

      // An input image is useless if OpenRouter cannot fetch it, and the failure
      // mode upstream is a confusing 400. Say so here instead.
      //
      // Checked for both job types, not just video: image-to-image and reference
      // -based models fetch `input_references` the same way a start frame is
      // fetched. The message names which one it is so the fix is obvious.
      const reachable = await publicMediaUrl(stored);
      if (!reachable) {
        throw new NotConfiguredError(
          "PUBLIC_MEDIA_BASE_URL",
          (parsed.type === "video"
            ? "Image-to-video needs OpenRouter to fetch your start frame"
            : "Image-to-image needs OpenRouter to fetch your reference image") +
            ", and it cannot reach this app's media route. Set PUBLIC_MEDIA_BASE_URL to a " +
            "public origin (a tunnel works for local development), or generate from text alone.",
        );
      }
    }

    // --- reserve and queue -----------------------------------------------
    const result = await createGeneration({
      userId: user.id,
      type: parsed.type,
      model: parsed.model,
      prompt: parsed.prompt,
      enhancedPrompt: parsed.enhancedPrompt ?? null,
      presetSlug: parsed.presetSlug ?? null,
      params: {
        durationSeconds: parsed.durationSeconds,
        resolution: parsed.resolution,
        aspectRatio: parsed.aspectRatio,
        size: parsed.size,
        generateAudio: parsed.generateAudio,
        seed: parsed.seed,
        count: parsed.count,
        quality: parsed.quality,
        outputFormat: parsed.outputFormat,
      },
      sourceImageKey,
      isPublic: parsed.isPublic ?? false,
    });

    if (!result.ok) {
      // Map the rejection onto the shared error codes so the client can react
      // without string-matching the message.
      const code =
        result.reason === "insufficient_credits"
          ? "insufficient_credits"
          : result.reason === "concurrent_limit"
            ? "concurrent_limit"
            : result.reason === "rate_limited"
              ? "rate_limited"
              : "spend_cap";

      return apiError(code, result.message, {
        estimate: result.estimate,
        balanceCredits: creditsMicroToDisplay(result.balanceMicro),
      });
    }

    // 202: the job is accepted and queued, not finished. The client polls
    // `/api/generate/[id]` or waits for the job detail to change status.
    return ok(
      {
        id: result.id,
        status: result.status,
        estimate: result.estimate,
        creditsHeld: creditsMicroToDisplay(result.creditsHeld),
        balanceCredits: creditsMicroToDisplay(result.balanceMicro),
        /** The moderation notice, if there was one. The UI surfaces it. */
        notice: verdict.severity === "warn" ? verdict.reason : null,
      },
      { status: 202 },
    );
  });
}

/**
 * Persist a start frame supplied as a data URL.
 *
 * Size is capped before decoding: the input is attacker-controlled and arrives
 * as a string in memory either way, but refusing early avoids the base64 decode
 * and the write.
 */
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;

async function storeDataUrl(dataUrl: string): Promise<string> {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/i.exec(dataUrl);
  if (!match) {
    throw new NotConfiguredError(
      "sourceImageDataUrl",
      "The start frame must be a base64 data URL such as data:image/png;base64,...",
    );
  }

  const contentType = match[1].toLowerCase();
  const bytes = Buffer.from(match[2], "base64");

  if (bytes.byteLength === 0) {
    throw new NotConfiguredError("sourceImageDataUrl", "The start frame was empty.");
  }
  if (bytes.byteLength > MAX_SOURCE_BYTES) {
    throw new NotConfiguredError(
      "sourceImageDataUrl",
      `The start frame is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB. The limit is 12MB.`,
    );
  }

  // Only raster formats the video models accept. Accepting an arbitrary content
  // type here would put an HTML or SVG payload into storage under a .png name.
  const allowed = new Set(["image/png", "image/jpeg", "image/webp"]);
  if (!allowed.has(contentType)) {
    throw new NotConfiguredError(
      "sourceImageDataUrl",
      `Start frames must be PNG, JPEG or WebP. Received ${contentType}.`,
    );
  }

  const stored = await storage.put(bytes, { contentType, kind: "upload" });
  return stored.key;
}