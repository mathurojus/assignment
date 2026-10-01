import Link from "next/link";
import { notFound } from "next/navigation";
import { hasDatabase } from "@/lib/env";
import { getSessionUser } from "@/lib/supabase/server";
import { isDatabaseUnavailable } from "@/lib/db";
import { adminJobs, adminLedger, adminOverview, adminUsers } from "@/lib/admin";
import { formatDate, formatUsd } from "@/lib/format";
import { NeedsDatabase, QueryFailed } from "@/app/gallery/page";
import { AdjustCredits } from "@/components/admin/adjust-credits";

export const metadata = {
  title: "Admin",
  description: "Operator overview: spend, jobs, accounts and the credit ledger.",
};

export const dynamic = "force-dynamic";

const TABS = ["overview", "jobs", "users", "ledger"] as const;
type Tab = (typeof TABS)[number];

/**
 * `/admin`
 *
 * Four tabs, all server-rendered, all reading `@/lib/admin`.
 *
 * The access check calls `notFound()` rather than `redirect()` on failure. An
 * operator URL that answers "not found" tells an attacker probing for admin routes
 * nothing about whether the route exists; one that redirects to `/login` for
 * anonymous visitors and to `/` for a signed-in non-admin tells them exactly that.
 * There is no page here for anyone who is not an admin.
 */
export default async function AdminPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!hasDatabase) return <NeedsDatabase />;

  const user = await getSessionUser();
  if (!user?.isAdmin) notFound();

  const params = await searchParams;
  const raw = Array.isArray(params.tab) ? params.tab[0] : params.tab;
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "overview";

  // The query is inside a helper and the JSX is not, on purpose: a `try` whose
  // body returns markup cannot catch anything a component throws while rendering,
  // so it looks like it is handling errors it actually never sees. Fetching in a
  // separate function means this `catch` really does cover the failure it claims to.
  let data: AdminData;
  try {
    data = await loadTab(tab);
  } catch (error) {
    return <QueryFailed error={error} unmigrated={isDatabaseUnavailable(error)} />;
  }

  return (
    <Shell tab={tab}>
      {"totals" in data ? <Overview totals={data.totals} /> : null}
      {"jobs" in data ? <Jobs jobs={data.jobs} /> : null}
      {"users" in data ? <Users users={data.users} /> : null}
      {"entries" in data ? <Ledger entries={data.entries} /> : null}
    </Shell>
  );
}

type AdminData =
  | { totals: Awaited<ReturnType<typeof adminOverview>> }
  | { jobs: Awaited<ReturnType<typeof adminJobs>> }
  | { users: Awaited<ReturnType<typeof adminUsers>> }
  | { entries: Awaited<ReturnType<typeof adminLedger>> };

/**
 * One tab's data.
 *
 * Returns a union discriminated by which key is present rather than an
 * `any`-ish bundle, so `AdminPage` above can narrow on `data.jobs` before reading
 * `data.jobs[0]`.
 */
async function loadTab(tab: Tab): Promise<AdminData> {
  switch (tab) {
    case "jobs":
      return { jobs: await adminJobs() };
    case "users":
      return { users: await adminUsers() };
    case "ledger":
      return { entries: await adminLedger() };
    case "overview":
    default:
      return { totals: await adminOverview() };
  }
}

function Overview({ totals }: { totals: Awaited<ReturnType<typeof adminOverview>> }) {
  const inFlight =
    (totals.byStatus["queued"] ?? 0) +
    (totals.byStatus["submitting"] ?? 0) +
    (totals.byStatus["generating"] ?? 0) +
    (totals.byStatus["downloading"] ?? 0);

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Accounts" value={String(totals.users)} />
        <Stat label="Spent today (UTC)" value={formatUsd(totals.spentTodayUsd)} />
        <Stat
          label="Credits held"
          value={totals.creditsHeld.toFixed(2)}
          note="Reserved by jobs that have not settled."
        />
        <Stat label="Jobs in flight" value={String(inFlight)} />
      </div>

      <h2 className="mt-8 text-sm font-medium">By status</h2>
      {Object.keys(totals.byStatus).length === 0 ? (
        <p className="mt-3 text-sm text-[var(--color-ink-faint)]">No generations yet.</p>
      ) : (
        <dl className="mt-3 overflow-hidden rounded-[var(--radius-card)] border border-[var(--color-line)]">
          {Object.entries(totals.byStatus)
            .sort((a, b) => b[1] - a[1])
            .map(([status, count], i) => (
              <div
                key={status}
                className={`flex items-baseline justify-between gap-4 px-4 py-2.5 text-sm ${
                  i > 0 ? "border-t border-[var(--color-line)]" : ""
                }`}
              >
                <dt className="font-mono text-[var(--color-ink-muted)]">{status}</dt>
                <dd className="font-mono">{count}</dd>
              </div>
            ))}
        </dl>
      )}

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-[var(--color-ink-faint)]">
        Counts cover every account. Each list is capped — see the limit at the top of the
        matching function in <code className="font-mono">src/lib/admin.ts</code>. A large
        instance needs a paginated export rather than a longer list.
      </p>
    </>
  );
}

function Jobs({ jobs }: { jobs: Awaited<ReturnType<typeof adminJobs>> }) {
  const errors = jobs.filter((j) => j.error).slice(0, 10);

  return (
    <>
      <Table
        head={["When", "Model", "Status", "Est.", "Actual", ""]}
        rows={jobs.map((j) => [
          formatDate(j.createdAt),
          <span key="m" className="font-mono text-xs">
            {j.model}
          </span>,
          <Status key="s" status={j.status} />,
          formatUsd(j.estimateUsd),
          j.actualUsd === null ? "—" : formatUsd(j.actualUsd),
          <Link key="l" href={`/g/${j.id}`} className="text-xs underline underline-offset-2">
            open
          </Link>,
        ])}
        empty="No jobs yet."
      />

      {errors.length > 0 ? (
        <>
          <h2 className="mt-8 text-sm font-medium">Recent errors</h2>
          <ul className="mt-3 space-y-2">
            {errors.map((j) => (
              <li
                key={j.id}
                className="rounded-[var(--radius-control)] border border-[var(--color-line)] bg-[var(--color-surface)] p-3 font-mono text-xs leading-relaxed text-[var(--color-ink-muted)]"
              >
                <span className="text-[var(--color-bad)]">{j.status}</span> {j.model} ·
                attempt {j.attempts} · {formatDate(j.createdAt)}
                <br />
                {j.error}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function Users({ users }: { users: Awaited<ReturnType<typeof adminUsers>> }) {
  if (users.length === 0) {
    return <p className="text-sm text-[var(--color-ink-faint)]">No accounts yet.</p>;
  }

  return (
    <ul className="space-y-3">
      {users.map((u) => (
        <li
          key={u.id}
          className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4"
        >
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm">
                {u.name ?? "(no name)"}{" "}
                {u.isAdmin ? (
                  <span className="ml-1 rounded-full border border-[var(--color-line)] px-2 py-0.5 font-mono text-[10px] text-[var(--color-ink-faint)]">
                    admin
                  </span>
                ) : null}
              </p>
              <p className="truncate font-mono text-xs text-[var(--color-ink-faint)]">
                {u.email}
              </p>
            </div>
            <div className="text-right font-mono text-xs">
              <p>{u.credits.toFixed(2)} credits</p>
              <p className="text-[var(--color-ink-faint)]">
                {u.jobCount} jobs · {formatUsd(u.totalSpendUsd)} spent
              </p>
              <p className="text-[var(--color-ink-faint)]">
                joined {formatDate(u.createdAt)}
              </p>
            </div>
          </div>

          {u.spendBlockedUntil ? (
            <p className="mt-2 font-mono text-xs text-[var(--color-bad)]">
              spend blocked until {new Date(u.spendBlockedUntil).toUTCString()}
            </p>
          ) : null}

          <AdjustCredits userId={u.id} email={u.email} />
        </li>
      ))}
    </ul>
  );
}

function Ledger({ entries }: { entries: Awaited<ReturnType<typeof adminLedger>> }) {
  return (
    <>
      <Table
        head={["When", "Reason", "Delta", "Balance after", "Job"]}
        rows={entries.map((e) => [
          formatDate(e.createdAt),
          <span key="r" className="font-mono text-xs">
            {e.reason}
          </span>,
          <span
            key="d"
            className={`font-mono ${
              e.deltaCredits < 0 ? "text-[var(--color-warn)]" : "text-[var(--color-good)]"
            }`}
          >
            {e.deltaCredits >= 0 ? "+" : ""}
            {e.deltaCredits.toFixed(2)}
          </span>,
          <span key="b" className="font-mono">
            {e.balanceAfter.toFixed(2)}
          </span>,
          e.generationId ? (
            <Link
              key="j"
              href={`/g/${e.generationId}`}
              className="font-mono text-xs underline underline-offset-2"
            >
              {e.generationId.slice(0, 8)}
            </Link>
          ) : (
            <span key="j" className="text-[var(--color-ink-faint)]">
              —
            </span>
          ),
        ])}
        empty="No ledger entries yet."
      />

      <p className="mt-6 max-w-2xl text-xs leading-relaxed text-[var(--color-ink-faint)]">
        This table is append-only. A Postgres trigger rejects any{" "}
        <code className="font-mono">UPDATE</code> or <code className="font-mono">DELETE</code>{" "}
        against <code className="font-mono">credit_ledger</code>, so a balance can only change
        by writing a new row. Every entry carries the balance after it, which means any
        account&apos;s history can be re-derived from the ledger alone.
      </p>
    </>
  );
}

function Shell({ tab, children }: { tab: Tab; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <p className="mt-1 text-sm text-[var(--color-ink-faint)]">
          What has been generated, what it cost, and who spent it.
        </p>
      </header>

      <nav aria-label="Admin sections" className="mt-6 flex flex-wrap gap-1">
        {TABS.map((t) => (
          <Link
            key={t}
            href={t === "overview" ? "/admin" : `/admin?tab=${t}`}
            aria-current={tab === t ? "page" : undefined}
            className={`rounded-[var(--radius-control)] px-3 py-1.5 text-sm font-medium capitalize transition-colors ${
              tab === t
                ? "bg-[var(--color-surface)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            }`}
          >
            {t}
          </Link>
        ))}
      </nav>

      <div className="mt-6">{children}</div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
      <p className="text-xs text-[var(--color-ink-faint)]">{label}</p>
      <p className="mt-1 font-mono text-2xl tracking-tight">{value}</p>
      {note ? <p className="mt-1 text-xs text-[var(--color-ink-faint)]">{note}</p> : null}
    </div>
  );
}

function Status({ status }: { status: string }) {
  const tone =
    status === "completed"
      ? "text-[var(--color-good)]"
      : status === "failed"
        ? "text-[var(--color-bad)]"
        : "text-[var(--color-ink-muted)]";
  return <span className={`font-mono text-xs ${tone}`}>{status}</span>;
}

function Table({
  head,
  rows,
  empty,
}: {
  head: string[];
  rows: React.ReactNode[][];
  empty: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-[var(--color-ink-faint)]">{empty}</p>;
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-[var(--color-line)]">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b border-[var(--color-line)]">
            {head.map((h) => (
              <th
                key={h}
                scope="col"
                className="px-4 py-2.5 text-left text-xs font-medium text-[var(--color-ink-faint)]"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={i > 0 ? "border-t border-[var(--color-line)]" : undefined}>
              {r.map((cell, j) => (
                <td key={j} className="px-4 py-2.5 align-baseline">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}