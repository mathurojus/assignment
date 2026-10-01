import { redirect } from "next/navigation";
import { AuthForm } from "@/components/auth-form";
import { getSessionUser } from "@/lib/supabase/server";
import { env } from "@/lib/env";

export const metadata = {
  title: "Sign in",
  description: "Sign in to Vantage.",
};

export const dynamic = "force-dynamic";

/**
 * `/login`
 *
 * Redirects an already-signed-in visitor to where they were going rather than
 * showing a login form to someone with a valid session. Reading the session here
 * costs one authenticated call, which the page would otherwise pay anyway.
 */
export default async function LoginPage() {
  const user = await getSessionUser();
  if (user) redirect("/generate");

  return (
    <AuthShell title="Sign in" subtitle="Your gallery, your credits, your prompts.">
      <AuthForm mode="signin" />
      {env.FREE_STARTING_CREDITS > 0 ? (
        <p className="mt-6 rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface-sunken)] p-3 text-xs leading-relaxed text-[var(--color-ink-faint)]">
          New accounts start with {env.FREE_STARTING_CREDITS} credits. A credit is one
          cent, and OpenRouter bills whatever the model actually costs.
        </p>
      ) : null}
    </AuthShell>
  );
}

/** The card both auth pages share. */
export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-[70vh] w-full max-w-md flex-col justify-center px-4 py-16">
      <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-faint)]">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}