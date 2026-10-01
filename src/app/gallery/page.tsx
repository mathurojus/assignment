import Link from "next/link";
import { redirect } from "next/navigation";
import { hasDatabase } from "@/lib/env";
import { getSessionUser } from "@/lib/supabase/server";
import { queryGallery, readBalance } from "@/lib/gallery";
import { GalleryGrid, type GalleryItem } from "@/components/gallery-grid";
import { formatCredits, formatUsd } from "@/lib/format";

export const metadata = {
  title: "Gallery",
  description: "Everything you have generated.",
};

export const dynamic = "force-dynamic";

/**
 * `/gallery`
 *
 * The signed-in user's own work, newest first, rendered on the server.
 *
 * The status filter is read from the query string rather than stored in client
 * state so a filtered view is a shareable, bookmarkable URL — and so that the
 * server sends back exactly the rows the address bar describes, with no second
 * render and no fetch that could disagree with the HTML already on screen.
 */
export default async function GalleryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;

  if (!hasDatabase) {
    return <NeedsDatabase />;
  }

  const user = await getSessionUser();
  if (!user) redirect("/login?next=%2Fgallery");

  const status = first(params.status);
  const filter: "all" | "completed" | "running" | "failed" =
    status === "completed" || status === "running" || status === "failed" ? status : "all";

  const cursor = first(params.cursor) ?? null;

  let rows: Awaited<ReturnType<typeof queryGallery>>;
  let balance: Awaited<ReturnType<typeof readBalance>>;
  try {
    // Both in parallel: independent queries, and the header needs the balance
    // before the grid can paint.
    [rows, balance] = await Promise.all([
      queryGallery({ userId: user.id, scope: "mine", status: filter, cursor, limit: 24 }),
      readBalance(user.id),
    ]);
  } catch (error) {
    return <QueryFailed error={error} />;
  }

  // The items carry more fields than the grid renders. Projecting to the grid's
  // own shape here means the tile component cannot accidentally start depending on
  // `params` or the enhanced prompt and have it ship to every reader.
  const items: GalleryItem[] = rows.rows.map((r) => ({
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
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Gallery</h1>
          <p className="mt-1 text-sm text-[var(--color-ink-faint)]">
            {formatCredits(balance.credits * 10_000)} credits ·{" "}
            {formatUsd(balance.spentTodayUsd)} spent today
          </p>
        </div>
        <Link
          href="/generate"
          className="rounded-[var(--radius-control)] bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90"
        >
          New generation
        </Link>
      </header>

      {balance.spendBlockedUntil ? (
        <p className="mt-4 rounded-[var(--radius-control)] border border-[var(--color-bad)]/40 bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] p-4 text-sm text-[var(--color-bad)]">
          New generations are blocked until {new Date(balance.spendBlockedUntil).toUTCString()}.
          This happens when a job is charged more than the ceiling it was allowed to
          hold. The generation is in your gallery below with its real cost.
        </p>
      ) : null}

      <nav aria-label="Filter" className="mt-6 flex flex-wrap gap-1">
        {(["all", "completed", "running", "failed"] as const).map((s) => (
          <Link
            key={s}
            href={s === "all" ? "/gallery" : `/gallery?status=${s}`}
            aria-current={filter === s ? "page" : undefined}
            className={`rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              filter === s
                ? "bg-[var(--color-surface)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            }`}
          >
            {s}
          </Link>
        ))}
      </nav>

      <div className="mt-6">
        <GalleryGrid
          items={items}
          empty={
            filter === "all" ? (
              <Empty first />
            ) : (
              <p className="text-sm text-[var(--color-ink-faint)]">
                Nothing here.{" "}
                <Link href="/gallery" className="underline underline-offset-2">
                  Show everything
                </Link>
                .
              </p>
            )
          }
        />
      </div>

      {rows.hasMore && rows.nextCursor ? (
        <div className="mt-8 flex justify-center">
          <Link
            href={`/gallery?status=${filter}&cursor=${encodeURIComponent(rows.nextCursor)}`}
            className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-4 py-2 text-sm font-medium transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface)]"
          >
            Load more
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function Empty({ first }: { first: boolean }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-8 text-center">
      <h2 className="font-medium">
        {first ? "Nothing generated yet" : "No generations"}
      </h2>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-[var(--color-ink-faint)]">
        {first
          ? "Everything you generate lands here with its prompt, its model, and what it actually cost."
          : "Once you generate something it appears here."}
      </p>
      <Link
        href="/generate"
        className="mt-5 inline-block rounded-[var(--radius-control)] bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)]"
      >
        Open the studio
      </Link>
    </div>
  );
}

export function NeedsDatabase() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Gallery unavailable</h1>
      <p className="mt-3 leading-relaxed text-[var(--color-ink-muted)]">
        There is no database to read from. Set{" "}
        <code className="font-mono text-sm">DATABASE_URL</code> in{" "}
        <code className="font-mono text-sm">.env.local</code>, run{" "}
        <code className="font-mono text-sm">npm run db:push</code>, then restart the dev
        server.
      </p>
      <Link href="/setup" className="mt-5 inline-block text-sm underline underline-offset-2">
        What is configured?
      </Link>
    </div>
  );
}

/**
 * The "the query failed" page.
 *
 * `unmigrated` distinguishes "Postgres is not reachable at all" from "Postgres is
 * reachable but does not have these tables", because they need opposite fixes and a
 * raw driver message says neither. It is only a hint on what to run next — the
 * underlying message is still shown, because a reader debugging a connection
 * problem needs it more than the hint does.
 */
export function QueryFailed({
  error,
  unmigrated,
}: {
  error: unknown;
  unmigrated?: boolean;
}) {
  const message = error instanceof Error ? error.message : "Unknown error";

  return (
    <div className="mx-auto max-w-2xl px-4 py-16 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-tight">Could not read from the database</h1>

      <p className="mt-3 leading-relaxed text-[var(--color-ink-muted)]">
        {unmigrated ? (
          <>
            The database is configured but Postgres cannot be reached. Check that{" "}
            <code className="font-mono text-sm">DATABASE_URL</code> is right and that the
            host is accepting connections.
          </>
        ) : (
          <>
            If this is a fresh database, the tables probably have not been created yet — run{" "}
            <code className="font-mono text-sm">npm run db:push</code> and reload.
          </>
        )}
      </p>

      <p className="mt-4 font-mono text-xs leading-relaxed text-[var(--color-bad)]">
        {message}
      </p>
    </div>
  );
}

/** Query strings can repeat a key; the first value is the one that counts. */
function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}