"use client";

import { usdFromFloat } from "@/lib/format";

/**
 * The price, and the button that spends it.
 *
 * This is the most important panel in the app. Video generation costs real money
 * per second and the price varies by an order of magnitude across models, so a
 * user who cannot see the cost before committing will either refuse to generate or
 * be surprised by the bill. The number is therefore always shown, and when it
 * genuinely cannot be known the panel says so and says what will be held instead
 * of rendering a dash that could be read as free.
 */

export interface QuoteResponse {
  estimable: boolean;
  costUsd: number | null;
  credits: number | null;
  basis: string;
  reason?: string;
  reservedUsd?: number;
}

export function CostCard({
  quote,
  quoting,
  modelName,
  ceilingUsd,
  submitting,
  canGenerate,
  promptOk,
  onSubmit,
  error,
}: {
  quote: QuoteResponse | null;
  quoting: boolean;
  modelName: string | null;
  ceilingUsd: number;
  submitting: boolean;
  canGenerate: boolean;
  promptOk: boolean;
  onSubmit: () => void;
  error: string | null;
}) {
  return (
    <section className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <h2 className="text-sm font-medium text-[var(--color-ink-muted)]">Cost</h2>

      <div className="mt-3 min-h-14">
        {!quote ? (
          <p className="text-3xl font-semibold tracking-tight text-[var(--color-ink-faint)]">
            {quoting ? "…" : "—"}
          </p>
        ) : quote.estimable ? (
          <>
            <p className="text-3xl font-semibold tracking-tight">{usdFromFloat(quote.costUsd)}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">
              {quote.basis}
            </p>
          </>
        ) : (
          // A model with no public token-to-duration mapping. The cost is knowable
          // only after the fact, so say that, and say what is held in the meantime.
          <>
            <p className="text-3xl font-semibold tracking-tight text-[var(--color-warn)]">
              unknown
            </p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-ink-faint)]">
              This model is priced per video token and OpenRouter does not publish
              the token count for a given duration, so the cost cannot be quoted up
              front. Up to{" "}
              <span className="text-[var(--color-ink-muted)]">
                {usdFromFloat(quote.reservedUsd ?? ceilingUsd)}
              </span>{" "}
              is held, and the unused part is refunded the moment the real cost is
              reported.
            </p>
          </>
        )}
      </div>

      {modelName ? (
        <p className="mt-3 truncate text-xs text-[var(--color-ink-faint)]">{modelName}</p>
      ) : null}

      <button
        type="button"
        onClick={onSubmit}
        disabled={!canGenerate || submitting || !promptOk || !quote}
        className="mt-4 w-full rounded-[var(--radius-control)] bg-[linear-gradient(135deg,var(--color-accent),var(--color-accent-violet))] px-4 py-2.5 text-sm font-semibold text-[var(--color-accent-ink)] transition-[filter,opacity] hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:brightness-100"
      >
        {submitting ? "Submitting…" : "Generate"}
      </button>

      <p className="mt-2 text-center text-xs text-[var(--color-ink-faint)]">
        1 credit = $0.01. Unused credits are refunded automatically.
      </p>

      {!canGenerate ? (
        <p className="mt-3 text-xs leading-relaxed text-[var(--color-warn)]">
          Generation is disabled. See{" "}
          <a href="/setup" className="underline underline-offset-2">
            the setup checklist
          </a>
          .
        </p>
      ) : !promptOk ? (
        <p className="mt-3 text-xs text-[var(--color-ink-faint)]">Write a prompt to enable this.</p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mt-3 rounded-[var(--radius-control)] border border-[var(--color-bad)]/40 bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] px-3 py-2 text-xs leading-relaxed text-[var(--color-bad)]"
        >
          {error}
        </p>
      ) : null}
    </section>
  );
}