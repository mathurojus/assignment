import { describe, expect, it } from "vitest";
import {
  parseModelPricing,
  quote,
  toMicro,
  fromMicro,
  usdToCreditsMicro,
} from "@/lib/openrouter/pricing";

/**
 * Fixtures below are copied verbatim from a live `GET /api/v1/videos/models`
 * response fetched during development. They are the reason this suite is
 * meaningful: the published docs show a *different* `pricing_skus` shape
 * (`per-video-second`, `per-video-second-1080p`) that the live API does not
 * return, so a test written from the docs would have passed while the app
 * priced everything at null.
 */

describe("parseModelPricing", () => {
  it("parses mode-prefixed USD per second", () => {
    // alibaba/wan-3.0, verbatim
    const p = parseModelPricing({
      "text_to_video_duration_seconds_480p": "0.04",
      "text_to_video_duration_seconds_720p": "0.08",
      "image_to_video_duration_seconds_720p": "0.10",
      "text_to_video_duration_seconds_1080p": "0.12",
      "image_to_video_duration_seconds_1080p": "0.15",
    });

    const r720t2v = p.rules.find((r) => r.key === "text_to_video_duration_seconds_720p")!;
    expect(r720t2v.unit).toBe("usd_per_second");
    expect(r720t2v.mode).toBe("text_to_video");
    expect(r720t2v.resolution).toBe("720p");
    expect(r720t2v.usdPerUnit).toBeCloseTo(0.08);

    const i2v = p.rules.find((r) => r.key === "image_to_video_duration_seconds_1080p")!;
    expect(i2v.mode).toBe("image_to_video");
    expect(i2v.usdPerUnit).toBeCloseTo(0.15);
  });

  it("converts cents to dollars", () => {
    // runway/gen-4.5 + runway/aleph-2, verbatim
    const p = parseModelPricing({
      cents_per_second_output: "12",
      minimum_cents_per_generation: "56",
    });

    expect(p.rules[0].unit).toBe("cents_per_second");
    expect(p.rules[0].usdPerUnit).toBeCloseTo(0.12);
    // The floor is cents, and forgetting to divide by 100 is a 100x error.
    expect(p.usdMinimum).toBeCloseTo(0.56);
  });

  it("marks per-token pricing as unresolvable", () => {
    // bytedance/seedance-2.0, verbatim
    const p = parseModelPricing({
      video_tokens: "0.000007",
      video_tokens_4k: "0.000004",
      video_tokens_1080p: "0.0000077",
      video_tokens_without_audio: "0.000007",
      video_tokens_with_video_input: "0.0000043",
      video_tokens_4k_with_video_input: "0.0000024",
      video_tokens_1080p_with_video_input: "0.0000047",
    });

    expect(p.hasUnresolvableRule).toBe(true);
    // The bare `video_tokens` key has no audio suffix at all, so `audio` must be
    // undefined. An earlier implementation ran the suffix check over the whole
    // SKU map, so `video_tokens` picked up "without" from the neighbouring
    // `video_tokens_without_audio` key.
    const tokens = p.rules.find((r) => r.key === "video_tokens")!;
    expect(tokens.unit).toBe("usd_per_token");
    expect(tokens.audio).toBeUndefined();

    expect(p.rules.find((r) => r.key === "video_tokens_without_audio")!.audio).toBe("without");
    expect(p.rules.find((r) => r.key === "video_tokens_4k")!.resolution).toBe("4k");
    expect(p.rules.find((r) => r.key === "video_tokens_1080p")!.resolution).toBe("1080p");
    expect(p.rules.find((r) => r.key === "video_tokens_with_video_input")!.mode).toBe(
      "image_to_video",
    );
  });

  it("parses audio tiers", () => {
    // google/veo-3.1, verbatim
    const p = parseModelPricing({
      duration_seconds_with_audio: "0.40",
      duration_seconds_with_audio_4k: "0.60",
      duration_seconds_without_audio: "0.20",
      duration_seconds_without_audio_4k: "0.40",
    });

    const withAudio = p.rules.find((r) => r.key === "duration_seconds_with_audio")!;
    expect(withAudio.audio).toBe("with");
    const without = p.rules.find((r) => r.key === "duration_seconds_without_audio_4k")!;
    expect(without.audio).toBe("without");
    expect(without.resolution).toBe("4k");
  });

  it("parses the flat auxiliary charges", () => {
    // minimax/hailuo-3 + x-ai/grok-imagine-video, verbatim
    const p = parseModelPricing({
      duration_seconds: "0.13",
      reference_images: "0.04",
      cents_per_image_input: "0.2",
    });

    expect(p.usdPerReferenceImage).toBeCloseTo(0.04);
    expect(p.usdPerInputImage).toBeCloseTo(0.002);
    expect(p.rules[0].usdPerUnit).toBeCloseTo(0.13);
  });

  it("parses per-megapixel-second", () => {
    // black-forest-labs/flux-video-upscale, verbatim
    const p = parseModelPricing({
      cents_per_megapixel_second_precise: "7.5",
      cents_per_megapixel_second_creative: "10.5",
    });
    expect(p.rules[0].unit).toBe("cents_per_megapixel_second");
    expect(p.rules[0].usdPerUnit).toBeCloseTo(0.075);
    expect(p.hasUnresolvableRule).toBe(true);
  });

  it("does not invent a price for an unparseable key", () => {
    const p = parseModelPricing({ something_totally_new: "1.23" });
    expect(p.rules).toHaveLength(0);
  });
});

describe("quote", () => {
  const wan = parseModelPricing({
    text_to_video_duration_seconds_480p: "0.04",
    text_to_video_duration_seconds_720p: "0.08",
    image_to_video_duration_seconds_720p: "0.10",
    text_to_video_duration_seconds_1080p: "0.12",
    image_to_video_duration_seconds_1080p: "0.15",
  });

  it("uses the text-to-video rate when there is no start frame", () => {
    const q = quote(wan, { durationSeconds: 5, resolution: "720p" });
    expect(q.estimable).toBe(true);
    if (q.estimable) expect(q.costUsd).toBeCloseTo(0.4);
  });

  it("uses the image-to-video rate when a start frame is present", () => {
    const q = quote(wan, { durationSeconds: 5, resolution: "720p", hasFirstFrame: true });
    expect(q.estimable).toBe(true);
    if (q.estimable) expect(q.costUsd).toBeCloseTo(0.5);
  });

  it("never crosses the mode boundary", () => {
    // Only a 480p text rate exists. Asking for 1080p image-to-video must not
    // silently borrow the 720p image rate.
    const only480 = parseModelPricing({ text_to_video_duration_seconds_480p: "0.04" });
    const q = quote(only480, { durationSeconds: 5, resolution: "1080p", hasFirstFrame: true });
    expect(q.estimable).toBe(false);
  });

  it("refuses to guess for per-token pricing", () => {
    const seedance = parseModelPricing({
      video_tokens: "0.000007",
      video_tokens_without_audio: "0.000007",
    });
    const q = quote(seedance, { durationSeconds: 5, resolution: "1080p" });
    expect(q.estimable).toBe(false);
    if (!q.estimable) expect(q.reason).toMatch(/per video token/i);
  });

  it("applies the per-generation floor", () => {
    // runway/aleph-2: 28 cents/second with a 56 cent minimum, so a 1s job
    // costs 56 cents, not 28.
    const aleph = parseModelPricing({
      cents_per_second_output: "28",
      minimum_cents_per_generation: "56",
    });
    const q = quote(aleph, { durationSeconds: 1 });
    expect(q.estimable).toBe(true);
    if (q.estimable) expect(q.costUsd).toBeCloseTo(0.56);
  });

  it("does not apply the floor when the computed cost already exceeds it", () => {
    const aleph = parseModelPricing({
      cents_per_second_output: "28",
      minimum_cents_per_generation: "56",
    });
    const q = quote(aleph, { durationSeconds: 5 });
    if (q.estimable) expect(q.costUsd).toBeCloseTo(1.4);
  });

  it("adds the input-image charge for image-to-video", () => {
    const grok = parseModelPricing({
      cents_per_image_input: "0.2",
      cents_per_video_output_second_480p: "8",
      cents_per_video_output_second_720p: "14",
    });
    const q = quote(grok, { durationSeconds: 5, resolution: "720p", hasFirstFrame: true });
    expect(q.estimable).toBe(true);
    // 14c/s * 5s = 70c, plus 0.2c for the input image.
    if (q.estimable) expect(q.costUsd).toBeCloseTo(0.702);
  });

  it("prefers an audio tier when one exists", () => {
    const veo = parseModelPricing({
      duration_seconds_with_audio: "0.40",
      duration_seconds_without_audio: "0.20",
    });
    const withAudio = quote(veo, { durationSeconds: 4, generateAudio: true });
    const without = quote(veo, { durationSeconds: 4, generateAudio: false });
    expect(withAudio.estimable && withAudio.costUsd).toBeCloseTo(1.6);
    expect(without.estimable && without.costUsd).toBeCloseTo(0.8);
  });

  it("falls back to an untiered rate when the tier does not match", () => {
    const p = parseModelPricing({
      duration_seconds: "0.08",
      duration_seconds_480p: "0.05",
      duration_seconds_768p: "0.08",
    });
    // minimax/hailuo-3-max has exactly this shape.
    const q = quote(p, { durationSeconds: 5, resolution: "1080p" });
    expect(q.estimable).toBe(true);
    if (q.estimable) expect(q.costUsd).toBeCloseTo(0.4);
  });

  it("reports no price rather than zero when there are no rules", () => {
    const empty = parseModelPricing({});
    const q = quote(empty, { durationSeconds: 5 });
    expect(q.estimable).toBe(false);
    // The important assertion: there is no `costUsd` at all. A zero would be
    // worse than absent, because the UI would render "$0.00" and invite a job
    // that then bills real money.
    if (!q.estimable) {
      expect("costUsd" in q).toBe(false);
      expect(q.reason).toMatch(/no per-second pricing/i);
    }
  });
});

describe("unit conversion", () => {
  it("round-trips micro-USD exactly", () => {
    for (const usd of [0, 0.01, 0.13, 1.4, 12.34, 99.999]) {
      expect(fromMicro(toMicro(usd))).toBeCloseTo(usd, 6);
    }
  });

  it("converts USD to micro-credits at 1 credit = $0.01", () => {
    expect(usdToCreditsMicro(0.01)).toBe(10_000);
    expect(usdToCreditsMicro(0.4)).toBe(400_000); // 40 credits
    expect(usdToCreditsMicro(0)).toBe(0);
  });
});