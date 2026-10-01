import Link from "next/link";
import { hasDatabase } from "@/lib/env";
import { queryGallery } from "@/lib/gallery";
import { GalleryGrid, type GalleryItem } from "@/components/gallery-grid";
import { NeedsDatabase, QueryFailed } from "@/app/gallery/page";

export const metadata = {
  title: "Explore",
  description: "Public generations from everyone using this instance.",
};

export const dynamic = "force-dynamic";

/**
 * `/explore`
 *
 * The public feed. Works signed out, which is the point: it is the one page that
 * shows what the app does without asking for anything.
 *
 * Only rows with `is_public` and `status = 'completed'` are selectable here -- the
 * filter lives in the query, not in this file. Applying it after the fact would
 * mean paginating over rows that are then discarded, so a mostly-private instance
 * would show a screen of empty pages instead of an honest "nothing shared yet".
 */
export default async function ExplorePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!hasDatabase) return <NeedsDatabase />;

  const params = await searchParams;
  const raw = Array.isArray(params.cursor) ? params.cursor[0] : params.cursor;

  let result: Awaited<ReturnType<typeof queryGallery>>;
  try {
    result = await queryGallery({
      userId: null,
      scope: "public",
      status: "all",
      cursor: raw ?? null,
      limit: 32,
    });
  } catch (error) {
    return <QueryFailed error={error} />;
  }

  const items: GalleryItem[] = result.rows.map((r) => ({
    id: r.id,
    type: r.type,
    status: r.status,
    terminal: r.terminal,
    model: r.modelName ?? r.model,
    prompt: r.prompt,
    preset: r.preset,
    isPublic: r.isPublic,
    outputKey: r.outputKey,
    outputUrl: r.outputUrl,
    outputCount: r.outputCount,
    mimeType: r.mimeType,
    error: r.error,
    costUsd: r.costActualUsd ?? r.costEstimateUsd,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    authorName: r.authorName,
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Explore</h1>
        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-[var(--color-ink-faint)]">
          Completed generations that their creators chose to share. Each tile shows the
          prompt that produced it — the same prompt you can copy and re-run.
        </p>
      </header>

      <div className="mt-6">
        <GalleryGrid
          items={items}
          showAuthor
          empty={
            <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-8 text-center">
              <h2 className="font-medium">Nothing shared yet</h2>
              <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--color-ink-faint)]">
                Nothing here is public. Tick &ldquo;Show in Explore&rdquo; on a generation and
                it appears on this page.
              </p>
              <Link
                href="/generate"
                className="mt-5 inline-block rounded-[var(--radius-control)] bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)]"
              >
                Generate something
              </Link>
            </div>
          }
        />
      </div>

      {result.hasMore && result.nextCursor ? (
        <div className="mt-8 flex justify-center">
          <Link
            href={`/explore?cursor=${encodeURIComponent(result.nextCursor)}`}
            className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface)]"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}