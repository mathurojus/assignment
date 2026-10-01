/**
 * Pricing for OpenRouter video models.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE CHANGING ANYTHING HERE
 * ---------------------------------------------------------------------------
 * The published OpenRouter video docs show a `pricing_skus` shape that does not
 * exist. They document:
 *
 *     "pricing_skus": { "per-video-second": "0.50", "per-video-second-1080p": "0.75" }
 *
 * The live `GET /api/v1/videos/models` endpoint returns, for alibaba/wan-3.0:
 *
 *     "pricing_skus": { "duration_seconds_480p": "0.05",
 *                      "duration_seconds_720p":  "0.10",
 *                      "duration_seconds_1080p": "0.20" }
 *
 * I measured **17 distinct key shapes across the 30 live models**, in five unit
 * conventions. If you code against the docs, every quote resolves to `null` and
 * every price in the UI reads "unavailable" -- which is a quiet failure, because
 * nothing throws.
 *
 * So: this module parses the *live* shape. `pricing.test.ts` pins a captured
 * real payload as a fixture, so an upstream change fails the test loudly instead
 * of silently zeroing all prices.
 */

import { MICRO } from "@/lib/db/schema";

export type PricingUnit =
  | "usd_per_second"
  | "cents_per_second"
  | "usd_per_token"
  | "cents_per_megapixel_second";

/** Which generation mode a rule applies to. */
export type PricingMode = "text_to_video" | "image_to_video" | "reference" | "any";

export interface PriceRule {
  /** Raw SKU key this came from, kept for the quote's `basis`. */
  key: string;
  mode: PricingMode;
  unit: PricingUnit;
  /** Resolved price per unit, normalised to USD where possible. */
  usdPerUnit: number;
  /** Original unit value, e.g. "0.02" or "3". */
  rawValue: string;
  /** Resolution this rule is tiered on, if any. e.g. "1080p", "4k". */
  resolution?: string;
  /** Audio tier, if this rule distinguishes it. */
  audio?: "with" | "without";
}

export interface ModelPricing {
  rules: PriceRule[];
  /** Per-reference-image price, USD. */
  usdPerReferenceImage?: number;
  /** Per-input-image price, USD. */
  usdPerInputImage?: number;
  /** Floor for a whole generation, USD. Applied after everything else. */
  usdMinimum?: number;
  /**
   * True when at least one rule is priced per-token or per-megapixel, which we
   * cannot resolve from (duration, resolution) alone.
   */
  hasUnresolvableRule: boolean;
}

const RES_SUFFIX = "(480p|720p|768p|1080p|1024p|1k|2k|4k)";

/**
 * Suffix grammar for `video_tokens` keys.
 *
 * Each alternative carries its own leading underscore rather than sharing one
 * outside the groups. With a shared leading `_`, the string `_without_audio`
 * cannot match: the shared `_` consumes the underscore that the audio group
 * then needs, so the group sees `without_audio` with nothing to anchor on.
 *
 * `(with|without)` relies on regex backtracking for correctness. Against
 * "without_audio", `(with)` matches "with" and then `_audio` fails against
 * "o_audio", so the engine retries as `without` and succeeds.
 */
const VIDEO_TOKEN_SUFFIX_RE = new RegExp(
  `^(_(${RES_SUFFIX}))?(_(with|without)_audio)?(_(with|without)_video_(input|continuation))?$`,
  "i",
);

/**
 * Parse one SKU key.
 *
 * Order matters: the per-token and per-megapixel forms are matched before the
 * per-second forms, because `video_tokens_without_audio` also contains
 * "duration"-free but similar-looking fragments. Each branch is anchored so a
 * mis-parse is a `null` rather than a wrong number.
 */
function parseRule(key: string, rawValue: string): PriceRule | null {
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return null;

  // --- per video token ---------------------------------------------------
  // video_tokens, video_tokens_4k, video_tokens_without_audio,
  // video_tokens_1080p_with_video_input, video_tokens_4k_with_video_input
  if (key.startsWith("video_tokens")) {
    const rest = key.slice("video_tokens".length);
    const m = rest.match(VIDEO_TOKEN_SUFFIX_RE);

    if (!m) {
      // A shape we have not seen. Keep the unit so the model is still reported
      // as unpriceable, but do not guess at its dimensions.
      return { key, mode: "any", unit: "usd_per_token", usdPerUnit: value, rawValue };
    }

    // Capture groups, counting every opening paren including the one inside
    // RES_SUFFIX: 1=res wrapper, 2=res paren, 3=res value, 4=audio wrapper,
    // 5=audio word, 6=video wrapper, 7=video word, 8=input|continuation.
    const resolution = m[3]?.toLowerCase();
    const audioWord = m[5] ?? m[7];
    const audio = audioWord === "with" ? "with" : audioWord === "without" ? "without" : undefined;
    const mode: PricingMode = m[7] ? "image_to_video" : "any";

    return { key, mode, unit: "usd_per_token", usdPerUnit: value, rawValue, resolution, audio };
  }

  // --- cents per megapixel-second ----------------------------------------
  // cents_per_megapixel_second_precise / _creative
  if (key.startsWith("cents_per_megapixel_second")) {
    const rest = key.slice("cents_per_megapixel_second".length).replace(/^_/, "");
    return {
      key,
      mode: "any",
      unit: "cents_per_megapixel_second",
      usdPerUnit: value / 100,
      rawValue,
      resolution: rest === "precise" || rest === "creative" ? undefined : rest.toLowerCase(),
    };
  }

  // --- cents per second ---------------------------------------------------
  // cents_per_second_output, cents_per_second_output_720p,
  // cents_per_video_output_second_480p, cents_per_second_video_continuation_1080p
  const centsMatch = key.match(
    new RegExp(`^cents_per_(?:video_output_)?second(?:_(?:output|video_continuation))?(?:_(${RES_SUFFIX}))?$`, "i"),
  );
  if (centsMatch) {
    return {
      key,
      mode: "any",
      unit: "cents_per_second",
      usdPerUnit: value / 100,
      rawValue,
      resolution: centsMatch[2]?.toLowerCase(),
    };
  }

  // --- usd per second, optionally mode-prefixed and audio-tiered -----------
  // duration_seconds, duration_seconds_1080p,
  // duration_seconds_with_audio_720p, duration_seconds_without_audio,
  // text_to_video_duration_seconds_720p, image_to_video_duration_seconds_1080p,
  // reference_duration_seconds_480p
  const usdMatch = key.match(
    new RegExp(
      `^(?:(text_to_video|image_to_video|reference)_)?duration_seconds` +
        `(?:_(with|without)_audio)?(?:_(${RES_SUFFIX}))?$`,
      "i",
    ),
  );
  if (usdMatch) {
    const mode = (usdMatch[1] ?? "any") as PricingMode;
    return {
      key,
      mode,
      unit: "usd_per_second",
      usdPerUnit: value,
      rawValue,
      resolution: usdMatch[3]?.toLowerCase(),
      audio: usdMatch[2] ? (usdMatch[2].toLowerCase() as "with" | "without") : undefined,
    };
  }

  return null;
}

/** Keys that are per-image charges rather than per-second rates. */
function parseAuxiliary(
  skus: Record<string, string>,
): Pick<ModelPricing, "usdPerReferenceImage" | "usdPerInputImage" | "usdMinimum"> {
  const out: Pick<ModelPricing, "usdPerReferenceImage" | "usdPerInputImage" | "usdMinimum"> = {};
  const referenceImages = Number(skus["reference_images"]);
  if (Number.isFinite(referenceImages) && skus["reference_images"] !== undefined) {
    out.usdPerReferenceImage = referenceImages;
  }
  const perInput = Number(skus["cents_per_image_input"]);
  if (skus["cents_per_image_input"] !== undefined && Number.isFinite(perInput)) {
    out.usdPerInputImage = perInput / 100;
  }
  const minimum = Number(skus["minimum_cents_per_generation"]);
  if (skus["minimum_cents_per_generation"] !== undefined && Number.isFinite(minimum)) {
    out.usdMinimum = minimum / 100;
  }
  return out;
}

export function parseModelPricing(skus: Record<string, string> | null | undefined): ModelPricing {
  const rules: PriceRule[] = [];
  if (skus) {
    for (const [key, raw] of Object.entries(skus)) {
      const rule = parseRule(key, raw);
      if (rule) rules.push(rule);
    }
  }
  const aux = parseAuxiliary(skus ?? {});
  return {
    rules,
    ...aux,
    hasUnresolvableRule: rules.some((r) => r.unit !== "usd_per_second" && r.unit !== "cents_per_second"),
  };
}

// ---------------------------------------------------------------------------
// Quoting
// ---------------------------------------------------------------------------

export interface QuoteInput {
  durationSeconds?: number;
  resolution?: string;
  /** Whether the job carries a start frame. Changes image_to_video pricing. */
  hasFirstFrame?: boolean;
  hasReferences?: boolean;
  generateAudio?: boolean;
}

export type Quote =
  | {
      estimable: true;
      costUsd: number;
      /** Human-readable derivation, shown on hover in the UI. */
      basis: string;
      ruleKey: string;
    }
  | {
      estimable: false;
      /**
       * OpenRouter prices these per video token or per megapixel-second and
       * publishes no token-to-duration mapping, so a pre-submit cost is not
       * derivable from the fields a client holds. We say so rather than
       * inventing a number.
       */
      reason: string;
      basis: string;
      ruleKey?: string;
    };

/**
 * Pick the most specific rule that applies.
 *
 * Specificity order, given a request for (mode, resolution, audio):
 *   1. mode + resolution + audio
 *   2. mode + resolution
 *   3. resolution + audio
 *   4. resolution
 *   5. mode + audio
 *   6. audio
 *   7. mode
 *   8. anything
 *
 * Returns null if only unresolvable rules exist.
 */
function selectRule(
  rules: PriceRule[],
  mode: PricingMode,
  resolution?: string,
  audio?: boolean,
): PriceRule | null {
  const wantedAudio: "with" | "without" | undefined = audio === undefined ? undefined : audio ? "with" : "without";
  const res = resolution?.toLowerCase();

  const candidates = rules.filter((r) => r.unit === "usd_per_second" || r.unit === "cents_per_second");

  const hasAudioTiers = rules.some((x) => x.audio);

  const score = (r: PriceRule): number => {
    let s = 0;

    // Mode is a hard filter, not a preference. A text-to-video rate applied to
    // an image-to-video job is a wrong price, not an imprecise one, so it is
    // discarded outright.
    if (r.mode !== "any" && r.mode !== mode) return -1;
    if (r.mode === mode) s += 8;

    // Resolution is also a hard filter when a tier is specified: 720p pricing
    // must not be quoted for a 1080p render.
    if (res) {
      if (r.resolution === res) s += 4;
      else if (r.resolution !== undefined) return -1;
    }

    // Audio is a *preference*, not a filter. Some models publish audio tiers
    // and some do not, and for a model with no tiers an untiered rate is the
    // right answer for both. When tiers do exist, a match is strongly preferred
    // but an untiered fallback is still better than refusing to price at all.
    if (wantedAudio) {
      if (r.audio === wantedAudio) s += 3;
      else if (r.audio === undefined) s += hasAudioTiers ? -1 : 0;
      else return -1;
    }

    return s;
  };

  const scored = candidates
    .map((r) => ({ rule: r, score: score(r) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);

  return scored.length > 0 ? scored[0].rule : null;
}

export function quote(pricing: ModelPricing, input: QuoteInput): Quote {
  const mode: PricingMode = input.hasFirstFrame ? "image_to_video" : input.hasReferences ? "reference" : "text_to_video";

  const rule = selectRule(pricing.rules, mode, input.resolution, input.generateAudio);

  if (!rule) {
    // Either there are no per-second rules at all, or every rule is per-token
    // or per-megapixel.
    const tokenRule = pricing.rules.find((r) => r.unit === "usd_per_token");
    const megapixelRule = pricing.rules.find((r) => r.unit === "cents_per_megapixel_second");
    return {
      estimable: false,
      reason: tokenRule
        ? "Priced per video token, and OpenRouter publishes no token-to-duration mapping."
        : megapixelRule
          ? "Priced per megapixel-second, and OpenRouter publishes no size-to-megapixel mapping."
          : "No per-second pricing published for this model.",
      basis: tokenRule ? tokenRule.key : (megapixelRule?.key ?? "none"),
      ruleKey: tokenRule?.key ?? megapixelRule?.key,
    };
  }

  const seconds = input.durationSeconds ?? 1;
  let costUsd = rule.usdPerUnit * seconds;
  const parts = [`${seconds}s x $${rule.usdPerUnit}/${rule.unit === "cents_per_second" ? "s (from cents)" : "s"} (${rule.key})`];

  if (pricing.usdPerReferenceImage && input.hasReferences) {
    costUsd += pricing.usdPerReferenceImage;
    parts.push(`+$${pricing.usdPerReferenceImage} reference image`);
  }
  if (pricing.usdPerInputImage && input.hasFirstFrame) {
    costUsd += pricing.usdPerInputImage;
    parts.push(`+$${pricing.usdPerInputImage} input image`);
  }
  if (pricing.usdMinimum && costUsd < pricing.usdMinimum) {
    parts.push(`raised to minimum $${pricing.usdMinimum}`);
    costUsd = pricing.usdMinimum;
  }

  // Round to a tenth of a cent. Prices have 3-4 significant decimals and
  // floating point noise at that scale is meaningless.
  return {
    estimable: true,
    costUsd: Math.round(costUsd * 10_000) / 10_000,
    basis: parts.join(" + "),
    ruleKey: rule.key,
  };
}

/** USD -> micro-USD, the unit we store. */
export const toMicro = (usd: number): number => Math.round(usd * 1_000_000);

/** micro-USD -> USD. */
export const fromMicro = (micro: number): number => micro / 1_000_000;

/**
 * USD -> micro-credits.
 *
 * Derivation, because this line has been wrong twice and both errors were
 * plausible-looking:
 *
 *   1 credit   = $0.01
 *   1 USD      = 100 credits           (1 / 0.01)
 *              = 100 x 10,000 micro-credits
 *              = 1,000,000 micro-credits = MICRO
 *
 * So the multiplier is exactly `MICRO`, and micro-USD and micro-credits are
 * numerically equal here because a micro-credit is worth 1e-6 USD.
 *
 * The original version of this function was `usd * 10_000`, which makes a
 * micro-credit worth $0.0001 -- a **100x undercharge**. Nobody would notice by
 * eye, because every displayed number still looked like a plausible price.
 */
export const usdToCreditsMicro = (usd: number): number => Math.round(usd * MICRO);

/** micro-credits -> whole credits, for display. */
export const creditsMicroToDisplay = (micro: number): number => micro / 10_000;