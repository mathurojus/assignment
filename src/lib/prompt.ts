import { getPreset, type Preset } from "./presets";

/**
 * Turning a user's short idea into the prompt that actually gets sent.
 *
 * Two things are deliberately kept separate:
 *
 *  - `enhancePrompt()` is the LLM's rewrite. It is a *draft* and the user
 *    always sees it before it is used.
 *  - `assemblePrompt()` is deterministic assembly. No model involved, so the
 *    output for a given input is fixed and testable.
 *
 * The user's original words are what the database stores as `prompt`. An LLM
 * rewrite is not allowed to quietly become the record of what the user asked
 * for -- that would make the log and the gallery lie.
 */

export interface AssembleInput {
  /** What the user typed. Verbatim, never overwritten. */
  prompt: string;
  /** Output of the enhancer, if the user accepted it. */
  enhancedPrompt?: string | null;
  preset?: Preset | { slug: string } | null;
  /** Camera fragment to inject, when the preset is applied manually. */
  presetSlug?: string | null;
  aspectRatio?: string | null;
  resolution?: string | null;
  durationSeconds?: number | null;
  audio?: boolean | null;
}

const MAX_PROMPT_CHARS = 4000;

/** Cut at a sentence boundary where possible, so we never emit half a clause. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastStop = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
    slice.lastIndexOf("\n"),
  );
  return lastStop > max * 0.6 ? slice.slice(0, lastStop + 1) : slice.trimEnd();
}

/**
 * Build the final prompt string.
 *
 * Order is meaningful: subject and action first (the model weights the opening
 * most heavily), then camera motion, then technical constraints last so they do
 * not compete with the scene description for the model's attention.
 */
export function assemblePrompt(input: AssembleInput): string {
  const preset =
    (input.preset && "promptFragment" in input.preset
      ? (input.preset as Preset)
      : getPreset(input.presetSlug)) ?? undefined;

  // The enhanced prompt replaces the user's text as the scene description, but
  // the user's own words are appended as the authoritative statement of intent.
  const scene = (input.enhancedPrompt?.trim() || input.prompt.trim()).replace(/\s+/g, " ");

  const parts: string[] = [scene];

  if (preset) parts.push(preset.promptFragment);
  if (input.audio) parts.push("with synchronised audio and ambient sound design");

  const technical: string[] = [];
  if (input.resolution) technical.push(`${input.resolution} output`);
  if (input.aspectRatio) technical.push(`${input.aspectRatio} aspect ratio`);
  if (input.durationSeconds) technical.push(`${input.durationSeconds} second duration`);
  if (technical.length > 0) parts.push(technical.join(", "));

  const assembled = parts.filter(Boolean).join(", ");

  // When the enhancer ran, keep the user's original phrasing visible. It costs a
  // few tokens and it stops the final prompt from quietly discarding what the
  // user actually typed.
  const withOriginal =
    input.enhancedPrompt?.trim() && input.prompt.trim()
      ? `${assembled}. Original intent: ${input.prompt.trim().replace(/\s+/g, " ")}`
      : assembled;

  return truncate(withOriginal, MAX_PROMPT_CHARS);
}

/**
 * The negative fragment, when the preset has one and the model can take it.
 *
 * Most models do not accept a negative_prompt parameter (only a few list it in
 * allowed_passthrough_parameters), so this is advisory: we surface it in the UI
 * and only send it when the model advertises support.
 */
export function assembleNegativePrompt(input: AssembleInput): string | null {
  const preset =
    (input.preset && "promptFragment" in input.preset
      ? (input.preset as Preset)
      : getPreset(input.presetSlug)) ?? undefined;
  return preset?.negativeFragment?.trim() || null;
}

// ---------------------------------------------------------------------------
// The enhancer
// ---------------------------------------------------------------------------

const ENHANCER_SYSTEM = `You rewrite short visual ideas into production-grade prompts for a video generation model.

Rules:
- Return ONLY the prompt text. No preamble, no quotes, no markdown, no explanation.
- One paragraph. Commas and semicolons, not newlines.
- Be concrete and visual. Name the subject, the action, the light, the palette, the texture, and the mood.
- Do not invent a subject that contradicts the idea.
- Do not wrap the result in quotation marks.
- Keep it under 120 words.`;

export function buildEnhancerMessages(input: {
  idea: string;
  presetName?: string;
  presetDescription?: string;
  aspectRatio?: string | null;
  resolution?: string | null;
  durationSeconds?: number | null;
}): Array<{ role: "system" | "user"; content: string }> {
  const context: string[] = [`Idea: ${input.idea.trim()}`];
  if (input.presetName) {
    context.push(
      `Camera: ${input.presetName}${input.presetDescription ? ` (${input.presetDescription})` : ""}`,
    );
  }
  if (input.resolution) context.push(`Target resolution: ${input.resolution}`);
  if (input.aspectRatio) context.push(`Target aspect ratio: ${input.aspectRatio}`);
  if (input.durationSeconds) context.push(`Duration: ${input.durationSeconds}s`);

  return [
    { role: "system", content: ENHANCER_SYSTEM },
    { role: "user", content: context.join("\n") },
  ];
}

/** Strip the wrappers models like to add despite being told not to. */
export function cleanEnhancedPrompt(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "");
  text = text.replace(/^(prompt|prompt:)\s*/i, "");
  text = text.replace(/^["'“”]+/, "").replace(/["'“”]+$/, "");
  text = text.replace(/\s+/g, " ").trim();
  return truncate(text, MAX_PROMPT_CHARS);
}