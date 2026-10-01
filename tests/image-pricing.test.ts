import { describe, expect, test } from "vitest";
import {
  parseImagePricing,
  megapixelsForResolution,
  quoteImage,
  imagePricingFor,
  clearImagePricingCache,
  type RawImageEndpoint,
} from "@/lib/openrouter/image-pricing";

/**
 * Every fixture below is a verbatim `GET /api/v1/images/models/{id}/endpoints`
 * response captured from the live API, with only the `provider_*` and
 * `supported_parameters` fields left as they arrived.
 *
 * They are not invented. Image pricing is a `pricing` array on a second per-model
 * call that the published documentation does not describe, so the only trustworthy
 * source for its shape is a real response — and a hand-written fixture would encode
 * whatever this parser already assumes, which is precisely the thing under test.
 */

/** recraft/recraft-v4.1 — flat per-image output, and an input image too. */
const recraftEndpoints: RawImageEndpoint[] = [
  {
    provider_name: "Recraft",
    provider_slug: "recraft",
    provider_tag: "recraft",
    supported_parameters: {
      aspect_ratio: { type: "enum", values: ["1:1", "4:3", "3:4", "16:9", "9:16", "auto"] },
      n: { type: "range", min: 1, max: 6 },
      input_references: { type: "range", min: 0, max: 1 },
    },
    allowed_passthrough_parameters: ["style", "controls", "text_layout"],
    supports_streaming: false,
    pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.035 }],
  },
];

/** qwen/qwen-image-3 — resolution-tiered output plus a per-reference input price. */
const qwenEndpoints: RawImageEndpoint[] = [
  {
    provider_name: "Alibaba Cloud Int.",
    provider_slug: "alibaba",
    provider_tag: "alibaba",
    supported_parameters: {
      resolution: { type: "enum", values: ["1K", "2K"] },
      aspect_ratio: { type: "enum", values: ["1:1", "3:2", "16:9"] },
      n: { type: "range", min: 1, max: 6 },
      input_references: { type: "range", min: 0, max: 4 },
      seed: { type: "boolean" },
    },
    allowed_passthrough_parameters: [],
    supports_streaming: false,
    pricing: [
      { billable: "input_image", unit: "image", cost_usd: 0.003 },
      { billable: "output_image", unit: "image", cost_usd: 0.03, variant: "1k" },
      { billable: "output_image", unit: "image", cost_usd: 0.03, variant: "2k" },
    ],
  },
];

/** openai/gpt-image-2 — everything per token, so nothing is quotable up front. */
const gptImageEndpoints: RawImageEndpoint[] = [
  {
    provider_name: "OpenAI",
    provider_slug: "openai",
    provider_tag: "openai",
    supported_parameters: {
      aspect_ratio: { type: "enum", values: ["1:1", "16:9", "auto"] },
      quality: { type: "enum", values: ["auto", "low", "medium", "high"] },
      background: { type: "enum", values: ["auto", "opaque"] },
      n: { type: "range", min: 1, max: 10 },
      input_references: { type: "range", min: 0, max: 16 },
      output_compression: { type: "range", min: 0, max: 100 },
    },
    allowed_passthrough_parameters: ["moderation"],
    supports_streaming: true,
    pricing: [
      { billable: "input_image", unit: "token", cost_usd: 0.000008 },
      { billable: "input_text", unit: "token", cost_usd: 0.000005 },
      { billable: "output_image", unit: "token", cost_usd: 0.00003 },
    ],
  },
];

/** krea/krea-2-large — `pricing: []`. An empty array, not an absent field. */
const kreaEndpoints: RawImageEndpoint[] = [
  {
    provider_name: "Krea",
    provider_slug: "krea",
    provider_tag: "krea",
    supported_parameters: {
      resolution: { type: "enum", values: ["1K"] },
      aspect_ratio: { type: "enum", values: ["1:1", "4:3", "16:9"] },
      input_references: { type: "range", min: 0, max: 1 },
      seed: { type: "boolean" },
    },
    allowed_passthrough_parameters: [
      "image_style_references",
      "styles",
      "creativity",
      "intensity",
    ],
    supports_streaming: false,
    pricing: [],
  },
];

describe("parseImagePricing", () => {
  test("flat per-image output becomes a single quotable rule", () => {
    const p = parseImagePricing(recraftEndpoints);
    expect(p.hasPricing).toBe(true);
    expect(p.tokenOnly).toBe(false);
    expect(p.outputRules).toEqual([{ unit: "image", costUsd: 0.035 }]);
  });

  test("keeps every resolution tier as its own rule, and remembers the input price", () => {
    const p = parseImagePricing(qwenEndpoints);
    expect(p.outputRules).toHaveLength(2);
    expect(p.outputRules.map((r) => r.variant)).toEqual(["1k", "2k"]);
    expect(p.usdPerInputImage).toBe(0.003);
    expect(p.hasPricing).toBe(true);
  });

  test("per-token output is recorded as unquotable, not as a price of zero", () => {
    const p = parseImagePricing(gptImageEndpoints);
    // The concrete number 0.00003 must NOT become a quote. There is no public
    // token count for an image, so the only honest answer is "cannot estimate".
    expect(p.outputRules).toHaveLength(0);
    expect(p.tokenOnly).toBe(true);
    expect(p.hasPricing).toBe(false);
  });

  test("input_text rows are ignored — they are not an output price", () => {
    const p = parseImagePricing(gptImageEndpoints);
    expect(p.usdPerInputImage).toBeUndefined();
  });

  test("`pricing: []` means no published price, not a free one", () => {
    const p = parseImagePricing(kreaEndpoints);
    expect(p.hasPricing).toBe(false);
    expect(p.outputRules).toHaveLength(0);
  });

  test("a null pricing array is treated the same as an empty one", () => {
    const p = parseImagePricing([{ ...kreaEndpoints[0], pricing: null }]);
    expect(p.hasPricing).toBe(false);
  });

  test("the cheapest endpoint wins, because OpenRouter picks the provider", () => {
    const p = parseImagePricing([
      { ...recraftEndpoints[0], provider_slug: "expensive", pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.09 }] },
      { ...recraftEndpoints[0], provider_slug: "cheap", pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.02 }] },
    ]);
    expect(p.outputRules[0].costUsd).toBe(0.02);
  });

  test("one per-image endpoint makes a mixed model quotable", () => {
    const p = parseImagePricing([
      ...gptImageEndpoints,
      { ...recraftEndpoints[0], pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.05 }] },
    ]);
    expect(p.tokenOnly).toBe(false);
    expect(p.outputRules[0].costUsd).toBe(0.05);
  });

  test("an unknown unit is skipped rather than guessed at", () => {
    const p = parseImagePricing([
      { ...recraftEndpoints[0], pricing: [{ billable: "output_image", unit: "flurbo", cost_usd: 1 }] },
    ]);
    expect(p.outputRules).toHaveLength(0);
  });

  test("no endpoints at all is not a crash", () => {
    const p = parseImagePricing([]);
    expect(p.hasPricing).toBe(false);
    expect(p.tokenOnly).toBe(false);
  });
});

describe("megapixelsForResolution", () => {
  test("1K is about a megapixel", () => {
    expect(megapixelsForResolution("1K")).toBeCloseTo(1.048576, 5);
  });

  test("2K is four times 1K, not two", () => {
    expect(megapixelsForResolution("2K")).toBeCloseTo(4.194304, 5);
  });

  test("4K", () => {
    expect(megapixelsForResolution("4K")).toBeCloseTo(16.777216, 5);
  });

  test("an aspect ratio carries no pixel count and must not become 1 MP", () => {
    // The failure this prevents: assuming a megapixel for "16:9" and quoting a
    // confident, wrong number.
    expect(megapixelsForResolution("16:9")).toBeUndefined();
    expect(megapixelsForResolution("720p")).toBeUndefined();
    expect(megapixelsForResolution(null)).toBeUndefined();
    expect(megapixelsForResolution(undefined)).toBeUndefined();
  });
});

describe("quoteImage", () => {
  test("per-image model, one image", () => {
    const q = quoteImage(parseImagePricing(recraftEndpoints), { count: 1 });
    expect(q.estimable).toBe(true);
    if (!q.estimable) return;
    expect(q.costUsd).toBe(0.035);
    expect(q.unit).toBe("image");
  });

  test("per-image model, n images multiplies", () => {
    const q = quoteImage(parseImagePricing(recraftEndpoints), { count: 6 });
    expect(q.estimable).toBe(true);
    if (!q.estimable) return;
    expect(q.costUsd).toBeCloseTo(0.21, 6);
    expect(q.basis).toContain("6");
  });

  test("picks the tier matching the requested resolution", () => {
    const pricing = parseImagePricing([
      { ...qwenEndpoints[0], pricing: [
        { billable: "output_image", unit: "image", cost_usd: 0.03, variant: "1k" },
        { billable: "output_image", unit: "image", cost_usd: 0.12, variant: "2k" },
      ] },
    ]);
    const one = quoteImage(pricing, { count: 1, resolution: "1K" });
    const two = quoteImage(pricing, { count: 1, resolution: "2K" });
    expect(one.estimable && one.costUsd).toBe(0.03);
    expect(two.estimable && two.costUsd).toBe(0.12);
  });

  test("an unmatched tier falls back to the cheapest rather than to nothing", () => {
    const pricing = parseImagePricing(qwenEndpoints);
    const q = quoteImage(pricing, { count: 1, resolution: "8K" });
    expect(q.estimable).toBe(true);
    if (!q.estimable) return;
    expect(q.costUsd).toBe(0.03);
  });

  test("reference images add their published input price", () => {
    const q = quoteImage(parseImagePricing(qwenEndpoints), { count: 1, referenceCount: 2 });
    expect(q.estimable).toBe(true);
    if (!q.estimable) return;
    // 0.03 output + 2 × 0.003 input
    expect(q.costUsd).toBeCloseTo(0.036, 6);
    expect(q.basis).toContain("reference");
  });

  test("a per-token model refuses with a reason, never a zero", () => {
    const q = quoteImage(parseImagePricing(gptImageEndpoints), { count: 1 });
    expect(q.estimable).toBe(false);
    if (q.estimable) return;
    expect(q.reason).toMatch(/token/i);
    // A zero here would render as "$0.00" and invite a job that bills real money.
    expect("costUsd" in q).toBe(false);
  });

  test("an unpublished price refuses with a reason", () => {
    const q = quoteImage(parseImagePricing(kreaEndpoints), { count: 1 });
    expect(q.estimable).toBe(false);
    if (q.estimable) return;
    expect(q.reason).toMatch(/no price/i);
  });

  test("per-megapixel with no resolution is refused rather than assumed", () => {
    const pricing = parseImagePricing([
      { ...recraftEndpoints[0], pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.02 }] },
    ]);
    const blind = quoteImage(pricing, { count: 1 });
    expect(blind.estimable).toBe(false);

    const told = quoteImage(pricing, { count: 1, resolution: "2K" });
    expect(told.estimable).toBe(true);
    if (!told.estimable) return;
    // 0.02 per megapixel × 4.194304 MP
    expect(told.costUsd).toBeCloseTo(0.08388608, 6);
  });

  test("a nonsense count cannot produce a negative or NaN quote", () => {
    const q = quoteImage(parseImagePricing(recraftEndpoints), { count: 0 });
    expect(q.estimable).toBe(true);
    if (!q.estimable) return;
    expect(q.costUsd).toBe(0.035);
  });
});

describe("imagePricingFor", () => {
  test("a failing lookup returns no-pricing rather than throwing", async () => {
    clearImagePricingCache();
    // Image quoting is a convenience. A timeout on one optional price lookup must
    // not take the whole quote request down for a number the UI can show as
    // "unknown".
    const p = await imagePricingFor("some/model", {
      fetchImpl: async () => {
        throw new Error("network down");
      },
    });
    expect(p.hasPricing).toBe(false);
    expect(p.outputRules).toHaveLength(0);
  });

  test("parses a real payload and caches the result", async () => {
    clearImagePricingCache();
    let calls = 0;

    const p = await imagePricingFor("recraft/recraft-v4.1", {
      fetchImpl: async () => {
        calls += 1;
        return new Response(
          JSON.stringify({ id: "recraft/recraft-v4.1", endpoints: recraftEndpoints }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    expect(p.outputRules[0]?.costUsd).toBe(0.035);

    // Second call served from the per-process cache, so a Studio that re-quotes on
    // every keystroke does not hammer a second upstream call per model.
    await imagePricingFor("recraft/recraft-v4.1", {
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", { status: 200 });
      },
    });
    expect(calls).toBe(1);

    clearImagePricingCache();
  });
});
