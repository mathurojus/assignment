import { openrouterFetch, type FetchLike } from "./client";
import { parseModelPricing, type ModelPricing } from "./pricing";

/** Raw shape returned by GET /api/v1/videos/models. */
export interface RawVideoModel {
  id: string;
  canonical_slug: string | null;
  name: string;
  description: string | null;
  created: number | null;
  supported_durations: number[] | null;
  supported_resolutions: string[] | null;
  supported_aspect_ratios: string[] | null;
  supported_sizes: string[] | null;
  supported_frame_images: string[] | null;
  upscale_factor: { min: number; max: number } | null;
  creativity: number[] | null;
  /** true | false | null. null means the API does not say, so we do not show a toggle. */
  generate_audio: boolean | null;
  seed: boolean | null;
  pricing_skus: Record<string, string> | null;
  allowed_passthrough_parameters: string[] | null;
}

/** What the UI actually consumes. Raw keys never reach the client. */
export interface VideoModel {
  id: string;
  name: string;
  description: string | null;
  durations: number[];
  resolutions: string[];
  aspectRatios: string[];
  sizes: string[];
  /** Which frame slots this model accepts. */
  frameImages: string[];
  supportsAudio: boolean;
  supportsSeed: boolean;
  /** Cheapest price we could resolve, for sorting and "from $x" labels. */
  minCostUsd: number | null;
  /** True when this model needs a start frame, or is unusable for plain prompts. */
  requiresFirstFrame: boolean;
  pricing: ModelPricing;
  passthroughParameters: string[];
}

export class VideoModelsUnavailableError extends Error {
  constructor(cause?: unknown) {
    super(
      "Could not reach the OpenRouter video model list. Generation is unavailable until this succeeds.",
    );
    this.name = "VideoModelsUnavailableError";
    this.cause = cause;
  }
}

/**
 * Normalise one raw model.
 *
 * A model is excluded from the dropdown unless it can actually be driven by a
 * text prompt: it needs durations, at least one resolution, and at least one
 * aspect ratio. That is what filters out `flux-video-edit`, `heygen/avatar-iv`,
 * `flux-video-upscale` and `runway/aleph-2` -- editors, avatars and upscalers
 * that take input we cannot supply.
 */
export function normaliseVideoModel(raw: RawVideoModel): VideoModel | null {
  const durations = raw.supported_durations ?? [];
  const resolutions = raw.supported_resolutions ?? [];
  const aspectRatios = raw.supported_aspect_ratios ?? [];

  if (durations.length === 0 || resolutions.length === 0 || aspectRatios.length === 0) {
    return null;
  }

  const pricing = parseModelPricing(raw.pricing_skus);

  // Cheapest resolvable per-second rate, for a "from $x" label. Per-token models
  // have no honest number here, so they get null rather than a fiction.
  let minCostUsd: number | null = null;
  const perSecond = pricing.rules.filter(
    (r) => (r.unit === "usd_per_second" || r.unit === "cents_per_second") && r.resolution === undefined,
  );
  if (perSecond.length > 0) {
    const cheapest = Math.min(...perSecond.map((r) => r.usdPerUnit));
    minCostUsd = Math.round(cheapest * durations[0] * 10_000) / 10_000;
  }

  const frameImages = raw.supported_frame_images ?? [];

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    durations: [...durations].sort((a, b) => a - b),
    resolutions: [...resolutions],
    aspectRatios: [...aspectRatios],
    sizes: raw.supported_sizes ?? [],
    frameImages,
    supportsAudio: raw.generate_audio === true,
    supportsSeed: raw.seed === true,
    minCostUsd,
    requiresFirstFrame: frameImages.length > 0 && raw.id !== "",
    pricing,
    passthroughParameters: raw.allowed_passthrough_parameters ?? [],
  };
}

interface Cached {
  at: number;
  models: VideoModel[];
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const globalCache = globalThis as unknown as { __vantageVideoModels?: Cached };

/**
 * Fetch and normalise the model list, cached for 10 minutes.
 *
 * The endpoint needs no API key (verified), so the dropdown is populated even
 * when generation is not yet configured. That is what lets the UI show real
 * capabilities before the user has pasted anything.
 */
export async function listVideoModels(opts: { fetchImpl?: FetchLike } = {}): Promise<VideoModel[]> {
  const now = Date.now();
  const cached = globalCache.__vantageVideoModels;
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.models;

  let payload: { data?: RawVideoModel[] };
  try {
    payload = await openrouterFetch<{ data?: RawVideoModel[] }>("/videos/models", {
      timeoutMs: 20_000,
      attempts: 2,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  } catch (e) {
    // A stale cache beats no dropdown at all.
    if (cached) return cached.models;
    throw new VideoModelsUnavailableError(e);
  }

  const models = (payload.data ?? [])
    .map(normaliseVideoModel)
    .filter((m): m is VideoModel => m !== null)
    .sort((a, b) => {
      // Cheapest first, but put unpriced models last rather than first.
      if (a.minCostUsd === null && b.minCostUsd === null) return a.name.localeCompare(b.name);
      if (a.minCostUsd === null) return 1;
      if (b.minCostUsd === null) return -1;
      return a.minCostUsd - b.minCostUsd;
    });

  globalCache.__vantageVideoModels = { at: now, models };
  return models;
}

export function clearVideoModelCache(): void {
  delete globalCache.__vantageVideoModels;
}

// ---------------------------------------------------------------------------
// Image models
// ---------------------------------------------------------------------------

export interface RawImageModel {
  id: string;
  name: string;
  description: string | null;
  architecture: { input_modalities: string[]; output_modalities: string[] };
  supported_parameters: Record<string, { type: string; values?: string[]; min?: number; max?: number }> | null;
  supports_streaming: boolean;
  endpoints: string;
}

export interface ImageModel {
  id: string;
  name: string;
  description: string | null;
  resolutions: string[];
  aspectRatios: string[];
  maxImages: number;
  acceptsReferences: boolean;
  supportsQuality: boolean;
  qualities: string[];
  supportsOutputFormat: boolean;
}

export function normaliseImageModel(raw: RawImageModel): ImageModel | null {
  const params = raw.supported_parameters ?? {};
  // Only text-to-image. A model that cannot emit an image is not a candidate
  // for generating a start frame.
  if (!raw.architecture?.output_modalities?.includes("image")) return null;

  const res = params["resolution"];
  const ar = params["aspect_ratio"];
  const n = params["n"];

  return {
    id: raw.id,
    name: raw.name,
    description: raw.description,
    resolutions: res?.values ?? [],
    aspectRatios: ar?.values ?? [],
    maxImages: Math.min(n?.max ?? 1, 10),
    acceptsReferences: Boolean(params["input_references"]),
    supportsQuality: Boolean(params["quality"]),
    qualities: params["quality"]?.values ?? ["auto", "low", "medium", "high"],
    supportsOutputFormat: Boolean(params["output_format"]),
  };
}

export async function listImageModels(opts: { fetchImpl?: FetchLike } = {}): Promise<ImageModel[]> {
  const payload = await openrouterFetch<{ data?: RawImageModel[] }>("/images/models", {
    timeoutMs: 20_000,
    attempts: 2,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return (payload.data ?? [])
    .map(normaliseImageModel)
    .filter((m): m is ImageModel => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}