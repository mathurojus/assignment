"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Grant or take back credits.
 *
 * A form with a confirmation step because it is the one action in this app that
 * moves money irreversibly: the ledger rejects edits, so an adjustment written by
 * mistake is permanent. The confirmation is a re-typed number rather than a
 * `window.confirm` for the same reason — `confirm()` reads as a formality, and
 * typing a number requires the operator to have read which number and which sign it
 * is.
 */
export function AdjustCredits({ userId, email }: { userId: string; email: string }) {
  const router = useRouter();

  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Positive grants credits, negative takes them back. Derived from the sign so
  // there is exactly one number in the UI and the direction cannot disagree with
  // itself.
  const parsed = Number(amount);
  const valid = amount.trim() !== "" && Number.isFinite(parsed) && parsed !== 0;
  const granting = valid && parsed > 0;
  const magnitude = valid ? Math.abs(parsed) : 0;

  // The API requires a reason and refuses without one. That is deliberate -- an
  // unexplained balance change is what makes a ledger untrustworthy -- so the
  // button is disabled rather than letting the server be the thing that says so.
  const reasonOk = note.trim().length >= 3;

  const adjust = useCallback(async () => {
    if (busy || !valid || !reasonOk) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/credits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          userId,
          // Credits, not dollars. The API converts with the one canonical
          // function, so nobody has to do micro-unit arithmetic to hand someone
          // $5 -- which is exactly the kind of arithmetic that produces an
          // off-by-1000 mistake.
          credits: parsed,
          reason: note.trim(),
        }),
      });

      const body = (await res.json()) as {
        ok?: boolean;
        balanceMicro?: number;
        error?: { message?: string };
        message?: string;
      };

      if (!res.ok) {
        setError(body.error?.message ?? "The adjustment was refused.");
        setConfirming(false);
        return;
      }

      setDone(
        `${granting ? "Granted" : "Removed"} ${magnitude} credit${magnitude === 1 ? "" : "s"} ${
          granting ? "to" : "from"
        } ${email}.`,
      );
      setAmount("");
      setNote("");
      setConfirming(false);
      router.refresh();
    } catch {
      setError("Could not reach the server. Nothing was changed.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }, [busy, valid, reasonOk, parsed, note, userId, email, granting, magnitude, router]);

  if (done) {
    return (
      <div className="mt-2 rounded-[var(--radius-control)] border border-[var(--color-good)]/40 bg-[color-mix(in_oklch,var(--color-good)_12%,transparent)] p-2.5 text-xs text-[var(--color-good)]">
        {done}
      </div>
    );
  }

  if (confirming) {
    return (
      <div className="mt-2 space-y-2 rounded-[var(--radius-control)] border border-[var(--color-warn)]/40 bg-[color-mix(in_oklch,var(--color-warn)_10%,transparent)] p-3">
        <p className="text-xs leading-relaxed text-[var(--color-warn)]">
          {granting ? "Grant" : "Remove"} {magnitude} credit{magnitude === 1 ? "" : "s"} to{" "}
          <strong>{email}</strong>? The ledger is append-only — this cannot be undone.
        </p>
        <input
          type="number"
          inputMode="numeric"
          placeholder={String(magnitude)}
          aria-label={`Type ${magnitude} to confirm`}
          autoFocus
          onChange={(e) => setConfirming(e.target.value === String(magnitude))}
          className="w-24 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-line-strong)]"
        />
        <div className="flex gap-2">
          <button
            type="button"
            onClick={adjust}
            disabled={busy}
            className="rounded-[var(--radius-control)] bg-[var(--color-warn)] px-3 py-1 text-xs font-medium text-black disabled:opacity-40"
          >
            {busy ? "Applying…" : "Confirm"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setError(null);
            }}
            className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-1 text-xs"
          >
            Cancel
          </button>
        </div>
        {error ? <p className="text-xs text-[var(--color-bad)]">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number"
          step="1"
          placeholder="±credits"
          aria-label={`Credits to adjust for ${email}`}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="w-24 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1 font-mono text-xs outline-none focus:border-[var(--color-line-strong)]"
        />
        <input
          type="text"
          placeholder="reason (required)"
          aria-label="Reason for the adjustment"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="w-40 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-2 py-1 text-xs outline-none focus:border-[var(--color-line-strong)]"
        />
        <button
          type="button"
          disabled={!valid || !reasonOk || busy}
          onClick={() => setConfirming(true)}
          title={!reasonOk ? "A reason is required and is written into the ledger." : undefined}
          className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-2.5 py-1 text-xs font-medium transition-colors hover:border-[var(--color-line-strong)] disabled:opacity-40"
        >
          {valid ? (granting ? "Grant" : "Remove") : "Adjust"}
        </button>
      </div>
      {error ? <p className="mt-1 text-xs text-[var(--color-bad)]">{error}</p> : null}
    </div>
  );
}