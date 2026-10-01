"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { Preset } from "@/lib/presets";
import type { VideoModel } from "@/lib/openrouter/models";
import type { ImageModel } from "@/lib/openrouter/models";
import { useJob, type JobView } from "@/components/studio/use-job";
import { JobStage } from "@/components/studio/job-stage";
import { CostCard } from "@/components/studio/cost-card";
import { usdFromFloat } from "@/lib/format";

export interface StudioProps {
  videoModels: VideoModel[];
  imageModels: ImageModel[];
  presets: Preset[];
  presetCategories: string[];
  modelsError: string | null;
  capabilities: {
    canGenerate: boolean;
    imageToVideo: boolean;
    enhancer: boolean;
    blockedReason: string | null;
  };
  limits: { jobsPerHour: number; concurrent: number };
  reserveCeilingUsd: number;
}

/**
 * The generate studio.
 *
 * One client component rather than a server page plus several small client ones.
 * The controls and the price are not independent: changing duration re-quotes,
 * changing model resets duration to something valid, and attaching a frame
 * changes the price. Splitting them would mean lifting all of that into state
 * anyway and passing it down, which is more code and less clarity than one
 * component with one `useState` per field.
 *
 * The one thing that *is* extracted is `useJob`, because its two polling loops are
 * long enough on their own to bury the form.
 */
export function Studio({
  videoModels,
  imageModels,
  presets,
  presetCategories,
  modelsError,
  capabilities,
  limits,
  reserveCeilingUsd,
}: StudioProps) {
  const router = useRouter();
  const params = useSearchParams();

  // ---- form state ---------------------------------------------------------
  //
  // `videoModels` arrives as a prop from a server component, so the list is
  // already populated on the first render and a default model can be chosen in a
  // state initialiser rather than in an effect that would run after a wasted
  // paint.
  //
  // The parameter states below hold the user's *intent*, not the value that will
  // be sent. Choosing a 5-second-only model must not leave `duration` at 10, but
  // it also should not require an effect to fix it up: the effective values are
  // derived at the bottom of this component, so an intent the current model
  // cannot satisfy simply resolves to the model's default. That is one source of
  // truth instead of two plus a synchroniser.
  const [kind, setKind] = useState<"video" | "image">(
    () => (params.get("type") === "image" ? "image" : "video"),
  );
  const [modelId, setModelId] = useState<string>(() => {
    const fromUrl = params.get("model");
    if (fromUrl) return fromUrl;
    const wantsImage = params.get("type") === "image";
    return wantsImage ? defaultImageModelId(imageModels) : defaultVideoModelId(videoModels);
  });
  const [prompt, setPrompt] = useState<string>(params.get("prompt") ?? "");
  const [enhanced, setEnhanced] = useState<string | null>(null);
  const [presetSlug, setPresetSlug] = useState<string | null>(null);
  const [wantDuration, setWantDuration] = useState<number | null>(null);
  const [wantResolution, setWantResolution] = useState<string | null>(null);
  const [wantAspectRatio, setWantAspectRatio] = useState<string | null>(null);
  const [wantAudio, setWantAudio] = useState<boolean | null>(null);
  const [wantCount, setWantCount] = useState<number | null>(null);
  const [wantQuality, setWantQuality] = useState<string | null>(null);
  const [seed, setSeed] = useState<number | null>(null);
  const [startFrame, setStartFrame] = useState<string | null>(null);
  const [isPublic, setIsPublic] = useState(false);

  // ---- request state ------------------------------------------------------
  const [enhancing, setEnhancing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // ---- quote --------------------------------------------------------------
  const [quote, setQuote] = useState<Quote | null>(null);
  // Which control values `quote` was computed for. See `quoteKey` below.
  const [quoteFor, setQuoteFor] = useState<string | null>(null);

  const videoModel = useMemo(
    () => videoModels.find((m) => m.id === modelId) ?? null,
    [videoModels, modelId],
  );

  const imageModel = useMemo(
    () => imageModels.find((m) => m.id === modelId) ?? null,
    [imageModels, modelId],
  );

  // The currently selected model, whatever kind it is. Switching kind switches
  // the list, and an id from the other list simply does not resolve -- which is
  // why `kind` is part of the quote key and the model dropdown's own options.
  const model = kind === "video" ? videoModel : imageModel;

  // The effective parameter set, derived from the model.
  //
  // Each one falls back to the model's own first supported value when the user's
  // intent is not available. The alternative -- an effect that rewrites the state
  // when the model changes -- creates a render where the state and the model
  // disagree, and can put a request in flight with a duration the model rejects.
  const duration =
    videoModel && wantDuration !== null && videoModel.durations.includes(wantDuration)
      ? wantDuration
      : (videoModel?.durations[0] ?? null);

  const resolution =
    model && wantResolution && model.resolutions.includes(wantResolution)
      ? wantResolution
      : (model?.resolutions[0] ?? null);

  const aspectRatio =
    model && wantAspectRatio && model.aspectRatios.includes(wantAspectRatio)
      ? wantAspectRatio
      : (model?.aspectRatios[0] ?? null);

  const audio = wantAudio ?? videoModel?.supportsAudio ?? false;

  // How many images, clamped to the model's own maximum. Same reasoning as the
  // server-side clamp: the model is the authority on its limit, and showing the
  // number that will actually be used is more useful than rejecting the form.
  const maxImages = imageModel?.maxImages ?? 1;
  const count = Math.max(1, Math.min(wantCount ?? 1, maxImages));

  // An attached frame is meaningless to a model that accepts no inputs, so it is
  // dropped rather than silently ignored. Silently ignoring it would generate
  // something other than what the screen shows.
  const acceptsInput = kind === "video"
    ? (videoModel?.frameImages.length ?? 0) > 0
    : (imageModel?.acceptsReferences ?? false);
  const effectiveFrame = acceptsInput ? startFrame : null;

  const preset = useMemo(
    () => presets.find((p) => p.slug === presetSlug) ?? null,
    [presets, presetSlug],
  );

  // ---- the job ------------------------------------------------------------
  const jobId = params.get("job");
  const { job, error: jobError, loading: jobLoading, elapsed } = useJob(jobId);

  // ---- quoting ------------------------------------------------------------
  // The inputs the price depends on, as one comparable value.
  //
  // A signature rather than a list of dependencies because "is the quote I am
  // showing still the quote for the controls the user is looking at?" is a
  // question about *values*, not about identity. Storing the signature alongside
  // the quote lets the answer be derived during render, so a price is never
  // displayed without either being current or being visibly marked as pending.
  const quoteKey = model
    ? [
        kind,
        model.id,
        duration,
        resolution,
        aspectRatio,
        audio,
        count,
        wantQuality,
        effectiveFrame ? 1 : 0,
      ].join("|")
    : null;

  // Debounced. `quoteToken` discards responses that arrive after the controls
  // moved on -- without it, dragging the duration slider settles on whichever
  // reply happens to land last rather than on the last reply requested.
  //
  // The prompt is deliberately not an input: re-quoting per keystroke would be a
  // request per character, and the prompt cannot change the price.
  const quoteToken = useRef(0);
  useEffect(() => {
    if (quoteKey === null) return;
    const token = ++quoteToken.current;

    const timer = setTimeout(async () => {
      // Video and image quotes take different bodies; `kind` is what picks, and
      // it is part of `quoteKey`, so this always matches the model shown above.
      const body = JSON.stringify(
        kind === "image"
          ? {
              type: "image",
              model: model!.id,
              count,
              resolution: resolution ?? undefined,
              aspectRatio: aspectRatio ?? undefined,
              quality: wantQuality ?? undefined,
              referenceCount: effectiveFrame ? 1 : 0,
            }
          : {
              type: "video",
              model: model!.id,
              durationSeconds: duration,
              resolution: resolution ?? undefined,
              aspectRatio: aspectRatio ?? undefined,
              generateAudio: audio ?? undefined,
              hasFirstFrame: effectiveFrame !== null,
            },
      );

      try {
        const res = await fetch("/api/quote", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
        });
        if (token !== quoteToken.current) return;
        if (!res.ok) {
          setQuote(null);
          setQuoteFor(quoteKey);
          return;
        }
        setQuote((await res.json()) as Quote);
        setQuoteFor(quoteKey);
      } catch {
        if (token !== quoteToken.current) return;
        // A failed quote clears the number rather than leaving the previous one
        // standing. A stale price next to changed controls is worse than no price:
        // it looks authoritative and it is wrong.
        setQuote(null);
        setQuoteFor(quoteKey);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [
    quoteKey,
    kind,
    model,
    duration,
    resolution,
    aspectRatio,
    audio,
    count,
    wantQuality,
    effectiveFrame,
  ]);

  // Derived, so it cannot disagree with the quote it describes.
  const quoting = quoteKey !== null && quoteFor !== quoteKey;

  // ---- actions ------------------------------------------------------------

  const enhance = useCallback(async () => {
    if (prompt.trim().length < 3 || enhancing) return;
    setEnhancing(true);
    setFormError(null);
    try {
      const res = await fetch("/api/enhance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          model: modelId || undefined,
          presetSlug: presetSlug ?? undefined,
          durationSeconds: duration ?? undefined,
          aspectRatio: aspectRatio ?? undefined,
        }),
      });
      const body = (await res.json()) as {
        enhanced?: string;
        fallback?: boolean;
        message?: string;
        error?: { message?: string };
      };
      if (!res.ok) {
        setFormError(body.error?.message ?? "Could not enhance the prompt.");
        return;
      }
      setEnhanced(body.enhanced ?? null);
      if (body.fallback) {
        setNotice(body.message ?? "Enhancement was unavailable; your prompt was used as written.");
      } else {
        setNotice(null);
      }
    } catch {
      setFormError("Could not reach the server to enhance the prompt.");
    } finally {
      setEnhancing(false);
    }
  }, [prompt, enhancing, modelId, presetSlug, duration, aspectRatio]);

  const submit = useCallback(async () => {
    if (submitting) return;
    setFormError(null);
    setNotice(null);

    if (!prompt.trim()) {
      setFormError("Write a prompt first.");
      return;
    }
    if (!model) {
      setFormError("Choose a model.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(
          kind === "image"
            ? {
                type: "image",
                model: model.id,
                prompt: prompt.trim(),
                enhancedPrompt: enhanced?.trim() || undefined,
                presetSlug: presetSlug ?? undefined,
                count,
                resolution: resolution ?? undefined,
                aspectRatio: aspectRatio ?? undefined,
                quality: wantQuality ?? undefined,
                seed: seed ?? undefined,
                isPublic,
                sourceImageDataUrl: effectiveFrame ?? undefined,
              }
            : {
                type: "video",
                model: model.id,
                prompt: prompt.trim(),
                enhancedPrompt: enhanced?.trim() || undefined,
                presetSlug: presetSlug ?? undefined,
                durationSeconds: duration ?? undefined,
                resolution: resolution ?? undefined,
                aspectRatio: aspectRatio ?? undefined,
                generateAudio: audio ?? undefined,
                seed: seed ?? undefined,
                isPublic,
                sourceImageDataUrl: effectiveFrame ?? undefined,
              },
        ),
      });

      const body = (await res.json()) as {
        id?: string;
        notice?: string | null;
        error?: { code?: string; message?: string };
      };

      if (!res.ok || !body.id) {
        setFormError(body.error?.message ?? `The server returned HTTP ${res.status}.`);
        return;
      }

      // Put the job in the URL. That is what makes a reload resume it, a shared
      // link work, and the polling effect start.
      router.push(`/generate?job=${body.id}`);
      setNotice(body.notice ?? null);
    } catch {
      setFormError("Could not reach the server. Nothing was charged — try again.");
    } finally {
      setSubmitting(false);
    }
  }, [
    submitting,
    kind,
    prompt,
    model,
    enhanced,
    presetSlug,
    duration,
    resolution,
    aspectRatio,
    audio,
    count,
    wantQuality,
    seed,
    isPublic,
    effectiveFrame,
    router,
  ]);

  const onFrame = useCallback((dataUrl: string | null) => setStartFrame(dataUrl), []);

  const presetGrouped = useMemo(() => {
    const map = new Map<string, Preset[]>();
    for (const category of presetCategories) map.set(category, []);
    for (const p of presets) {
      if (!map.has(p.category)) map.set(p.category, []);
      map.get(p.category)!.push(p);
    }
    return [...map.entries()].filter(([, items]) => items.length > 0);
  }, [presets, presetCategories]);

  // Video slots are `first_frame` / `last_frame`; image models have one generic
  // input, so the slot list is a single unnamed one rather than an empty array,
  // which would hide the picker entirely.
  const frameSlots: string[] =
    kind === "video" ? (videoModel?.frameImages ?? []) : effectiveFrame || startFrame ? ["reference"] : [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-start">
        {/* ------------------------------------------------ left: the form */}
        <div className="space-y-5">
          {modelsError ? (
            <Banner tone="bad">{modelsError}</Banner>
          ) : null}

          {capabilities.blockedReason ? <Banner tone="warn">{capabilities.blockedReason}</Banner> : null}

          <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--color-line)] px-3 py-2">
              <div className="flex gap-1" role="radiogroup" aria-label="What to generate">
                {(["video", "image"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    role="radio"
                    aria-checked={kind === k}
                    onClick={() => {
                      if (kind === k) return;
                      // The two lists share no ids, so the current selection would
                      // resolve to nothing. Choosing a default here rather than in
                      // an effect means there is never a frame where the dropdown
                      // reads "No models loaded" because the id stopped matching.
                      setKind(k);
                      setModelId(
                        k === "video" ? defaultVideoModelId(videoModels) : defaultImageModelId(imageModels),
                      );
                      setStartFrame(null);
                    }}
                    className={`rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
                      kind === k
                        ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)]"
                        : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
                    }`}
                  >
                    {k}
                  </button>
                ))}
              </div>
              <span className="font-mono text-xs text-[var(--color-ink-faint)]">
                {kind === "video" ? `${videoModels.length} models` : `${imageModels.length} models`}
              </span>
            </div>

            <div className="border-b border-[var(--color-line)] p-5">
              <label htmlFor="model" className="block text-sm font-medium">
                Model
              </label>
              <select
                id="model"
                value={modelId}
                onChange={(e) => setModelId(e.target.value)}
                className="mt-2 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-line-strong)]"
              >
                {(kind === "video" ? videoModels : imageModels).length === 0 ? (
                  <option value="">No models loaded</option>
                ) : null}
                {kind === "video"
                  ? videoModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.minCostUsd != null ? ` — from ${usdFromFloat(m.minCostUsd)}` : " — price on request"}
                        {m.requiresFirstFrame ? " (needs a start frame)" : ""}
                      </option>
                    ))
                  : imageModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                        {m.maxImages > 1 ? ` — up to ${m.maxImages} images` : ""}
                      </option>
                    ))}
              </select>
              {model?.description ? (
                <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-faint)]">
                  {model.description}
                </p>
              ) : null}
            </div>

            <div className="space-y-5 p-5">
              <div>
                <div className="flex items-baseline justify-between gap-3">
                  <label htmlFor="prompt" className="text-sm font-medium">
                    Prompt
                  </label>
                  <span className="font-mono text-xs text-[var(--color-ink-faint)]">
                    {prompt.length}/8000
                  </span>
                </div>
                <textarea
                  id="prompt"
                  value={prompt}
                  onChange={(e) => {
                    setPrompt(e.target.value);
                    // Editing the prompt invalidates an enhancement of the old
                    // text. Keeping it would silently generate the previous idea.
                    setEnhanced(null);
                  }}
                  rows={5}
                  maxLength={8000}
                  placeholder="A lone lighthouse at dusk, waves breaking against the rocks, slow push-in"
                  className="mt-2 w-full resize-y rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm leading-relaxed outline-none transition-colors placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-line-strong)]"
                />

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={enhance}
                    disabled={!capabilities.enhancer || enhancing || prompt.trim().length < 3}
                    title={
                      capabilities.enhancer
                        ? "Rewrite this into a more descriptive prompt"
                        : "Needs OPENROUTER_API_KEY"
                    }
                    className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-1.5 text-sm transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface-raised)] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {enhancing ? "Enhancing…" : "Enhance prompt"}
                  </button>
                  {enhanced ? (
                    <>
                      <span className="text-xs text-[var(--color-good)]">
                        Using enhanced prompt
                      </span>
                      <button
                        type="button"
                        onClick={() => setEnhanced(null)}
                        className="text-xs text-[var(--color-ink-faint)] underline underline-offset-2 hover:text-[var(--color-ink)]"
                      >
                        undo
                      </button>
                    </>
                  ) : null}
                </div>

                {enhanced ? (
                  <p className="mt-2 rounded-[var(--radius-control)] border border-[var(--color-good)]/25 bg-[color-mix(in_oklch,var(--color-good)_8%,transparent)] p-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                    <span className="font-medium text-[var(--color-good)]">Will send:</span>{" "}
                    {enhanced}
                  </p>
                ) : null}
              </div>

              {/* presets */}
              <div>
                <label htmlFor="preset" className="block text-sm font-medium">
                  Camera preset
                </label>
                <select
                  id="preset"
                  value={presetSlug ?? ""}
                  onChange={(e) => setPresetSlug(e.target.value || null)}
                  className="mt-2 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm outline-none transition-colors focus:border-[var(--color-line-strong)]"
                >
                  <option value="">None</option>
                  {presetGrouped.map(([category, items]) => (
                    <optgroup key={category} label={category}>
                      {items.map((p) => (
                        <option key={p.slug} value={p.slug}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {preset ? (
                  <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-[var(--color-ink-faint)]">
                    {preset.accent ? (
                      <span
                        aria-hidden
                        className="mt-0.5 size-2.5 shrink-0 rounded-full"
                        style={{ background: preset.accent }}
                      />
                    ) : null}
                    {preset.description}
                  </p>
                ) : null}
              </div>

              {/* parameters */}
              <div className="grid gap-4 sm:grid-cols-3">
                {kind === "video" ? (
                  <Choice
                    label="Duration"
                    value={duration}
                    options={videoModel?.durations ?? []}
                    format={(v) => v + "s"}
                    onChange={setWantDuration}
                  />
                ) : null}
                {kind === "image" && maxImages > 1 ? (
                  <Choice
                    label="Images"
                    value={count}
                    options={Array.from({ length: maxImages }, (_, i) => i + 1)}
                    onChange={setWantCount}
                  />
                ) : null}
                <Choice
                  label="Resolution"
                  value={resolution}
                  options={model?.resolutions ?? []}
                  onChange={setWantResolution}
                />
                <Choice
                  label="Aspect ratio"
                  value={aspectRatio}
                  options={model?.aspectRatios ?? []}
                  onChange={setWantAspectRatio}
                />
              </div>

              <div className="flex flex-wrap gap-5">
                {videoModel?.supportsAudio ? (
                  <Toggle
                    label="Generate audio"
                    checked={audio ?? true}
                    onChange={setWantAudio}
                    hint="Adds sound effects and ambience. Not all models or durations support it."
                  />
                ) : null}
                {kind === "image" && imageModel?.supportsQuality ? (
                  <Choice
                    label="Quality"
                    value={wantQuality ?? imageModel.qualities[0] ?? null}
                    options={imageModel.qualities}
                    onChange={setWantQuality}
                  />
                ) : null}
                {kind === "video" && videoModel?.supportsSeed ? (
                  <div>
                    <label htmlFor="seed" className="text-sm font-medium">
                      Seed
                    </label>
                    <input
                      id="seed"
                      type="number"
                      inputMode="numeric"
                      placeholder="random"
                      value={seed ?? ""}
                      onChange={(e) => setSeed(e.target.value === "" ? null : Number(e.target.value))}
                      className="mt-1.5 w-32 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--color-line-strong)]"
                    />
                  </div>
                ) : null}
                <Toggle
                  label="Show in Explore"
                  checked={isPublic}
                  onChange={setIsPublic}
                  hint="Makes this generation and its prompt visible to everyone."
                />
              </div>

              {/* start frame, or a reference image for image-to-image */}
              <FramePicker
                slots={frameSlots}
                label={kind === "video" ? "Start frame" : "Reference image"}
                emptyText={
                  kind === "video"
                    ? "This model is text-to-video only."
                    : "This model does not accept reference images."
                }
                disabled={!capabilities.imageToVideo}
                disabledReason={
                  capabilities.imageToVideo
                    ? undefined
                    : "OpenRouter must be able to fetch your uploaded image. Set PUBLIC_MEDIA_BASE_URL, or use the local storage driver in development."
                }
                value={effectiveFrame}
                onChange={onFrame}
              />
            </div>
          </section>
        </div>

        {/* ----------------------------------------------- right: price + job */}
        <div className="space-y-4 lg:sticky lg:top-20">
          <CostCard
            quote={quote}
            quoting={quoting}
            modelName={model?.name ?? null}
            ceilingUsd={reserveCeilingUsd}
            submitting={submitting}
            canGenerate={capabilities.canGenerate}
            promptOk={prompt.trim().length > 0}
            onSubmit={submit}
            error={formError}
          />

          {notice ? <Banner tone="info">{notice}</Banner> : null}

          {/* Rate limits belong next to the submit button: they are the other
              thing that can make a job be refused, and hiding them in a help
              page means finding out by being turned down. */}
          <p className="px-1 font-mono text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
            Up to {limits.concurrent} running at once, {limits.jobsPerHour} per hour.
          </p>

          <JobStage
            job={job}
            loading={jobLoading}
            error={jobError}
            elapsedMs={elapsed}
            blockedReason={capabilities.blockedReason}
          />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ pieces */

/**
 * Pick a sensible default video model.
 *
 * Runs once, in a state initialiser, because the server has already loaded the
 * list by the time this renders. It prefers a cheap model that supports 5s and
 * needs no start frame, because that combination is one most people can actually
 * run on their first attempt.
 */
function defaultVideoModelId(models: VideoModel[]): string {
  const preferred =
    models.find((m) => m.id === "google/veo-3") ??
    models.find((m) => !m.requiresFirstFrame && m.durations.includes(5)) ??
    models.find((m) => !m.requiresFirstFrame);
  return preferred?.id ?? models[0]?.id ?? "";
}

/**
 * Pick a sensible default image model.
 *
 * Cheapest-looking heuristics are useless here: the image model list carries no
 * prices at all (they need a second per-model call), so there is nothing to sort
 * by. What it does carry is `maxImages`, and a model that can produce several
 * images is the one that shows the app's most distinctive capability, so that
 * wins over the first entry.
 */
function defaultImageModelId(models: ImageModel[]): string {
  const preferred =
    models.find((m) => m.maxImages > 1 && m.acceptsReferences) ??
    models.find((m) => m.maxImages > 1) ??
    models[0];
  return preferred?.id ?? "";
}

interface Quote {
  estimable: boolean;
  costUsd: number | null;
  credits: number | null;
  basis: string;
  reason?: string;
  reservedUsd?: number;
}

function Banner({ tone, children }: { tone: "bad" | "warn" | "info"; children: React.ReactNode }) {
  const styles = {
    bad: "border-[var(--color-bad)]/40 bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] text-[var(--color-bad)]",
    warn: "border-[var(--color-warn)]/40 bg-[color-mix(in_oklch,var(--color-warn)_12%,transparent)] text-[var(--color-warn)]",
    info: "border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-ink-muted)]",
  } as const;

  return (
    <div role="status" className={`rounded-[var(--radius-control)] border px-4 py-3 text-sm ${styles[tone]}`}>
      {children}
    </div>
  );
}

function Choice({
  label,
  value,
  options,
  onChange,
  format = (v: string | number) => String(v),
}: {
  label: string;
  value: string | number | null;
  options: Array<string | number>;
  onChange: (value: never) => void;
  format?: (v: string | number) => string;
}) {
  // Default formatter accepts either. Declaring the parameter as `string` here
  // would make the prop type wider than the local function, which is exactly the
  // variance error this avoids by widening both.
  // Hide the control entirely when a model has nothing to choose. A disabled
  // single-option dropdown is noise; its absence says the same thing.
  if (options.length === 0) return null;

  if (options.length === 1) {
    return (
      <div>
        <span className="block text-sm font-medium">{label}</span>
        <p className="mt-1.5 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-3 py-2 text-sm text-[var(--color-ink-faint)]">
          {format(options[0])} <span className="text-xs">(only option)</span>
        </p>
      </div>
    );
  }

  const id = `choice-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      <select
        id={id}
        value={value === null ? "" : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          const asNumber = Number(raw);
          onChange(
            (typeof value === "number" || !Number.isNaN(asNumber) ? asNumber : raw) as never,
          );
        }}
        className="mt-1.5 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm outline-none focus:border-[var(--color-line-strong)]"
      >
        {options.map((o) => (
          <option key={String(o)} value={String(o)}>
            {format(o)}
          </option>
        ))}
      </select>
    </div>
  );
}

function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  hint?: string;
}) {
  const id = `toggle-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          id={id}
          role="switch"
          aria-checked={checked}
          onClick={() => onChange(!checked)}
          className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
            checked ? "bg-[var(--color-accent)]" : "bg-[var(--color-surface-raised)]"
          }`}
        >
          <span
            aria-hidden
            className={`absolute top-1 size-4 rounded-full bg-white transition-transform ${
              checked ? "translate-x-6" : "translate-x-1"
            }`}
          />
        </button>
        <label htmlFor={id} className="cursor-pointer text-sm font-medium">
          {label}
        </label>
      </div>
      {hint ? (
        <p className="mt-1 max-w-xs text-xs leading-relaxed text-[var(--color-ink-faint)]">{hint}</p>
      ) : null}
    </div>
  );
}

/**
 * Attach a start frame.
 *
 * Read to a data URL in the browser and sent as one, rather than uploaded first.
 * The frame is a few hundred kilobytes at most after the browser's own rescale,
 * and a two-step upload would need a second endpoint, a second round trip and a
 * second place for the URL to be wrong. The server re-validates the bytes either
 * way -- the size cap and the content-type allowlist are applied there, not here,
 * because a client check is advice rather than a control.
 */
function FramePicker({
  slots,
  value,
  onChange,
  disabled,
  disabledReason,
  label = "Start frame",
  emptyText = "This model is text-to-video only.",
}: {
  slots: string[];
  value: string | null;
  onChange: (v: string | null) => void;
  disabled: boolean;
  disabledReason?: string;
  label?: string;
  emptyText?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  if (slots.length === 0) {
    return (
      <p className="text-xs text-[var(--color-ink-faint)]">
        {emptyText}
      </p>
    );
  }

  if (disabled) {
    return (
      <Banner tone="warn">
        {disabledReason ?? "Image-to-video is not available in this configuration."}
      </Banner>
    );
  }

  return (
    <div>
      <span className="block text-sm font-medium">{label}</span>
      <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
        Optional. Sent as {slots.join(", ").replace(/_/g, " ")}.
      </p>

      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-2 text-sm transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface-raised)]"
        >
          {value ? "Replace" : "Choose image"}
        </button>

        {value ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={value}
              alt="Your uploaded image"
              className="size-14 rounded-lg border border-[var(--color-line)] object-cover"
            />
            <button
              type="button"
              onClick={() => onChange(null)}
              className="text-xs text-[var(--color-ink-faint)] underline underline-offset-2 hover:text-[var(--color-ink)]"
            >
              remove
            </button>
          </>
        ) : null}
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (!file) return;

          if (file.size > 12 * 1024 * 1024) {
            onChange(null);
            return;
          }

          const reader = new FileReader();
          reader.onload = () => onChange(typeof reader.result === "string" ? reader.result : null);
          reader.readAsDataURL(file);
        }}
      />
    </div>
  );
}

export type { JobView };