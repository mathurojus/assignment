"use client";

import { useEffect, useState } from "react";
import type { SetupCheck } from "@/app/api/setup/route";

/**
 * The setup checklist.
 *
 * Fetches `/api/setup` on the client rather than receiving the checks as a prop
 * from the server. That is deliberate: the answer changes as soon as someone
 * edits `.env.local` and restarts, and a prop computed at render time would be a
 * second source of truth to keep in sync. This is the single source, polled.
 *
 * Polls every 10 seconds only while something is missing, and stops entirely once
 * everything is present -- a permanently polling fetch on a healthy deployment is
 * free money for nobody.
 */
export function SetupPanel() {
  const [data, setData] = useState<SetupResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const res = await fetch("/api/setup", { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as SetupResponse;
        if (cancelled) return;
        setData(json);
        setError(null);

        // Only keep polling while there is something to fix.
        if (!json.ready) timer = setTimeout(poll, 10_000);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        timer = setTimeout(poll, 10_000);
      }
    }

    poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="mx-auto max-w-4xl px-4 py-16 sm:px-6">
      <header className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight">Finish setting up</h1>
        <p className="mt-2 max-w-2xl text-[var(--color-ink-muted)]">
          Two environment variables are needed to generate. Everything else has a
          working default, and the app runs without them — this page lists what is
          present and what each missing piece would block.
        </p>
      </header>

      {error ? (
        <p className="mb-6 rounded-[var(--radius-control)] border border-[var(--color-bad)]/40 bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] px-4 py-3 text-sm text-[var(--color-bad)]">
          Could not read the setup status: {error}
        </p>
      ) : null}

      {!data ? (
        <ul className="space-y-3" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <li key={i} className="h-24 animate-pulse rounded-xl bg-[var(--color-surface)]" />
          ))}
        </ul>
      ) : (
        <ul className="space-y-3">
          {data.checks.map((check) => (
            <li key={check.key}>
              <CheckRow check={check} />
            </li>
          ))}
        </ul>
      )}

      {!data?.ready ? (
        <section className="mt-10 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-5">
          <h2 className="font-medium">Getting the two required values</h2>
          <ol className="mt-4 space-y-5 text-sm text-[var(--color-ink-muted)]">
            <li>
              <p className="text-[var(--color-ink)]">
                1. An OpenRouter API key
              </p>
              <p className="mt-1">
                Create one at openrouter.ai/keys and add it to{" "}
                <code className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-xs">
                  OPENROUTER_API_KEY
                </code>{" "}
                in <code className="font-mono text-xs">.env.local</code>.
              </p>
              <p className="mt-2 text-[var(--color-warn)]">
                OpenRouter has no free tier — it bills against purchased credits.
                The cheapest video models here cost fractions of a cent per
                second, so a test generation is genuinely cheap, but the account
                does need a balance before anything will run.
              </p>
            </li>
            <li>
              <p className="text-[var(--color-ink)]">
                2. A Postgres connection string
              </p>
              <p className="mt-1">
                Create a free project at supabase.com, then take{" "}
                <span className="text-[var(--color-ink)]">
                  Database → Connection string
                </span>
                . Use the <strong>session pooler</strong> string (port 5432),
                not the direct connection — serverless functions open many short
                connections and the direct one will be closed on them. Add it as{" "}
                <code className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-xs">
                  DATABASE_URL
                </code>
                .
              </p>
            </li>
            <li>
              <p className="text-[var(--color-ink)]">3. Create the tables</p>
              <p className="mt-1">
                Run{" "}
                <code className="rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-xs">
                  npm run db:push
                </code>
                . This applies the schema and the ledger immutability trigger.
                Restart the dev server afterwards — environment variables are read
                once at startup.
              </p>
            </li>
          </ol>
        </section>
      ) : (
        <p className="mt-10 rounded-xl border border-[var(--color-good)]/40 bg-[color-mix(in_oklch,var(--color-good)_12%,transparent)] px-4 py-3 text-sm text-[var(--color-good)]">
          Everything needed to generate is configured.
        </p>
      )}

      <details className="mt-8 text-sm">
        <summary className="cursor-pointer text-[var(--color-ink-muted)] underline underline-offset-2">
          Environment variable problems reported by the validator
        </summary>
        {data?.problems.length ? (
          <ul className="mt-3 space-y-1 font-mono text-xs text-[var(--color-warn)]">
            {data.problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[var(--color-ink-faint)]">
            None. Every variable either has a default or is optional.
          </p>
        )}
      </details>
    </div>
  );
}

interface SetupResponse {
  ready: boolean;
  checks: SetupCheck[];
  problems: string[];
}

function CheckRow({ check }: { check: SetupCheck }) {
  return (
    <div className="flex gap-4 rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
      <span
        aria-hidden
        className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold ${
          check.ok
            ? "bg-[color-mix(in_oklch,var(--color-good)_22%,transparent)] text-[var(--color-good)]"
            : check.required
              ? "bg-[color-mix(in_oklch,var(--color-bad)_22%,transparent)] text-[var(--color-bad)]"
              : "bg-[var(--color-surface-raised)] text-[var(--color-ink-faint)]"
        }`}
      >
        {check.ok ? "✓" : check.required ? "!" : "·"}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="font-medium">{check.label}</h2>
          <span className="text-xs text-[var(--color-ink-faint)]">
            {check.ok
              ? "configured"
              : check.required
                ? "required"
                : "optional"}
          </span>
          {check.variable ? (
            <code className="font-mono text-[11px] text-[var(--color-ink-faint)]">
              {check.variable}
            </code>
          ) : null}
        </div>

        <p className="mt-1.5 text-sm text-[var(--color-ink-muted)]">
          {check.blocking ?? "Ready."}
        </p>

        {!check.ok ? (
          <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">
            Where: {check.where}
          </p>
        ) : null}
      </div>
    </div>
  );
}