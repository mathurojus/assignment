"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

/**
 * Email + password sign-in and sign-up, on one component.
 *
 * One component rather than two because the two forms are the same form with a
 * different endpoint and a different string after it. Splitting them would mean
 * two copies of the error handling, the redirect, and the redirect-URL logic --
 * and the redirect-URL logic is exactly the part that is easy to get subtly wrong
 * in one copy and not the other.
 *
 * Supabase also offers OAuth and magic links. Neither is wired up, deliberately:
 * each needs a provider configured in the Supabase dashboard and a callback URL,
 * which is setup a reader cloning this repo has not done. The email/password path
 * needs nothing but the project URL and anon key.
 */
export function AuthForm({ mode }: { mode: "signin" | "signup" }) {
  const router = useRouter();
  const configured = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Use the local account store when the optional Supabase provider is absent.
  const supabase = configured;

  if (done) {
    return (
      <div className="space-y-4 text-sm">
        <div className="rounded-[var(--radius-control)] border border-[var(--color-good)]/40 bg-[color-mix(in_oklch,var(--color-good)_12%,transparent)] p-4 text-[var(--color-good)]">
          Account created. You can sign in now.
        </div>
        <Link
          href="/login"
          className="inline-block rounded-[var(--radius-control)] bg-[var(--color-ink)] px-4 py-2 text-[var(--color-canvas)]"
        >
          Go to sign in
        </Link>
      </div>
    );
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setError(null);

    // Checked here so the message is about *this* form rather than about
    // Supabase's generic "AuthApiError: Password should be at least 6
    // characters", which tells a first-time user nothing about which field is
    // wrong or what the app considers valid.
    if (!email.includes("@")) {
      setError("That does not look like an email address.");
      return;
    }
    if (password.length < 8) {
      setError("Passwords must be at least 8 characters.");
      return;
    }

    setBusy(true);
    try {
      if (!supabase) {
        const response = await fetch("/api/auth/local", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: mode, email, password }),
        });
        const result = await response.json();
        if (!response.ok) {
          setError(result.error ?? "Could not sign in. Try again.");
          return;
        }
        window.location.assign(next());
        return;
      }

      if (mode === "signup") {
        const { error: signUpError } = await supabase.auth.signUp({ email, password });
        if (signUpError) {
          setError(await explain(signUpError.message));
          return;
        }
        // Supabase may or may not create a session here: with email confirmation
        // on there is no session until the link is clicked, with it off there is
        // one immediately. Rather than branch on which, say what happened and let
        // the reader decide -- guessing wrong either way leaves them stuck on a
        // page that cannot explain itself.
        const { data } = await supabase.auth.getSession();
        if (data.session) {
          router.push("/generate");
          router.refresh();
          return;
        }
        setDone(true);
        return;
      }

      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(await explain(signInError.message));
        return;
      }

      // Full navigation, not a push. Sign-in set a cookie that the already-loaded
      // RSC payload was rendered without, so the header would still read
      // "signed out" until a hard reload.
      window.location.assign(next());
    } catch {
      setError("Could not reach the auth service. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <div>
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mt-1.5 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-line-strong)]"
        />
      </div>

      <div>
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          minLength={8}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 w-full rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-3 py-2.5 text-sm outline-none focus:border-[var(--color-line-strong)]"
        />
        <p className="mt-1.5 text-xs text-[var(--color-ink-faint)]">At least 8 characters.</p>
      </div>

      {error ? (
        <p role="alert" className="rounded-[var(--radius-control)] border border-[var(--color-bad)]/40 bg-[color-mix(in_oklch,var(--color-bad)_12%,transparent)] p-3 text-sm text-[var(--color-bad)]">
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={busy}
        className="w-full rounded-[var(--radius-control)] bg-[var(--color-ink)] px-4 py-2.5 text-sm font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {busy ? "Working…" : mode === "signup" ? "Create account" : "Sign in"}
      </button>

      <p className="text-center text-sm text-[var(--color-ink-faint)]">
        {mode === "signup" ? (
          <>
            Already have an account?{" "}
            <Link href="/login" className="underline underline-offset-2 hover:text-[var(--color-ink)]">
              Sign in
            </Link>
          </>
        ) : (
          <>
            No account?{" "}
            <Link href="/signup" className="underline underline-offset-2 hover:text-[var(--color-ink)]">
              Create one
            </Link>
          </>
        )}
      </p>
    </form>
  );
}

function Unconfigured() {
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-[var(--radius-control)] border border-[var(--color-warn)]/40 bg-[color-mix(in_oklch,var(--color-warn)_12%,transparent)] p-4 text-[var(--color-warn)]">
        Authentication is not configured.
      </div>
      <p className="leading-relaxed text-[var(--color-ink-muted)]">
        This app needs a Supabase project before anyone can sign in. Create a free one,
        then set <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
        <code className="font-mono text-xs">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in{" "}
        <code className="font-mono text-xs">.env.local</code> and restart.
      </p>
      <p className="text-[var(--color-ink-faint)]">
        Everything else in the app still works without it. <Link href="/setup" className="underline underline-offset-2">The setup page</Link>{" "}
        lists exactly what is and is not configured.
      </p>
    </div>
  );
}

/**
 * Where to go after signing in.
 *
 * Only an internal path is honoured, and the check is on the raw value rather than
 * on a parsed URL. `//evil.example` and `https://evil.example` both start with
 * characters that make this a protocol-relative or absolute navigation, so a
 * naive `startsWith("/")` would turn the post-sign-in redirect into an open
 * redirect -- handing an attacker a page on the real domain that bounces to
 * theirs.
 */
function next(): string {
  const target = new URLSearchParams(window.location.search).get("next");
  if (!target) return "/generate";
  if (!target.startsWith("/")) return "/generate";
  if (target.startsWith("//")) return "/generate";
  return target;
}

/**
 * Turn a Supabase error into something a person can act on.
 *
 * Supabase's messages are written for developers ("User already registered",
 * "Email logins are disabled"). `User already registered` in particular is a real
 * trap: left as-is it tells an existing user they cannot sign in and gives no
 * reason. Passing an email through the account-enumeration defence is a tradeoff
 * this app resolves by being helpful, and it is called out here rather than
 * silently: this only runs against a real Supabase project, so it reveals whether
 * an address is registered to anyone who can sign up.
 */
async function explain(message: string): Promise<string> {
  if (/already registered|already been registered/i.test(message)) {
    return "That email already has an account. Sign in instead, or reset the password.";
  }
  if (/invalid login credentials/i.test(message)) {
    return "That email and password do not match.";
  }
  if (/email logins are disabled/i.test(message)) {
    return "This Supabase project has email sign-in turned off. Turn it on in Authentication → Providers.";
  }
  if (/rate limit|too many/i.test(message)) {
    return "Too many attempts. Wait a minute and try again.";
  }
  return message;
}
