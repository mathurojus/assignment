import { z } from "zod";
import { chat } from "@/lib/openrouter/video";
import { listVideoModels } from "@/lib/openrouter/models";
import { getPreset } from "@/lib/presets";
import { getSessionUser } from "@/lib/supabase/server";
import { apiError, ok, route } from "@/lib/api";
import { env, hasOpenRouterKey } from "@/lib/env";
import { userRateBucket } from "@/lib/ratelimit";

/**
 * Rewrite a rough prompt into one a video model will understand.
 *
 * The single highest-leverage feature in an app like this: most disappointing
 * output is a vague prompt, not a bad model. Video models in particular reward
 * explicit camera, lighting and subject description, which people do not
 * naturally write.
 *
 * Two deliberate constraints:
 *
 *  1. It costs real money, so it is rate limited separately from generation. A
 *     per-user bucket means one person cannot drain the operator's OpenRouter
 *     credits by holding down a button.
 *  2. It never touches the credits ledger. Charging for a text rewrite that
 *     usually fails to change the outcome would be user-hostile, and it would
 *     make the ledger's meaning ambiguous.
 */
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const body = z.object({
  prompt: z.string().min(3).max(2000),
  /** The model the enhanced prompt is for. Its capabilities shape the rewrite. */
  model: z.string().max(200).optional(),
  presetSlug: z.string().max(60).optional(),
  durationSeconds: z.number().int().min(1).max(30).optional(),
  aspectRatio: z.string().max(20).optional(),
});

/**
 * The rewrite brief.
 *
 * Written as an instruction to produce one paragraph of prose, not a list. Video
 * models trained on caption-like text respond better to a single descriptive
 * sentence than to a bulleted spec, and a bulleted spec is also what users then
 * have to read before they can judge it.
 *
 * Kept in one place so it can be changed without touching the route.
 */
const SYSTEM = `You rewrite short image and video prompts into vivid, specific descriptions for generative media models.

Rules:
- Return ONLY the rewritten prompt. No preamble, no quotes, no explanation, no lists.
- One paragraph, at most 60 words.
- Keep everything the user explicitly asked for. Never contradict their intent, and never substitute a different subject, setting or mood.
- Add only what was unspecified and is visually load-bearing: camera angle and movement, lighting, lens character, colour palette, texture, and the subject's action or expression.
- Write in the present tense and the active voice.
- Do not invent brand names, text or watermarks.
- Never include names of real people, living or dead.
- If the user's prompt is already specific and cinematic, return it essentially unchanged. Rewriting for its own sake is worse than leaving it alone.`;

export async function POST(request: Request) {
  return route(async () => {
    if (!hasOpenRouterKey) {
      return apiError(
        "not_configured",
        "OPENROUTER_API_KEY is not set, so prompts cannot be enhanced.",
      );
    }

    const user = await getSessionUser();
    if (!user) {
      return apiError("unauthorized", "Sign in to enhance prompts.");
    }

    // Separate bucket from generation. Without it, enhancement is the cheapest
    // way to burn the operator's OpenRouter credits.
    const bucket = await userRateBucket("enhance", user.id);
    if (!bucket.allowed) {
      return apiError(
        "rate_limited",
        `Enhancement limit reached (${bucket.limit} per hour). Generation is unaffected.`,
        { retryAfterSeconds: bucket.retryAfterSeconds },
      );
    }

    let parsed: z.infer<typeof body>;
    try {
      parsed = body.parse(await request.json());
    } catch (e) {
      if (e instanceof z.ZodError) {
        return apiError("validation_failed", "That prompt could not be enhanced.", {
          fields: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
        });
      }
      return apiError("validation_failed", "Expected a JSON body.");
    }

    const preset = parsed.presetSlug ? getPreset(parsed.presetSlug) : undefined;
    if (parsed.presetSlug && !preset) {
      return apiError("validation_failed", `"${parsed.presetSlug}" is not a camera preset.`);
    }

    // Model capabilities become hard constraints in the brief, so the rewrite
    // does not ask for something the model cannot do -- which OpenRouter rejects
    // at generation time, after the credits are already held.
    let constraints: string[] = [];
    if (parsed.model) {
      const models = await listVideoModels();
      const model = models.find((m) => m.id === parsed.model);
      if (model) {
        const notes: string[] = [];
        if (model.durations.length <= 2) {
          notes.push(
            `The clip is ${model.durations.join(" or ")} seconds long, so the prompt must describe one continuous moment, not a sequence.`,
          );
        }
        if (parsed.durationSeconds && model.durations.includes(parsed.durationSeconds)) {
          notes.push(`Keep the description to what happens in ${parsed.durationSeconds} seconds.`);
        }
        if (model.supportsAudio && !model.resolutions.length) {
          notes.push("Audio is available, so you may add a brief ambient sound if it fits.");
        }
        constraints = notes;
      }
    }

    const userPrompt = [
      `Rewrite this prompt:\n\n${parsed.prompt.trim()}`,
      preset
        ? `The camera preset "${preset.name}" will be applied afterwards, so do not repeat it: ${preset.description}.`
        : "",
      parsed.aspectRatio ? `The frame is ${parsed.aspectRatio}.` : "",
      ...constraints,
    ]
      .filter(Boolean)
      .join("\n\n");

    let text: string;
    try {
      const result = await chat({
        model: env.ENHANCER_MODEL,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: userPrompt },
        ],
        // Nudged above zero so two rewrites of the same prompt differ. At 0 the
        // rewrite becomes a lookup, and the whole point is to offer a new
        // reading. Not higher: the brief also says to preserve the user's intent,
        // and a creative model ignores instructions it finds uninteresting.
        temperature: 0.6,
        // 220 tokens is roughly two paragraphs. The brief caps the output at 60
        // words, and a generous ceiling lets it comply rather than truncating
        // mid-sentence.
        max_tokens: 220,
      });
      text = result.choices[0]?.message.content ?? "";
    } catch (error) {
      // A failed enhancement must not block generation. The user's own words are
      // always a valid prompt; this is an upgrade, not a requirement.
      console.warn("[enhance] failed, falling back to the original prompt:", error);
      return ok({
        enhanced: parsed.prompt.trim(),
        fallback: true,
        message: "Enhancement is unavailable right now, so your prompt was used as written.",
      });
    }

    const cleaned = cleanEnhancement(text) ?? parsed.prompt.trim();

    return ok({
      enhanced: cleaned,
      fallback: cleaned === parsed.prompt.trim(),
      preset: preset ? { slug: preset.slug, name: preset.name, description: preset.description } : null,
    });
  });
}

/**
 * Strip whatever the model wrapped the answer in.
 *
 * Chat models are inconsistent about quoting their output even when told not to,
 * and a prompt that starts and ends with a quote character renders visibly wrong
 * in the UI and sends a stray character to the video model.
 *
 * Returns null when nothing usable is left, so the caller can fall back to the
 * user's own words rather than storing an empty enhanced prompt.
 */
export function cleanEnhancement(raw: string): string | null {
  let text = raw.trim();

  // A model that ignored "no preamble" and wrote a lead-in.
  text = text.replace(/^(here(?:'s| is)\s+(?:an?\s+)?(?:enhanced|improved|rewritten)[^:]*:\s*)/i, "");
  text = text.replace(/^(enhanced|improved|rewritten)\s+prompt\s*:\s*/i, "");

  // Matching surrounding quotes, possibly curly, possibly a code fence.
  const fence = /^```[a-z]*\s*([\s\S]*?)\s*```$/i.exec(text);
  if (fence?.[1]) text = fence[1].trim();

  if (/^["'“‘]/.test(text) && /["'”’]$/.test(text)) {
    text = text.slice(1, -1).trim();
  }

  // Collapse to one paragraph. Enumerated rewrites read worse to a video model.
  text = text.replace(/\s*\n+\s*/g, " ").trim();

  if (text.length < 3) return null;
  // Refuse an answer that is wildly longer than the input. It means the model
  // wrote an essay rather than a prompt, and sending that upstream wastes a
  // paid generation on something that will not render.
  if (text.length > 1200) text = `${text.slice(0, 1197).trimEnd()}...`;

  return text;
}