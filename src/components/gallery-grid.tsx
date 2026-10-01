import { formatDate, formatUsd } from "@/lib/format";

/**
 * One gallery tile.
 *
 * A server component rather than a client one: the tile is static once rendered,
 * and the only thing it does is link to the detail page. Making it a client
 * component would ship the whole grid's worth of prompts and image URLs as a
 * hydrated prop tree for no interactive behaviour at all.
 */
export interface GalleryItem {
  id: string;
  type: "video" | "image";
  status: string;
  terminal: boolean;
  model: string;
  prompt: string;
  preset: string | null;
  isPublic: boolean;
  outputKey: string | null;
  outputUrl: string | null;
  outputCount: number;
  mimeType: string | null;
  error: string | null;
  costUsd: number | null;
  createdAt: string;
  completedAt: string | null;
  /** Set only by the public feed. */
  authorName?: string | null;
}

export function GalleryGrid({
  items,
  showAuthor,
  empty,
}: {
  items: GalleryItem[];
  /** Explore labels each tile with its author, because they are not all yours. */
  showAuthor?: boolean;
  empty?: React.ReactNode;
}) {
  if (items.length === 0) {
    return <>{empty ?? <p className="text-sm text-[var(--color-ink-faint)]">Nothing here yet.</p>}</>;
  }

  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <li key={item.id}>
          <a
            href={`/g/${item.id}`}
            className="group block overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] transition-colors hover:border-[var(--color-line-strong)]"
          >
            <Tile item={item} />
            <div className="p-3">
              <p className="line-clamp-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                {item.prompt}
              </p>
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 font-mono text-[11px] text-[var(--color-ink-faint)]">
                <span>{item.model}</span>
                {item.costUsd !== null ? <span>· {formatUsd(item.costUsd)}</span> : null}
                <span>· {formatDate(item.createdAt)}</span>
              </p>
              {showAuthor && item.authorName ? (
                <p className="mt-1 truncate text-[11px] text-[var(--color-ink-faint)]">
                  {item.authorName}
                </p>
              ) : null}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}

/**
 * The visual half of a tile.
 *
 * Deliberately plain `<img>` / `<video>` rather than `next/image`: a generation's
 * output is served from this app's own `/api/media` route with an ownership check,
 * not from a CDN, so there is no optimisation to delegate and `next/image` would
 * add a round trip through the optimiser for no benefit. Supabase Storage does
 * serve images through its own CDN, and that case is handled by `sizes` being
 * unset -- see the note in `src/lib/storage.ts`.
 *
 * A job with no output yet renders a placeholder rather than collapsing: a grid of
 * tiles at different heights while six jobs are running looks broken, and a running
 * job is a normal state to be in.
 */
function Tile({ item }: { item: GalleryItem }) {
  const ready = item.terminal && item.status === "completed" && item.outputUrl;

  if (!ready) {
    return (
      <div className="grid aspect-video place-items-center bg-[var(--color-surface-sunken)] p-3 text-center">
        <div>
          <p
            className={`font-mono text-xs ${
              item.status === "failed" || item.status === "cancelled"
                ? "text-[var(--color-bad)]"
                : "text-[var(--color-ink-faint)]"
            }`}
          >
            {item.terminal ? item.status : item.status}
          </p>
          {item.error ? (
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              {item.error}
            </p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="relative aspect-video overflow-hidden bg-[var(--color-surface-sunken)]">
      {item.type === "video" ? (
        <video
          src={item.outputUrl ?? undefined}
          muted
          loop
          playsInline
          preload="none"
          className="size-full object-cover"
        />
      ) : (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={item.outputUrl ?? undefined}
          alt={item.prompt.slice(0, 120)}
          loading="lazy"
          className="size-full object-cover"
        />
      )}

      {/* A count badge for a multi-image job. The tile shows the first image; the
          detail page shows them all. Without this, four generated images look
          like one, and the cost line would not match the visible output. */}
      {item.outputCount > 1 ? (
        <span className="absolute right-2 top-2 rounded-full bg-black/70 px-2 py-0.5 font-mono text-[11px] text-white backdrop-blur">
          {item.outputCount}
        </span>
      ) : null}

      {!item.isPublic ? (
        <span
          className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[11px] text-white/80 backdrop-blur"
          title="Not shown in Explore"
        >
          private
        </span>
      ) : null}
    </div>
  );
}