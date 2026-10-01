"use client";

import { useState } from "react";
import type { JobView, JobStatus, JobError } from "@/components/studio/use-job";
import { formatBytes, formatElapsed, formatUsd } from "@/lib/format";

/**
 * The result, and whatever is happening while there isn't one yet.
 *
 * The status line is the point of this component. Video generation takes
 * anywhere from ten seconds to several minutes, and an opaque spinner during that
 * is indistinguishable from a hang. So each status is labelled with what is
 * actually happening, in the app's own words, and the elapsed time is always
 * visible.
 */

const STATUS_COPY: Record<JobStatus, { label: string; detail: string }> = {
  queued: {
    label: "Queued",
    detail: "Waiting for a worker to submit this to OpenRouter.",
  },
  submitting: {
    label: "Submitting",
    detail: "Sending the request upstream.",
  },
  generating: {
    label: "Generating",
    detail: "OpenRouter is rendering the video. This is the slow part.",
  },
  downloading: {
    label: "Fetching",
    detail: "Done upstream. Copying the file into storage.",
  },
  completed: { label: "Ready", detail: "" },
  failed: { label: "Failed", detail: "" },
  cancelled: { label: "Cancelled", detail: "" },
  expired: { label: "Expired", detail: "" },
};

export function JobStage({
  job,
  loading,
  error,
  elapsedMs,
  blockedReason,
}: {
  job: JobView | null;
  loading: boolean;
  error: JobError | null;
  elapsedMs: number;
  blockedReason: string | null;
}) {
  if (error && error.kind !== "network") {
    return (
      <section className="rounded-[var(--radius-card)] border border-[var(--color-bad)]/40 bg-[var(--color-surface)] p-5">
        <h2 className="text-sm font-medium text-[var(--color-bad)]">Job status unavailable</h2>
        <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-muted)]">{error.message}</p>
        {error.kind === "unauthorized" ? (
          <a
            href="/login"
            className="mt-3 inline-block text-xs underline underline-offset-2 text-[var(--color-accent)]"
          >
            Sign in
          </a>
        ) : null}
      </section>
    );
  }

  if (!job) {
    return (
      <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
        <h2 className="text-sm font-medium text-[var(--color-ink-muted)]">Result</h2>
        {loading ? (
          // A job id is in the URL but nothing has arrived yet. Say that, rather
          // than showing the idle "nothing generated yet" copy, which would read
          // as though the link were broken.
          <p className="mt-2 flex items-center gap-2 text-xs text-[var(--color-ink-faint)]">
            <span
              aria-hidden
              className="size-2 animate-pulse rounded-full bg-[var(--color-accent)]"
            />
            Loading job…
          </p>
        ) : (
          <p className="mt-2 text-xs leading-relaxed text-[var(--color-ink-faint)]">
            Nothing generated yet. Your result appears here.
          </p>
        )}
        {blockedReason ? (
          <p className="mt-3 text-xs leading-relaxed text-[var(--color-warn)]">{blockedReason}</p>
        ) : null}
      </section>
    );
  }

  const copy = STATUS_COPY[job.status] ?? { label: job.status, detail: "" };
  const running = !job.terminal;

  return (
    <section className="overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--color-line)] px-5 py-3">
        <h2 className="text-sm font-medium">
          {job.terminal ? "Result" : "In progress"}
        </h2>
        {running ? (
          <span className="font-mono text-xs tabular-nums text-[var(--color-ink-faint)]">
            {formatElapsed(elapsedMs)}
          </span>
        ) : job.cost.chargedUsd != null ? (
          <span className="font-mono text-xs tabular-nums text-[var(--color-ink-muted)]">
            {formatUsd(Math.round(job.cost.chargedUsd * 1_000_000))}
          </span>
        ) : null}
      </div>

      <div className="p-5">
        {/* status line */}
        <div className="flex items-start gap-2.5">
          <StatusDot status={job.status} />
          <div className="min-w-0">
            <p className="text-sm font-medium">{copy.label}</p>
            {copy.detail ? (
              <p className="mt-0.5 text-xs leading-relaxed text-[var(--color-ink-faint)]">
                {copy.detail}
              </p>
            ) : null}
          </div>
        </div>

        {running ? (
          <>
            {/* Progress by stage, not a fake percentage. A bar that fills over
                eight seconds and then sits still for two minutes is worse than
                nothing: it teaches people to read motion as progress. */}
            <ol className="mt-4 space-y-1.5" aria-label="Job stages">
              {(["queued", "submitting", "generating", "downloading"] as const).map((stage) => (
                <StageRow
                  key={stage}
                  label={STATUS_COPY[stage].label}
                  state={
                    stageIndex(job.status) > stageIndex(stage)
                      ? "done"
                      : stageIndex(job.status) === stageIndex(stage)
                        ? "current"
                        : "todo"
                  }
                />
              ))}
            </ol>

            <p className="mt-4 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] px-3 py-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
              This tab advances the job while it is open and you are looking at it.
              Close it and the job pauses — reopen this page and it picks up where it
              left off. If you need it to run unattended, use{" "}
              <code className="font-mono">npm run worker</code> or set up an
              OpenRouter webhook.
            </p>
          </>
        ) : null}

        {/* output */}
        {job.status === "completed" && job.outputUrl ? (
          <OutputPanel job={job} />
        ) : null}

        {job.terminal && job.status !== "completed" ? (
          <div className="mt-4 rounded-[var(--radius-control)] border border-[var(--color-bad)]/35 bg-[color-mix(in_oklch,var(--color-bad)_10%,transparent)] px-3 py-2.5">
            <p className="text-xs leading-relaxed text-[var(--color-bad)]">
              {job.error ?? copy.detail ?? "The generation did not complete."}
            </p>
            {job.status === "failed" ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
                Credits held for a failed job are refunded automatically. The refund is
                on the same transaction as the failure, so it cannot be skipped.
              </p>
            ) : null}
          </div>
        ) : null}

        {error?.kind === "network" ? (
          <p className="mt-4 text-xs text-[var(--color-warn)]">{error.message}</p>
        ) : null}

        {/* cost reconciliation */}
        {job.terminal ? (
          <dl className="mt-4 space-y-1 border-t border-[var(--color-line)] pt-3 font-mono text-xs text-[var(--color-ink-faint)]">
            <div className="flex justify-between">
              <dt>estimated</dt>
              <dd>{formatUsd(Math.round(job.cost.estimateUsd * 1_000_000))}</dd>
            </div>
            {job.cost.actualUsd != null ? (
              <div className="flex justify-between">
                <dt>actual</dt>
                <dd className="text-[var(--color-ink-muted)]">
                  {formatUsd(Math.round(job.cost.actualUsd * 1_000_000))}
                </dd>
              </div>
            ) : null}
            {job.cost.chargedUsd != null && job.cost.actualUsd != null &&
            Math.abs(job.cost.chargedUsd - job.cost.estimateUsd) > 0.0001 ? (
              <div className="flex justify-between">
                <dt>refunded</dt>
                <dd className="text-[var(--color-good)]">
                  {formatUsd(
                    Math.round(
                      Math.max(0, job.cost.estimateUsd - job.cost.chargedUsd) * 1_000_000,
                    ),
                  )}
                </dd>
              </div>
            ) : null}
          </dl>
        ) : null}
      </div>
    </section>
  );
}

function OutputPanel({ job }: { job: JobView }) {
  const [copied, setCopied] = useState(false);

  const isVideo = job.mimeType?.startsWith("video/") || job.outputUrl?.endsWith(".mp4");

  return (
    <div className="mt-4">
      {isVideo ? (
        // `controls` and not `autoplay`: a video that starts playing on its own
        // while the page is still shifting is startling, and it costs bandwidth
        // the user did not ask to spend.
        <video
          src={job.outputUrl!}
          controls
          preload="metadata"
          className="w-full rounded-lg border border-[var(--color-line)] bg-black"
        >
          Your browser cannot play this video.{" "}
          <a href={job.outputUrl!} className="underline">
            Download it
          </a>{" "}
          instead.
        </video>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={job.outputUrl!}
          alt={job.prompt}
          className="w-full rounded-lg border border-[var(--color-line)]"
        />
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(job.prompt);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // Clipboard access can be denied. Not worth an error message.
            }
          }}
          className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--color-line-strong)]"
        >
          {copied ? "Copied" : "Copy prompt"}
        </button>

        {job.outputUrl ? (
          <a
            href={job.outputUrl}
            download
            className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--color-line-strong)]"
          >
            Download
          </a>
        ) : null}

        <TogglePublic job={job} />
      </div>

      <p className="mt-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
        {job.model}
        {typeof job.params["durationSeconds"] === "number"
          ? ` · ${job.params["durationSeconds"]}s`
          : ""}
        {typeof job.params["resolution"] === "string"
          ? ` · ${job.params["resolution"]}`
          : ""}
        {job.bytes ? ` · ${formatBytes(job.bytes)}` : ""}
      </p>
    </div>
  );
}

/**
 * Publish toggle.
 *
 * Its own component so the PATCH and the optimistic update stay together. The
 * update is applied optimistically because this is a two-second call that flips
 * one checkbox; waiting for it would make the control feel broken.
 */
function TogglePublic({ job }: { job: JobView }) {
  const [isPublic, setIsPublic] = useState(job.isPublic);
  const [busy, setBusy] = useState(false);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        const next = !isPublic;
        setIsPublic(next);
        setBusy(true);
        try {
          const res = await fetch(`/api/generate/${job.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ isPublic: next }),
          });
          // Roll back on failure rather than leaving a lie on screen.
          if (!res.ok) setIsPublic(!next);
        } catch {
          setIsPublic(!next);
        } finally {
          setBusy(false);
        }
      }}
      className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-1.5 text-xs transition-colors hover:border-[var(--color-line-strong)] disabled:opacity-50"
    >
      {isPublic ? "Published" : "Publish to Explore"}
    </button>
  );
}

function StatusDot({ status }: { status: JobStatus }) {
  const tone =
    status === "completed"
      ? "bg-[var(--color-good)]"
      : status === "failed" || status === "expired"
        ? "bg-[var(--color-bad)]"
        : status === "cancelled"
          ? "bg-[var(--color-ink-faint)]"
          : "bg-[var(--color-accent)] animate-pulse";

  return <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${tone}`} />;
}

const STAGE_ORDER: JobStatus[] = ["queued", "submitting", "generating", "downloading"];

function stageIndex(status: JobStatus): number {
  return STAGE_ORDER.indexOf(status);
}

function StageRow({
  label,
  state,
}: {
  label: string;
  state: "done" | "current" | "todo";
}) {
  return (
    <li className="flex items-center gap-2.5 text-xs">
      <span
        aria-hidden
        className={`grid size-4 shrink-0 place-items-center rounded-full border text-[9px] ${
          state === "done"
            ? "border-[var(--color-good)] bg-[var(--color-good)] text-[var(--color-canvas)]"
            : state === "current"
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-[var(--color-line)] text-transparent"
        }`}
      >
        ✓
      </span>
      <span
        className={
          state === "todo"
            ? "text-[var(--color-ink-faint)]"
            : state === "current"
              ? "font-medium"
              : "text-[var(--color-ink-muted)]"
        }
      >
        {label}
      </span>
      {state === "current" ? (
        <span className="sr-only">(in progress)</span>
      ) : null}
    </li>
  );
}