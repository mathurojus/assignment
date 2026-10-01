import Link from "next/link";
import { getSessionUser } from "@/lib/supabase/server";
import { hasDatabase, hasOpenRouterKey } from "@/lib/env";
import { listVideoModels, listImageModels } from "@/lib/openrouter/models";
import { formatCredits } from "@/lib/format";
import { presets } from "@/lib/presets";

export const dynamic = "force-dynamic";

/**
 * `/`
 *
 * Every number on this page is live rather than written down in the copy. "30
 * text-to-video models" in a paragraph is a claim that starts rotting the week
 * OpenRouter adds one; a count rendered from the same call the dropdown uses is
 * correct whenever the page is. If the list cannot be reached, the page says so
 * instead of claiming a count it could not verify.
 */
export default async function HomePage() {
  let videoCount: number | null = null;
  let imageCount: number | null = null;

  try {
    const [video, images] = await Promise.all([listVideoModels(), listImageModels()]);
    videoCount = video.length;
    imageCount = images.length;
  } catch {
    // Left null. The copy below handles that case explicitly.
  }

  let credits: string | null = null;
  let signedIn = false;
  if (hasDatabase) {
    try {
      const user = await getSessionUser();
      if (user) {
        signedIn = true;
        credits = formatCredits(user.creditsMicro);
      }
    } catch {
      // A database that is reachable but broken should not take the landing page
      // down. The generate page will report the real error where it matters.
    }
  }

  const ready = hasOpenRouterKey && hasDatabase;

  return (
    <div>
      <section className="mx-auto max-w-7xl px-4 py-20 sm:px-6 sm:py-28">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-[var(--color-ink-faint)]">
          OpenRouter video + images
        </p>
        <h1 className="mt-4 max-w-3xl text-4xl font-semibold tracking-tight text-accent-gradient sm:text-5xl">
          See the price before you spend it.
        </h1>
        <p className="mt-5 max-w-2xl text-lg leading-relaxed text-[var(--color-ink-muted)]">
          Most generation apps show you the result and then what it cost. This one
          quotes every job from the model&apos;s own pricing, holds exactly that from
          your balance, and refunds the difference the moment OpenRouter reports the
          real charge.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-3">
          <PrimaryLink href={ready ? "/generate" : "/setup"}>
            {ready ? "Start generating" : "Set up the app"}
          </PrimaryLink>
          <SecondaryLink href="/explore">Browse what people made</SecondaryLink>
        </div>

        {signedIn && credits !== null ? (
          <p className="mt-6 font-mono text-sm text-[var(--color-ink-muted)]">
            You have {credits} credits.{" "}
            <Link href="/gallery" className="underline underline-offset-2">
              Your gallery
            </Link>
          </p>
        ) : null}
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="border-y border-[var(--color-line)] bg-[var(--color-surface-sunken)]">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight">
            Three steps, and one of them is optional
          </h2>
          <div className="mt-8 grid gap-6 sm:grid-cols-3">
            <Step
              n="1"
              title="Quote"
              body="Pick a model and its parameters. The price comes from that model's live pricing, including the resolution and audio tier you chose — not from a table someone typed out months ago."
            />
            <Step
              n="2"
              title="Hold"
              body="Submitting takes the quoted amount from your balance immediately, in one database transaction. You never get to run a job you cannot afford."
            />
            <Step
              n="3"
              title="Settle"
              body="When OpenRouter reports what it actually billed, the difference is refunded — whether that is less than held, or, for a job whose cost could not be quoted, whatever is left over."
            />
          </div>
          <p className="mt-6 text-sm text-[var(--color-ink-faint)]">
            A ledger row is written for every movement, and the database refuses to let
            one be edited or deleted afterwards.
          </p>
        </div>
      </section>

      {/* ---------------------------------------------------------- numbers */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6">
        <h2 className="text-2xl font-semibold tracking-tight">
          What is actually available
        </h2>
        <dl className="mt-8 grid gap-6 sm:grid-cols-3">
          <Stat
            label="Text-to-video models"
            value={videoCount === null ? "—" : String(videoCount)}
            note={
              videoCount === null
                ? "Model list unreachable — no network, or OpenRouter is down."
                : "Loaded live from OpenRouter just now. Video ZDR is unavailable, so prices are the ones OpenRouter shows."
            }
          />
          <Stat
            label="Image models"
            value={imageCount === null ? "—" : String(imageCount)}
            note={
              imageCount === null
                ? "Model list unreachable."
                : "Any of them can produce several images in one job."
            }
          />
          <Stat
            label="Camera presets"
            value={String(presets.length)}
            note="Each one appends real photographic language to a prompt — focal length, film stock, lighting."
          />
        </dl>
      </section>

      {/* ----------------------------------------------------------- honesty */}
      <section className="mx-auto max-w-3xl px-4 pb-24 sm:px-6">
        <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-6">
          <h2 className="text-lg font-semibold tracking-tight">
            What this app will not do
          </h2>
          <ul className="mt-4 space-y-3 text-sm leading-relaxed text-[var(--color-ink-muted)]">
            <li>
              <strong className="text-[var(--color-ink)]">It will not show a price it
              cannot stand behind.</strong>{" "}
              Some models are priced per token and OpenRouter publishes no token count
              for an image or a video. Those get a stated reason and a held ceiling,
              then a refund against what was actually billed — never a fabricated
              estimate.
            </li>
            <li>
              <strong className="text-[var(--color-ink)]">It will not edit the
              ledger.</strong>{" "}
              A Postgres trigger rejects any <code className="font-mono text-xs">UPDATE</code>{" "}
              or <code className="font-mono text-xs">DELETE</code> on a credit movement,
              so the history is an append-only record rather than a mutable balance.
            </li>
            <li>
              <strong className="text-[var(--color-ink)]">It will not offer a model
              that has been removed.</strong>{" "}
              The list is loaded on the server per render, so a model withdrawn
              upstream disappears from the dropdown rather than failing at submit.
            </li>
          </ul>
        </div>
      </section>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-5">
      <span className="font-mono text-xs text-[var(--color-ink-faint)]">{n}</span>
      <h3 className="mt-1 font-medium">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-ink-faint)]">{body}</p>
    </div>
  );
}

function Stat({
  label,
  value,
  note,
}: {
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div>
      <dt className="text-sm text-[var(--color-ink-faint)]">{label}</dt>
      <dd className="mt-1 font-mono text-4xl tracking-tight text-[var(--color-ink)]">
        {value}
      </dd>
      <dd className="mt-2 text-xs leading-relaxed text-[var(--color-ink-faint)]">
        {note}
      </dd>
    </div>
  );
}

function PrimaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] bg-[var(--color-ink)] px-5 py-2.5 text-sm font-medium text-[var(--color-canvas)] transition-opacity hover:opacity-90"
    >
      {children}
    </Link>
  );
}

function SecondaryLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="rounded-[var(--radius-control)] border border-[var(--color-line)] px-5 py-2.5 text-sm font-medium transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface)]"
    >
      {children}
    </Link>
  );
}