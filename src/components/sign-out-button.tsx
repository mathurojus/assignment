"use client";

import { useState } from "react";
import { signOut } from "@/lib/supabase/client";

/**
 * The account menu.
 *
 * A `<details>` element rather than a click-outside menu library. It is one
 * disclosure with three rows in it, and the browser already implements the
 * keyboard behaviour, the outside-click dismissal and the Escape handling that
 * would otherwise need a hook.
 */
export function SignOutButton({ email, name }: { email: string; name: string | null }) {
  const [busy, setBusy] = useState(false);

  return (
    <details className="group relative">
      <summary
        className="flex cursor-pointer list-none items-center gap-2 rounded-[var(--radius-control)] border border-[var(--color-line)] py-1 pl-1 pr-2.5 transition-colors hover:border-[var(--color-line-strong)] [&::-webkit-details-marker]:hidden"
        aria-label="Account"
      >
        <span
          aria-hidden
          className="grid size-6 place-items-center rounded-md bg-[var(--color-surface-raised)] text-[10px] font-bold text-[var(--color-ink-muted)]"
        >
          {initials(name ?? email)}
        </span>
        <span className="hidden max-w-32 truncate text-xs text-[var(--color-ink-muted)] sm:inline">
          {name ?? email}
        </span>
        <svg
          aria-hidden
          viewBox="0 0 12 12"
          className="size-3 text-[var(--color-ink-faint)] transition-transform group-open:rotate-180"
        >
          <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </summary>

      <div className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-surface)] shadow-2xl shadow-black/50">
        <div className="border-b border-[var(--color-line)] px-3 py-2.5">
          <p className="truncate text-sm font-medium">{name ?? "Signed in"}</p>
          <p className="truncate text-xs text-[var(--color-ink-faint)]">{email}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await signOut();
              // Full navigation rather than `router.push`: sign-out changed the session
              // cookie, and every server component that read it has to re-run.
              // A client-side navigation would keep the already-rendered RSC
              // payload, so the header would still show the signed-in user and
              // their credit balance after signing out.
              // eslint-disable-next-line @next/next/no-location-assign-relative-destination
              window.location.assign("/");
            } catch {
              setBusy(false);
            }
          }}
          className="w-full px-3 py-2.5 text-left text-sm text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink)] disabled:opacity-50"
        >
          {busy ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </details>
  );
}

/**
 * Up to two initials.
 *
 * Prefers the name, falls back to the email's local part. Falls back to "?" rather
 * than rendering nothing, because an empty circle looks like a bug.
 */
function initials(source: string): string {
  const cleaned = source.trim();
  if (!cleaned) return "?";

  const words = cleaned.split(/[\s._-]+/).filter(Boolean);

  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  // One word, or an email: take the first two letters of the local part so
  // "ojus@example.com" reads "OJ" rather than "O".
  const local = cleaned.includes("@") ? cleaned.split("@")[0] : cleaned;
  return local.slice(0, 2).toUpperCase();
}