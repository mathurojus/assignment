"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Everything the client knows about one generation.
 *
 * Mirrors the API shape rather than inventing a view model, because there is
 * nothing to add: the server has already decided what is safe to show.
 */
export interface JobView {
  id: string;
  type: "video" | "image";
  status: JobStatus;
  terminal: boolean;
  model: string;
  prompt: string;
  enhancedPrompt: string | null;
  preset: string | null;
  params: Record<string, unknown>;
  isPublic: boolean;
  outputKey: string | null;
  outputUrl: string | null;
  sourceImageUrl: string | null;
  mimeType: string | null;
  bytes: number | null;
  error: string | null;
  cost: { estimateUsd: number; actualUsd: number | null; chargedUsd: number | null };
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export type JobStatus =
  | "queued"
  | "submitting"
  | "generating"
  | "downloading"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

/**
 * Every failure the job watcher can hit.
 *
 * `aborted` carries a message even though it is never rendered: it exists so
 * every variant has one, which means no consumer needs a `message` guard or a
 * non-null assertion. An unmounting component throwing it away is not a special
 * case worth encoding in the type.
 */
export type JobError =
  | { kind: "unauthorized"; message: string }
  | { kind: "network"; message: string }
  | { kind: "http"; message: string; code?: string }
  | { kind: "aborted"; message: string }
  | { kind: "lost"; message: string };

/**
 * Watch one job until it finishes.
 *
 * The caller owns `jobId`. This hook owns everything else: reading the job,
 * polling it, nudging the worker, and persisting the id so a reload resumes.
 *
 * This is also the free-tier worker. There is no background process and no usable
 * cron: Vercel's Hobby plan allows one cron per day, and a three-minute video
 * cannot wait for that. So while somebody watches a job, their browser pings
 * `/api/worker/tick` -- which costs nothing, needs no infrastructure, and works
 * on every hosting plan.
 *
 * The tradeoff, stated plainly because it is the main limitation of the whole
 * design: **a job only advances while a tab is open.** Once accepted, it stays in
 * its current state until somebody returns to the page. Three things follow from
 * that, and all three are implemented rather than left as caveats:
 *
 *  - the id is in the URL, so a reload or a shared link resumes it
 *  - polling and ticking pause while the tab is hidden, because browsers throttle
 *    background timers to roughly once a minute and pretending otherwise would be
 *    a lie about what the app is doing
 *  - `localStorage` remembers the last id, so coming back picks it up
 *
 * `npm run worker` removes the caveat for anyone with a machine that stays up, and
 * an OpenRouter webhook removes it for anyone with a real backend. Neither is
 * required.
 */
export function useJob(jobId: string | null) {
  const [job, setJob] = useState<JobView | null>(null);
  const [error, setError] = useState<JobError | null>(null);

  // Remember the id so a reload resumes rather than forgetting a paid-for job.
  useEffect(() => {
    if (!jobId) return;
    try {
      localStorage.setItem(LAST_JOB_KEY, jobId);
    } catch {
      // Private browsing, or storage full. Losing the id costs one reload.
    }
  }, [jobId]);

  /**
 * Fetch the job once.
 *
 * `useCallback` because the polling effect depends on it: an unstable reference
 * would re-run the effect on every render, which cancels the in-flight request,
 * starts another, and polls in a tight loop.
 *
 * Throws a typed `JobError` on every failure path, so the loop below has no
 * `instanceof` chains.
 */
  const fetchJob = useCallback(async (id: string, signal?: AbortSignal): Promise<JobView> => {
    let res: Response;
    try {
      res = await fetch(`/api/generate/${id}`, { cache: "no-store", ...(signal ? { signal } : {}) });
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        // The component unmounted, or the effect re-ran. Not a user-visible
        // failure and not retryable — the loop that threw it is already gone.
        throw { kind: "aborted", message: "Cancelled." } satisfies JobError;
      }
      throw {
        kind: "network",
        message: "Could not reach the server. Your generation is safe — retrying.",
      } satisfies JobError;
    }

    if (res.status === 401) {
      throw { kind: "unauthorized", message: "Your session expired. Sign in again." } satisfies JobError;
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as
        | { error?: { message?: string; code?: string } }
        | null;
      throw {
        kind: "http",
        code: body?.error?.code,
        message: body?.error?.message ?? `The server returned HTTP ${res.status}.`,
      } satisfies JobError;
    }

    return (await res.json()) as JobView;
  }, []);

  // ---- loop 1: read the job ---------------------------------------------
  // Only runs when there is an id. When `jobId` becomes null there is nothing to
  // clear synchronously: the returned `job` is derived below to be null whenever
  // it does not match the current id, so no effect has to do it. That avoids a
  // render where the previous job is still on screen with no id to fetch it by.
  useEffect(() => {
    if (!jobId) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;
    let first = true;

    async function loop() {
      try {
        const next = await fetchJob(jobId!, controller.signal);
        failures = 0;
        setError(null);
        setJob(next);

        // Terminal means stop. Polling a finished job forever is how a one-off
        // generation turns into a tab that never idles.
        if (next.terminal) {
          stopped = true;
                    try {
            localStorage.removeItem(LAST_JOB_KEY);
          } catch {
            /* ignore */
          }
          return;
        }
      } catch (e) {
        const jobError = e as JobError;
        if (jobError.kind === "aborted") return;

        failures += 1;
        setError(jobError);

        // A 404 after the job existed is unrecoverable: the row is gone. Say so
        // rather than retrying a job that will never reappear.
        if (jobError.kind === "http" && jobError.code === "not_found") {
          stopped = true;
                    return;
        }

        // Give up on a sustained outage, so a tab pointed at a dead server stops
        // costing anything.
        if (failures >= 8) {
          stopped = true;
          setError({
            kind: "lost",
            message:
              "Lost contact with the server. Your generation may still be running — reload to check.",
          });
                    return;
        }
      }

      if (!stopped) {
        // Back off, capped. Fast enough to feel immediate, slow enough not to
        // hammer a struggling server.
        const delay = first ? 0 : Math.min(400 * 2 ** Math.min(failures, 4), 4000);
        first = false;
        timer = setTimeout(loop, delay);
      }
    }

    loop();

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [jobId, fetchJob]);

  // ---- loop 2: nudge the worker ------------------------------------------
  // Separate from the read loop on purpose: one failing must not stop the other,
  // and they have different cadences.
  useEffect(() => {
    if (!jobId || !job || job.terminal) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    async function tick() {
      if (document.visibilityState === "hidden") {
        // Browsers throttle background timers to about once a minute, which is
        // slower than some videos take to generate. Skip rather than pretend.
        // `visibilitychange` below restarts this the moment the tab comes back.
        if (!stopped) timer = setTimeout(tick, TICK_HIDDEN_MS);
        return;
      }

      try {
        await fetch("/api/worker/tick?limit=3", {
          method: "POST",
          signal: controller.signal,
          keepalive: true,
        });
      } catch {
        // A failed tick is not a user-visible error. The next one retries, and if
        // the server is genuinely down, loop 1 is already reporting that.
      }

      if (!stopped) timer = setTimeout(tick, TICK_ACTIVE_MS);
    }

    // Not immediately: the read loop has just fetched, so the job may already be
    // terminal, and ticking for a finished job is pure waste.
    timer = setTimeout(tick, 1200);

    const onVisibility = () => {
      if (document.visibilityState !== "hidden" && !stopped && timer) {
        clearTimeout(timer);
        // Fire now rather than after the remaining delay. The user came back
        // specifically to look at this.
        timer = setTimeout(tick, 200);
      }
    };

    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [jobId, job]);

  /**
   * The job currently being watched, derived.
   *
   * Not stored: a job whose id is not the one in the URL is not a job this hook
   * should report. Deriving it handles "the id went away" without an effect
   * clearing state and producing an intermediate render that still shows the old
   * job.
   */
  const currentJob = job && job.id === jobId ? job : null;

  // ---- elapsed ticker ----------------------------------------------------
  // Measured from the job's own `createdAt`, not from when this tab started
  // watching it. Reloading mid-generation therefore shows the real age of the
  // job rather than restarting the clock at zero, which is both more honest and
  // the reason no `startedAt` state is needed.
  //
  // `elapsed` is state rather than a `Date.now()` read during render: reading the
  // clock while rendering makes render impure, and a value derived that way is
  // one render behind regardless. The clock is read inside the interval callback,
  // where reading it is the whole point.
  const [now, setNow] = useState(0);
  const createdAtMs = currentJob ? Date.parse(currentJob.createdAt) : Number.NaN;

  // Both primitives rather than the object, so the dependency list is the whole
  // truth: this effect reads nothing else, and a dep it did not declare could
  // not change its behaviour.
  const tickingId = currentJob?.id ?? null;
  const isTerminal = currentJob?.terminal ?? false;

  useEffect(() => {
    if (tickingId === null || isTerminal) return;

    // A self-rescheduling timeout rather than `setInterval`: the first tick is
    // already due, and calling `tick()` directly in the effect body would be a
    // synchronous setState during render's effect. `setTimeout(tick, 0)` gets the
    // same result without the cascading render.
    let stopped = false;
    let id: ReturnType<typeof setTimeout>;
    const tick = () => {
      if (stopped) return;
      setNow(Date.now());
      id = setTimeout(tick, 250);
    };
    id = setTimeout(tick, 0);

    return () => {
      stopped = true;
      clearTimeout(id);
    };
  }, [tickingId, isTerminal]);

  const elapsed =
    currentJob && !currentJob.terminal && Number.isFinite(createdAtMs)
      ? Math.max(0, now - createdAtMs)
      : 0;

  return {
    job: currentJob,
    error: jobId ? error : null,
    loading: Boolean(jobId) && !currentJob,
    elapsed,
    jobId,
    setJob,
  };
}

const LAST_JOB_KEY = "vantage:last-job";

/**
 * Tick cadence while visible.
 *
 * 2.5s. Video jobs usually take tens of seconds to a few minutes, so this is
 * responsive without being wasteful; a tick advances at most three jobs.
 */
const TICK_ACTIVE_MS = 2500;

/** Floor for the hidden case. Browsers throttle harder than this anyway. */
const TICK_HIDDEN_MS = 15_000;
