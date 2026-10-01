/**
 * Image pricing.
 *
 * A separate module from `pricing.ts` because image and video pricing have
 * nothing in common structurally. Video exposes a flat `pricing_skus` map on the
 * model; images expose a `pricing` array of `{billable, unit, cost_usd}` rows
 * that only exists on a *second* call, per model, to `/endpoints`. Mixing them
 * would mean one module with two unrelated parser halves and a `kind` flag
 * threaded through every function.
 *
 * Everything here is derived from live `GET /api/v1/images/models/{id}/endpoints`
 * responses. The shapes below were read off real payloads, not from the docs.
 */

import { openrouterFetch, type FetchLike } from "./client";

/** One `pricing` row as returned by `/endpoints`. */
export interface RawImagePricingRow {
  /** "output_image" | "input_image" | "input_text" */
  billable: string;
  /** "image" | "megapixel" | "token" */
  unit: string;
  cost_usd: number;
  /**
   * Resolution tier, lowercase, when the row applies only to one.
   * Seen live as `"1k"` and `"2k"` on `qwen/qwen-image-3`.
   */
  variant?: string;
}

export interface RawImageEndpoint {
  provider_name: string;
  provider_slug: string;
  provider_tag: string;
  supported_parameters: Record<
    string,
    { type: string; values?: string[]; min?: number; max?: number }
  > | null;
  supported_parameters_json?: unknown;
  /**
   * Provider-specific keys that may be passed straight through.
   *
   * Present on every live payload seen so far, and declared because a test
   * fixture that reproduces a real response has to be able to include it. The
   * pricing engine ignores it — passthrough keys are not prices, and a key
   * appearing here says nothing about what a job costs.
   */
  allowed_passthrough_parameters?: string[];
  supports_streaming?: boolean;
  pricing: RawImagePricingRow[] | null;
}

export interface RawImageEndpointsResponse {
  id: string;
  endpoints: RawImageEndpoint[];
}

/**
 * A resolved output-price rule.
 *
 * Only output rows matter for quoting. Input rows are recorded so the estimator
 * can report what an image-to-image job would cost in references, but they are
 * never added to a text-to-image quote.
 */
export interface ImagePriceRule {
  unit: "image" | "megapixel" | "token";
  costUsd: number;
  /** Resolution tier this row applies to, lowercase. Undefined = any. */
  variant?: string;
}

export interface ImagePricing {
  /**
   * One rule per endpoint that has output pricing, cheapest endpoint first.
   *
   * A model can have several endpoints at different prices; OpenRouter routes
   * to whichever it picks. The cheapest is the honest lower bound for a quote,
   * and the real `usage.cost` reconciles it afterwards.
   */
  outputRules: ImagePriceRule[];
  /** Per-reference-image price, cheapest endpoint. USD. */
  usdPerInputImage?: number;
  /**
   * True when every endpoint prices output per token, so a quote is impossible
   * without the token count that only exists after the fact.
   */
  tokenOnly: boolean;
  /** False when no endpoint published any pricing at all. */
  hasPricing: boolean;
}

/**
 * Megapixels implied by a resolution string.
 *
 * Only the labels that actually appear in the live payloads: "1K", "2K", "4K".
 * A bare aspect ratio carries no pixel count, so it cannot produce a number
 * here — `undefined` means "unknown", never "assume 1 megapixel".
 */
export function megapixelsForResolution(resolution: string | null | undefined): number | undefined {
  if (!resolution) return undefined;
  const k = /^(\d+)k$/i.exec(resolution.trim());
  if (!k) return undefined;
  const side = Number(k[1]) * 1024;
  if (!Number.isFinite(side) || side <= 0) return undefined;
  return (side * side) / 1_000_000;
}

/**
 * Parse one endpoint's pricing array.
 *
 * `endpoint.pricing` is `[]` on some models rather than absent — an endpoint that
 * publishes no price is not the same as one that publishes a free price, and
 * neither is a price of zero.
 */
export function parseImagePricing(endpoints: RawImageEndpoint[]): ImagePricing {
  const outputRules: ImagePriceRule[] = [];
  let inputImage: number | undefined;
  /*
   * Starts false and is only ever set by a per-token output row actually being seen.
   *
   * The tempting initial value is `endpoints.length > 0` — "if the model has
   * endpoints but no quotable rule, it must be token-priced". That is wrong, and
   * `krea/krea-2-large` is the counter-example: one endpoint, `pricing: []`,
   * no token row anywhere. It reported "priced per token, token count not
   * published" for a model whose price OpenRouter simply has not listed, which
   * sends the reader looking for a token count that does not exist.
   */
  let tokenOnly = false;

  for (const endpoint of endpoints) {
    for (const row of endpoint.pricing ?? []) {
      const unit = row.unit as ImagePriceRule["unit"];
      if (!["image", "megapixel", "token"].includes(unit)) continue;

      if (row.billable === "input_image") {
        /*
         * Only a flat per-image price is usable here.
         *
         * `usdPerInputImage` is multiplied by the reference count to produce a
         * dollar amount, so a per-token input price cannot go into it. Storing one
         * anyway — which is what this did — silently misprices image-to-image on
         * every per-token model: `openai/gpt-image-2` publishes `input_image` at
         * $0.000008 *per token*, and treating that as the price of a whole image
         * undercharges by a factor of several hundred thousand, because the actual
         * cost is tokens × $0.000008 and the token count is not knowable in
         * advance.
         *
         * A per-token input price is therefore dropped, and the job falls into the
         * same unquotable path as a per-token output price. Overcharging is not on
         * the table either: the reference cost simply is not added to the quote,
         * and the settle path reconciles against what was really billed.
         */
        if (unit === "image" && (inputImage === undefined || row.cost_usd < inputImage)) {
          inputImage = row.cost_usd;
        }
        continue;
      }

      if (row.billable !== "output_image") continue;

      if (unit === "token") {
        tokenOnly = true;
        // Recorded, but never used to quote. There is no public token count per
        // image, so a per-token output price cannot be turned into a dollar
        // amount before the fact.
        continue;
      }

      tokenOnly = false;
      outputRules.push({
        unit,
        costUsd: row.cost_usd,
        ...(row.variant ? { variant: row.variant.toLowerCase() } : {}),
      });
    }
  }

  // Cheapest first. `tokenOnly` is cleared by any concrete output rule, so a model
  // with one per-token and one per-image endpoint is quotable via the per-image one.
  outputRules.sort((a, b) => a.costUsd - b.costUsd);

  return {
    outputRules,
    ...(inputImage !== undefined ? { usdPerInputImage: inputImage } : {}),
    tokenOnly: outputRules.length === 0 && tokenOnly,
    hasPricing: outputRules.length > 0 || inputImage !== undefined,
  };
}

export interface ImageQuoteInput {
  /** How many images to produce. Multiplies the output price. */
  count: number;
  /** "1K" | "2K" | "4K" or null. Only meaningful for megapixel-priced models. */
  resolution?: string | null;
  /** How many reference images are being sent, for image-to-image. */
  referenceCount?: number;
}

export type ImageQuote =
  | {
      estimable: true;
      costUsd: number;
      /** What the number is made of, in words, for the UI. */
      basis: string;
      unit: ImagePriceRule["unit"];
      costPerImageUsd: number;
    }
  | { estimable: false; reason: string; basis: string };

/**
 * Price an image request.
 *
 * Returns `estimable: false` with a reason rather than a zero. A zero renders as
 * "$0.00" and invites a job that then bills real money, which is exactly the
 * failure this whole module exists to prevent.
 */
export function quoteImage(
  pricing: ImagePricing,
  input: ImageQuoteInput,
): ImageQuote {
  const count = Math.max(1, Math.floor(input.count || 1));

  /*
   * The per-token case is checked before the no-pricing case, because both return
   * `estimable: false` and the two reasons are different in a way the reader can
   * act on. "Priced per token, token count not published" means the model is
   * perfectly real and the price exists — it just cannot be known in advance.
   * "No published price" means OpenRouter has not said what this costs at all,
   * which is a different thing to be told and a different thing to trust.
   *
   * Order matters because a per-token model has `hasPricing: false`: there is no
   * flat rule to quote from. Reporting it as "no published price" would be
   * accurate in the narrowest sense and misleading in the way that matters.
   */
  if (pricing.tokenOnly) {
    return {
      estimable: false,
      reason:
        "This model is priced per token and OpenRouter does not publish the token count for an image, so the cost cannot be quoted up front. Credits are held and refunded against the amount actually billed.",
      basis: "per-token pricing",
    };
  }

  if (!pricing.hasPricing) {
    return {
      estimable: false,
      reason:
        "OpenRouter published no price for this model, so the cost cannot be quoted. Credits are held and refunded against the amount actually billed.",
      basis: "no published price",
    };
  }

  // Pick the rule that matches the requested resolution. An exact match on the
  // variant wins; an unvarianted rule applies to any resolution; if every rule is
  // variant-tiered and none matches, the cheapest is the honest floor.
  const wanted = input.resolution?.trim().toLowerCase() ?? null;
  const rule =
    (wanted ? pricing.outputRules.find((r) => r.variant === wanted) : undefined) ??
    pricing.outputRules.find((r) => r.variant === undefined) ??
    pricing.outputRules[0];

  if (!rule) {
    // Unreachable for a per-token model, which is handled above. Reached when
    // `hasPricing` is true because an input-image price exists but no output rule
    // does — a real shape, so it gets a real message rather than a fallback.
    return {
      estimable: false,
      reason:
        "This model publishes a price for input images but not for the images it produces, so the output cost cannot be quoted. Credits are held and refunded against the amount actually billed.",
      basis: "no output price",
    };
  }

  let perImage: number;
  let basis: string;

  if (rule.unit === "megapixel") {
    const megapixels = megapixelsForResolution(input.resolution);
    if (megapixels === undefined) {
      return {
        estimable: false,
        reason:
          "This model is priced per megapixel and OpenRouter does not say how many megapixels a given aspect ratio produces. Choose an explicit resolution to get a price.",
        basis: "per-megapixel pricing",
      };
    }
    perImage = rule.costUsd * megapixels;
    basis = `${formatUsd(rule.costUsd)} per megapixel × ${megapixels} MP`;
  } else {
    perImage = rule.costUsd;
    basis = `${formatUsd(rule.costUsd)} per image${rule.variant ? ` (${rule.variant})` : ""}`;
  }

  const references = Math.max(0, Math.floor(input.referenceCount || 0));
  if (references > 0 && pricing.usdPerInputImage !== undefined) {
    const refCost = pricing.usdPerInputImage * references;
    perImage += 0; // keep the per-image figure meaning "per image", not "per input"
    return {
      estimable: true,
      costUsd: round6(perImage * count + refCost),
      basis: `${basis} × ${count}, plus ${formatUsd(refCost)} for ${references} reference image${references === 1 ? "" : "s"}`,
      unit: rule.unit,
      costPerImageUsd: rule.costUsd,
    };
  }

  return {
    estimable: true,
    costUsd: round6(perImage * count),
    basis: count === 1 ? basis : `${basis} × ${count}`,
    unit: rule.unit,
    costPerImageUsd: rule.costUsd,
  };
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(usd < 0.01 ? 6 : 4).replace(/0+$/, "").replace(/\.$/, ".0")}`;
}

/** Six decimals is well past any real price and keeps repeat quotes byte-stable. */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

interface Cached {
  at: number;
  byModel: Map<string, ImagePricing>;
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = globalThis as unknown as { __vantageImagePricing?: Cached };

function store(): Cached {
  cache.__vantageImagePricing ??= { at: Date.now(), byModel: new Map() };
  return cache.__vantageImagePricing;
}

/**
 * Fetch and parse pricing for one image model.
 *
 * One upstream call per model, cached for an hour per process. Not cached across
 * cold starts, because that would need a paid KV store — on Vercel the first
 * quote after a deploy pays the extra round trip and every one after that is
 * free until the instance recycles.
 *
 * A failure returns an empty pricing rather than throwing. Image quoting is a
 * convenience; failing the whole quote request because one optional price
 * lookup timed out would take the UI down for a number it can display as
 * "unknown".
 */
export async function imagePricingFor(
  modelId: string,
  opts: { fetchImpl?: FetchLike } = {},
): Promise<ImagePricing> {
  const c = store();

  const hit = c.byModel.get(modelId);
  if (hit && Date.now() - c.at < CACHE_TTL_MS) return hit;

  let parsed: ImagePricing;
  try {
    const payload = await openrouterFetch<RawImageEndpointsResponse>(
      `/images/models/${modelId}/endpoints`,
      {
        timeoutMs: 15_000,
        attempts: 2,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      },
    );
    parsed = parseImagePricing(payload.endpoints ?? []);
  } catch {
    parsed = { outputRules: [], tokenOnly: false, hasPricing: false };
  }

  c.byModel.set(modelId, parsed);
  return parsed;
}

export function clearImagePricingCache(): void {
  delete cache.__vantageImagePricing;
}