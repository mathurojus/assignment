import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { AuthShell } from "@/app/login/page";
import { getSessionUser } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const metadata = {
  title: "Create an account",
  description: "Create a Vantage account.",
};

export const dynamic = "force-dynamic";

/**
 * `/signup`
 *
 * The credits a new account gets are shown before signing up, not after. The grant
 * happens on first authenticated request (see `ensureUser`), so a reader who
 * reaches `/generate` has already been credited whether or not they ever load this
 * page -- which means a number stated here and a number actually granted are
 * rendered from the same `env.FREE_STARTING_CREDITS`, and cannot drift.
 */
export default async function SignupPage() {
  const user = await getSessionUser();
  if (user) redirect("/generate");

  return (
    <AuthShell title="Create an account" subtitle="Free to start. Pay only for what you generate.">
      <AuthForm mode="signup" />
      {env.FREE_STARTING_CREDITS > 0 ? (
        <p className="mt-6 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3 text-xs leading-relaxed text-[var(--color-ink-faint)]">
          You get {env.FREE_STARTING_CREDITS} credits when you sign up — about{" "}
          {Math.floor(env.FREE_STARTING_CREDITS / 100)} cents, enough for a first generation.
          Every model is priced live before you commit anything, so you always see what a
          job costs before it runs.
        </p>
      ) : null}
    </AuthShell>
  );
}