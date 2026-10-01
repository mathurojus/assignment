#!/usr/bin/env node
/**
 * scripts/worker.mjs — drive generation jobs without a browser open.
 *
 * The free-tier deployment story has one sharp edge worth being explicit about.
 * A job advances when someone calls `POST /api/worker/tick`, and the three
 * drivers for that are:
 *
 *   1. this script, on a loop
 *   2. a heartbeat from the browser, which the Studio already sends
 *   3. a Vercel Cron schedule
 *
 * Vercel Hobby allows exactly one cron invocation per day, which is useless for a
 * job that takes ninety seconds. So on Hobby, either this script runs somewhere
 * else, or a tab stays open. That is not a design flaw being hidden — it is the
 * free tier's actual limit, and the reason the Studio shows live progress at all.
 *
 * Usage:
 *   node scripts/worker.mjs                        # against http://localhost:3000
 *   node scripts/worker.mjs https://my.app.vercel.app
 *   WORKER_SECRET=... node scripts/worker.mjs      # authenticate to the tick route
 *   node scripts/worker.mjs --once                 # single tick, then exit
 *   node scripts/worker.mjs --interval=5000
 *
 * Run it with `node`, not `bun`: it is plain ESM with no dependencies so that it
 * works on a machine that has never run this project's install step.
 */

const args = process.argv.slice(2);
const flags = new Map(
  args.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "true"];
  }),
);
const positional = args.filter((a) => !a.startsWith("--"));

const BASE = (
  positional[0] ??
  process.env.APP_URL ??
  process.env.VERCEL_URL ??
  "http://localhost:3000"
).replace(/\/+$/, "");

const INTERVAL = Number(flags.get("interval") ?? process.env.WORKER_INTERVAL_MS ?? 4000);
const ONCE = flags.get("once") === "true";
const SECRET = process.env.WORKER_SECRET;

/**
 * The secret is a *server-side* concern, and sending it from a CLI is a
 * deliberate choice with a real downside: it means the secret exists in a shell
 * history and possibly in a process listing. The reason it is still here is that
 * the tick route is the only write path a job has, and a public one would let
 * anyone drive someone else's generations. Operators who do not want a secret in
 * their shell can leave `WORKER_SECRET` unset and rely on the fact that the route
 * also accepts requests from a signed-in session.
 */
/*
 * `Authorization: Bearer`, because that is what the route reads — and it reads
 * nothing else. `timingSafeEqual` is used server-side, which is the right call
 * for a shared secret, but it means the token must match byte for byte: a stray
 * trailing newline from a shell heredoc is the single most common reason this
 * script reports 401 against a secret that looks correct.
 */
const headers = SECRET ? { authorization: `Bearer ${SECRET}` } : {};

let running = true;
process.on("SIGINT", () => {
  running = false;
  console.log("\nstopping");
});
process.on("SIGTERM", () => {
  running = false;
});

let ticks = 0;
let advanced = 0;
let failures = 0;
let warnedAboutAuth = false;

async function tick() {
  try {
    // `limit` is a query param on the route, not a body field — it reads the URL
    // and ignores the body entirely.
    const limit = Number(process.env.WORKER_BATCH_SIZE ?? 5);
    const res = await fetch(`${BASE}/api/worker/tick?limit=${limit}`, {
      method: "POST",
      headers,
    });

    ticks += 1;

    if (!res.ok) {
      failures += 1;
      // 401 here almost always means the secret is missing or wrong, and retrying
      // on a loop would fill the output with identical lines forever. Say it once,
      // loudly, and stop.
      if (res.status === 401 || res.status === 403) {
        console.error(
          `tick refused (${res.status}). Set WORKER_SECRET to match the value in .env.local exactly — a trailing newline or a different name is the only thing that produces this.`,
        );
        running = false;
        return;
      }
      console.error(`tick failed: ${res.status} ${res.statusText}`);
      return;
    }

    /*
     * The route answers with a bare object, not the `ok()` envelope the other
     * endpoints use. Reading `progressed` directly rather than defensively
     * probing `data.advanced` keeps this in step with the one shape it actually
     * returns, so a rename in the route breaks this loudly instead of silently
     * reporting zero jobs advanced forever.
     */
    const body = await res.json();
    const touched = Number(body?.progressed ?? 0);
    advanced += touched;

    if (touched > 0) {
      const detail = (body.jobs ?? [])
        .map((j) => `${j.result}${j.error ? ` (${j.error})` : ""}`)
        .join(", ");
      console.log(`${new Date().toISOString()} advanced ${touched} — ${detail}`);
    }

    // One-time notice rather than a per-tick line: a deployed instance with no
    // WORKER_SECRET has a publicly writable job driver, and that is worth exactly
    // one line in the log.
    if (body?.authenticated === false && !warnedAboutAuth) {
      warnedAboutAuth = true;
      console.warn(
        "WARNING: WORKER_SECRET is unset, so /api/worker/tick is open to anyone. Set it before deploying.",
      );
    }
  } catch (error) {
    failures += 1;
    console.error(
      `tick could not reach ${BASE}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * A backoff, but only for consecutive failures.
 *
 * The first failure is usually a deploy in progress or a cold serverless start, and
 * hammering through it makes the outage longer. A successful tick resets the delay
 * to the base interval, so a transient blip costs one slow tick rather than a
 * permanently slow worker.
 */
let consecutiveFailures = 0;

async function loop() {
  console.log(
    `worker -> ${BASE} every ${INTERVAL}ms${SECRET ? " (authenticated)" : " (unauthenticated)"}${
      ONCE ? " — single tick" : ""
    }`,
  );

  while (running) {
    const before = failures;
    await tick();

    if (ONCE) break;

    if (failures > before) {
      consecutiveFailures += 1;
    } else {
      consecutiveFailures = 0;
    }

    // Capped at 30s: past that point a longer wait only means a slower recovery
    // from a transient problem, because the route itself is what is failing.
    const wait = Math.min(INTERVAL * 2 ** consecutiveFailures, 30_000);
    await new Promise((r) => setTimeout(r, wait));
  }

  console.log(`\n${ticks} ticks, ${advanced} jobs advanced, ${failures} failures`);
  process.exit(failures > 0 && !ONCE ? 1 : 0);
}

loop();
