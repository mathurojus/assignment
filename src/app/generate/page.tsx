import { Suspense } from "react";
import { Studio } from "@/components/studio";
import { listVideoModels, listImageModels } from "@/lib/openrouter/models";
import { hasOpenRouterKey, hasDatabase, features, env } from "@/lib/env";
import { presets, presetCategories } from "@/lib/presets";

export const metadata = {
  title: "Generate",
  description: "Generate video or images with live cost quoting before you commit credits.",
};

export const dynamic = "force-dynamic";

/**
 * `/generate`
 *
 * The model list is loaded on the server, not the client. Two reasons, both about
 * honesty rather than speed:
 *
 *  1. The raw `pricing_skus` map is the cost engine's internal shape. Handing it
 *     to the browser would put a second, client-side implementation of pricing
 *     next to the real one, and the two would drift.
 *  2. The list changes upstream without notice. Loading it per render means the
 *     dropdown cannot offer a model that was removed yesterday.
 *
 * The page still renders with no API key, because `listVideoModels` needs no key.
 * What the key gates is generation, and the client is told that explicitly rather
 * than discovering it by failing.
 */
export default async function GeneratePage() {
  let video: Awaited<ReturnType<typeof listVideoModels>> = [];
  let images: Awaited<ReturnType<typeof listImageModels>> = [];
  let modelsError: string | null = null;

  try {
    // Both in parallel: two sequential round trips to the same host is a
    // doubling of the slowest part of the page.
    [video, images] = await Promise.all([listVideoModels(), listImageModels()]);
  } catch (error) {
    modelsError =
      error instanceof Error
        ? error.message
        : "Could not load the model list from OpenRouter.";
  }

  return (
    <Suspense fallback={<StudioSkeleton />}>
      <Studio
        videoModels={video}
        imageModels={images}
        presets={presets}
        presetCategories={presetCategories()}
        modelsError={modelsError}
        capabilities={{
          canGenerate: hasOpenRouterKey && hasDatabase,
          imageToVideo: features.imageToVideo,
          enhancer: hasOpenRouterKey,
          blockedReason: !hasOpenRouterKey
            ? "Add OPENROUTER_API_KEY to .env.local and restart the dev server."
            : !hasDatabase
              ? "The local database is initializing. Restart the dev server."
              : null,
        }}
        limits={{
          jobsPerHour: env.RATE_LIMIT_JOBS_PER_HOUR,
          concurrent: env.MAX_CONCURRENT_JOBS_PER_USER,
        }}
        reserveCeilingUsd={env.CREDIT_RESERVE_CEILING_USD}
      />
    </Suspense>
  );
}

function StudioSkeleton() {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6" aria-busy="true">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-4">
          <div className="h-28 animate-pulse rounded-xl bg-[var(--color-surface)]" />
          <div className="h-40 animate-pulse rounded-xl bg-[var(--color-surface)]" />
          <div className="h-12 animate-pulse rounded-xl bg-[var(--color-surface)]" />
        </div>
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-xl bg-[var(--color-surface)]" />
          <div className="h-32 animate-pulse rounded-xl bg-[var(--color-surface)]" />
        </div>
      </div>
    </div>
  );
}
