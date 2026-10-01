import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { getSessionUser } from "@/lib/supabase/server";
import { formatCredits } from "@/lib/format";
import { hasDatabase, hasOpenRouterKey } from "@/lib/env";
import { SignOutButton } from "@/components/sign-out-button";
import "./globals.css";

/**
 * The document, the header, and the one-time configuration notice.
 *
 * `layout.tsx` is a server component, so the session is read once here and the
 * result is passed down as plain props. The alternative -- a client-side auth
 * listener -- makes the header flash "Sign in" for a signed-in user on every
 * load, which reads as broken rather than as loading.
 */
export const metadata: Metadata = {
  title: {
    default: "Higgsfield — AI Creative Studio",
    template: "%s · Higgsfield",
  },
  description:
    "Generate video and images with 30 text-to-video and 55 image models behind one interface, priced in credits you control.",
  openGraph: {
    title: "Higgsfield — AI Creative Studio",
    description: "Create images, video, and cinematic stories in one AI creative studio.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Never throw if the database is missing -- that is the state the setup banner
  // exists to explain, and a crashed layout would replace a useful message with
  // a blank page.
  let user: Awaited<ReturnType<typeof getSessionUser>> = null;
  if (hasDatabase) {
    try {
      user = await getSessionUser();
    } catch {
      user = null;
    }
  }

  const misconfigured = !hasOpenRouterKey || !hasDatabase;

  return (
    <html lang="en">
      <body className="min-h-dvh antialiased" suppressHydrationWarning>
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-[var(--radius-control)] focus:bg-[var(--color-accent)] focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-[var(--color-accent-ink)]"
        >
          Skip to content
        </a>

        <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[color-mix(in_oklch,var(--color-canvas)_88%,transparent)] backdrop-blur-xl">
          <nav
            aria-label="Main"
            className="mx-auto flex h-14 max-w-7xl items-center gap-1 px-4 sm:gap-2 sm:px-6"
          >
            <Link
              href="/"
              className="mr-5 flex items-center gap-2 font-semibold tracking-tight"
            >
              <span
                aria-hidden
                className="grid size-7 place-items-center rounded-full border border-white/30 text-sm font-semibold text-white"
              >
                H
              </span>
              <span className="hidden sm:inline">HIGGSFIELD</span>
            </Link>

            <NavLink href="/explore">Explore</NavLink>
            <NavLink href="/generate?type=image">Image</NavLink>
            <NavLink href="/generate?type=video">Video</NavLink>
            <NavLink href="/generate">Audio</NavLink>
            <NavLink href="/explore">Effects</NavLink>
            <NavLink href="/generate">Cinema Studio</NavLink>
            {user?.isAdmin ? <NavLink href="/admin">Admin</NavLink> : null}

            <div className="ml-auto flex items-center gap-2">
              {user ? (
                <>
                  <span
                    className="hidden rounded-full border border-[var(--color-line)] px-3 py-1 font-mono text-xs text-[var(--color-ink-muted)] sm:inline"
                    title="Your credit balance. 1 credit = $0.01."
                  >
                    {formatCredits(user.creditsMicro ?? 0)} credits
                  </span>
                  <NavLink href="/gallery">My creations</NavLink>
                  <SignOutButton email={user.email} name={user.name} />
                </>
              ) : (
                <Link
                  href="/login"
                  className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-3 py-1.5 text-sm font-medium transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface)]"
                >
                  Log in
                </Link>
              )}
            </div>
          </nav>
        </header>

        {misconfigured ? (
          <div
            role="status"
            className="border-b border-[var(--color-warn)]/30 bg-[color-mix(in_oklch,var(--color-warn)_12%,var(--color-canvas))]"
          >
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm sm:px-6">
              <span className="font-medium text-[var(--color-warn)]">
                Setup needed
              </span>
              <span className="text-[var(--color-ink-muted)]">
                {!hasOpenRouterKey && !hasDatabase
                  ? "Add OPENROUTER_API_KEY to .env.local, then restart the dev server."
                  : !hasOpenRouterKey
                    ? "Add OPENROUTER_API_KEY to .env.local to generate. The model list works without it."
                    : "The local database is initializing. Restart the dev server."}
              </span>
              <Link
                href="/setup"
                className="underline underline-offset-2 hover:text-[var(--color-ink)]"
              >
                What is this?
              </Link>
            </div>
          </div>
        ) : null}

        <main id="main">{children}</main>

        <footer className="mt-24 border-t border-[var(--color-line)]">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-8 text-sm text-[var(--color-ink-faint)] sm:px-6">
            <p>HIGGSFIELD <span className="ml-2">A studio for your imagination.</span></p>
            <p className="font-mono text-xs">IMAGE · VIDEO · IDEAS</p>
          </div>
        </footer>
      </body>
    </html>
  );
}

function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)] sm:px-3"
    >
      {children}
    </Link>
  );
}
