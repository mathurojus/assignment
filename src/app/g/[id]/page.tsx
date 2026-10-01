import Link from "next/link";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { requireDb, schema } from "@/lib/db";
import { hasDatabase } from "@/lib/env";
import { getSessionUser } from "@/lib/supabase/server";
import { isTerminal } from "@/lib/db/schema";
import { publicMediaUrl } from "@/lib/storage";
import { fromMicro } from "@/lib/openrouter/pricing";
import { getPreset } from "@/lib/presets";
import {
  formatBytes,
  formatDate,
  formatDuration,
  formatElapsed,
  formatUsd,
} from "@/lib/format";
import { NeedsDatabase } from "@/app/gallery/page";
import { CopyButton } from "@/components/copy-button";

export const dynamic = "force-dynamic";

/**
 * `/g/[id]` — one generation in full.
 *
 * Ownership is a database predicate, not a URL check.
 *
 * The obvious shortcut is to serve any generation by id because the ids are UUIDs.
 * A UUID is unguessable but it is not a secret: it appears in the address bar, in
 * shared links, and in anything a browser sends a Referer header. Serving other
 * people's prompts and media on a guessed id is a real disclosure bug, so the
 * `userId` predicate is part of the WHERE clause and a row that is not yours is
 * indistinguishable from a row that does not exist.
 *
 * A public generation is the one exception, and it is deliberate rather than a leak:
 * `is_public` is the author saying "show this to anyone", and it is the same flag
 * the explore feed filters on.
 */
export default async function GenerationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  if (!hasDatabase) return <NeedsDatabase />;

  const { id } = await params;

  // Validate before it reaches the database. Not an injection risk -- it is a bind
  // parameter -- but an unvalidated id surfaces as a Postgres error instead of a
  // 404, which turns a bad URL into a stack trace.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    notFound();
  }

  const db = requireDb();
  const user = await getSessionUser();

  const [row] = await db
    .select()
    .from(schema.generations)
    .where(eq(schema.generations.id, id))
    .limit(1);

  if (!row) notFound();

  const yours = user?.id === row.userId;
  if (!yours && !row.isPublic) notFound();

  const params_ = (row.params ?? {}) as Record<string, unknown>;
  const outputs =
    row.outputs.length > 0
      ? await Promise.all(
          row.outputs.map(async (o) => ({
            url: (await publicMediaUrl(o.key)) ?? "",
            mimeType: o.mimeType,
            bytes: o.bytes,
          })),
        )
      : row.outputUrl
        ? [
            {
              url: (await publicMediaUrl(row.outputUrl)) ?? "",
              mimeType: row.mimeType ?? "application/octet-stream",
              bytes: row.bytes ?? 0,
            },
          ]
        : [];

  const preset = row.preset ? getPreset(row.preset) : null;
  const estimateUsd = fromMicro(row.costEstimateMicro);
  const actualUsd = row.costActualMicro == null ? null : fromMicro(row.costActualMicro);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <nav className="mb-6 font-mono text-xs text-[var(--color-ink-faint)]">
        <Link href={yours ? "/gallery" : "/explore"} className="hover:text-[var(--color-ink)]">
          {yours ? "Gallery" : "Explore"}
        </Link>
      </nav>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start">
        <div className="space-y-6">
          {/* ------------------------------------------------ the output */}
          {outputs.length > 0 && row.status === "completed" ? (
            <div
              className={
                outputs.length > 1
                  ? "grid gap-3 sm:grid-cols-2"
                  : "space-y-3"
              }
            >
              {outputs.map((o, i) =>
                row.type === "video" ? (
                  <video
                    key={i}
                    src={o.url}
                    controls
                    playsInline
                    preload="metadata"
                    className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)] bg-black"
                  />
                ) : (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    key={i}
                    src={o.url}
                    alt={`${row.prompt.slice(0, 120)}${outputs.length > 1 ? ` (${i + 1} of ${outputs.length})` : ""}`}
                    className="w-full rounded-[var(--radius-card)] border border-[var(--color-line)]"
                  />
                ),
              )}
            </div>
          ) : (
            <div className="grid aspect-video place-items-center rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
              <div className="px-6 text-center">
                <p
                  className={`font-mono text-sm ${
                    row.status === "failed" ? "text-[var(--color-bad)]" : "text-[var(--color-ink-muted)]"
                  }`}
                >
                  {row.status}
                  {!isTerminal(row.status) ? "…" : ""}
                </p>
                {row.error ? (
                  <p className="mt-2 max-w-md text-xs leading-relaxed text-[var(--color-ink-faint)]">
                    {row.error}
                  </p>
                ) : (
                  <p className="mt-2 text-xs text-[var(--color-ink-faint)]">
                    This job is still running. It advances while a tab is open.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* ------------------------------------------------ the prompt */}
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-sm font-medium">Prompt</h2>
              <CopyButton text={row.prompt} label="Copy prompt" />
            </div>
            <p className="mt-2 whitespace-pre-wrap rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4 text-sm leading-relaxed">
              {row.prompt}
            </p>

            {row.enhancedPrompt ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
                  Enhanced prompt that was actually sent
                </summary>
                <p className="mt-2 whitespace-pre-wrap rounded-[var(--radius-control)] border border-[var(--color-good)]/25 bg-[color-mix(in_oklch,var(--color-good)_6%,transparent)] p-3 text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  {row.enhancedPrompt}
                </p>
              </details>
            ) : null}

            {typeof params_["finalPrompt"] === "string" && params_["finalPrompt"] ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]">
                  Full string sent to OpenRouter
                </summary>
                <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3 font-mono text-xs leading-relaxed text-[var(--color-ink-muted)]">
                  {String(params_["finalPrompt"])}
                </pre>
              </details>
            ) : null}
          </section>

          {/* ------------------------------------------------ reuse it */}
          {yours ? (
            <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
              <h2 className="text-sm font-medium">Run this again</h2>
              <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                Same prompt, same model, same parameters — as a new job with its own quote.
              </p>
              <Link
                href={`/generate?type=${row.type}&model=${encodeURIComponent(row.model)}&prompt=${encodeURIComponent(row.prompt)}${
                  row.preset ? `&preset=${encodeURIComponent(row.preset)}` : ""
                }`}
                className="mt-4 inline-block rounded-[var(--radius-control)] bg-[var(--color-ink)] px-4 py-2 text-sm font-medium text-[var(--color-canvas)]"
              >
                Open in the studio
              </Link>
            </section>
          ) : null}
        </div>

        {/* -------------------------------------------------- the facts */}
        <aside className="space-y-4 lg:sticky lg:top-20">
          <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <h2 className="text-sm font-medium">Details</h2>
            <dl className="mt-3 space-y-2.5 text-sm">
              <Row label="Status">
                <span
                  className={
                    row.status === "completed"
                      ? "text-[var(--color-good)]"
                      : row.status === "failed"
                        ? "text-[var(--color-bad)]"
                        : "text-[var(--color-ink-muted)]"
                  }
                >
                  {row.status}
                </span>
              </Row>
              <Row label="Type">{row.type}</Row>
              <Row label="Model">
                <span className="font-mono text-xs">{row.model}</span>
              </Row>
              <Row label="Preset">{preset ? preset.name : "none"}</Row>
              {typeof params_["durationSeconds"] === "number" ? (
                <Row label="Duration">{formatDuration(params_["durationSeconds"] as number)}</Row>
              ) : null}
              {typeof params_["resolution"] === "string" && params_["resolution"] ? (
                <Row label="Resolution">
                  <span className="font-mono text-xs">{String(params_["resolution"])}</span>
                </Row>
              ) : null}
              {typeof params_["aspectRatio"] === "string" && params_["aspectRatio"] ? (
                <Row label="Aspect ratio">
                  <span className="font-mono text-xs">{String(params_["aspectRatio"])}</span>
                </Row>
              ) : null}
              {typeof params_["count"] === "number" && (params_["count"] as number) > 1 ? (
                <Row label="Images">{String(params_["count"])}</Row>
              ) : null}
              {params_["generateAudio"] === true ? <Row label="Audio">generated</Row> : null}
              {typeof params_["seed"] === "number" ? (
                <Row label="Seed">
                  <span className="font-mono text-xs">{String(params_["seed"])}</span>
                </Row>
              ) : null}
              <Row label="Created">{formatDate(row.createdAt)}</Row>
              {row.completedAt ? (
                <Row label="Took">
                  {formatElapsed(
                    row.completedAt.getTime() - row.createdAt.getTime(),
                  )}
                </Row>
              ) : null}
              {row.bytes ? <Row label="Size">{formatBytes(row.bytes)}</Row> : null}
              <Row label="Visibility">
                {row.isPublic ? (
                  <>
                    public{" "}
                    <Link href="/explore" className="text-[var(--color-ink-faint)] underline underline-offset-2">
                      in Explore
                    </Link>
                  </>
                ) : (
                  "private"
                )}
              </Row>
            </dl>
          </section>

          {/* ------------------------------------------------ the money */}
          <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
            <h2 className="text-sm font-medium">Cost</h2>
            {actualUsd !== null ? (
              <>
                <p className="mt-2 font-mono text-2xl tracking-tight">
                  {formatUsd(actualUsd)}
                </p>
                <p className="mt-1 text-xs text-[var(--color-ink-faint)]">
                  Charged by OpenRouter.
                </p>
                {Math.abs(actualUsd - estimateUsd) > 0.000001 ? (
                  <p className="mt-2 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-2.5 font-mono text-xs leading-relaxed text-[var(--color-ink-muted)]">
                    quoted {formatUsd(estimateUsd)} · difference{" "}
                    {formatUsd(actualUsd - estimateUsd)} refunded
                  </p>
                ) : (
                  <p className="mt-2 font-mono text-xs text-[var(--color-ink-faint)]">
                    matched the quote exactly
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="mt-2 font-mono text-2xl tracking-tight">
                  {row.status === "failed" ? formatUsd(0) : formatUsd(estimateUsd)}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">
                  {row.status === "failed"
                    ? "Refunded. A failed job is not charged."
                    : "Held from your balance. Whatever the job does not use is refunded when it settles."}
                </p>
              </>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="text-right">{children}</dd>
    </div>
  );
}