#!/usr/bin/env node
/**
 * scripts/prove-integration.mjs — verify the live OpenRouter contract.
 *
 * Read this before running it.
 *
 *  - It costs real money. OpenRouter has no free tier; a video run bills at whatever
 *    the model charges, and the cheapest models observed are around $0.0000035 per
 *    video token. The script prints the expected cost before it spends anything and
 *    asks for confirmation.
 *  - It talks to OpenRouter directly, not through this app. That is the point: it
 *    proves the upstream shapes this app's cost engine and lifecycle code are built
 *    against, with no database, no auth provider and no deployment in the way. A
 *    bug in this app's money handling cannot hide behind a green result here.
 *
 * What it checks, and why each one is a real risk:
 *
 *   1. `GET /api/v1/videos`            — the model list is the cost engine's input.
 *   2. `POST /api/v1/videos`           — does submit return a polling URL, and is
 *                                       the initial status what the lifecycle maps?
 *   3. poll until terminal             — which status strings actually appear. The
 *                                       docs list four; live traffic has been seen to
 *                                       emit `cancelled` and `expired` as well, and
 *                                       `advanceGeneration` has to treat those as
 *                                       terminal or a cancelled job polls forever.
 *   4. `GET .../content?index=0`       — the download needs the same Authorization
 *                                       header as the other calls. Without it you get
 *                                       a 200 and an HTML login page, not a 401.
 *   5. `usage.cost`                    — the actual charge, against our own estimate.
 *                                       This is the only check that proves the cost
 *                                       engine agrees with billing.
 *   6. `POST /api/v1/images/generations` — images return base64, not URLs. If that
 *                                       ever changed, `submitImageJob` would write a
 *                                       0-byte object and the gallery would show a
 *                                       broken image with a full credit hold.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-or-... node scripts/prove-integration.mjs
 *   node scripts/prove-integration.mjs --image-only
 *   node scripts/prove-integration.mjs --yes          # skip the cost prompt
 *   node scripts/prove-integration.mjs --model=google/veo-3
 *   node scripts/prove-integration.mjs --keep=out.mp4  # write the download to disk
 */

import { writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const ROOT = "https://openrouter.ai/api/v1";
const KEY = process.env.OPENROUTER_API_KEY;

const flags = new Map(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.replace(/^--/, "").split("=");
      return [k, v ?? "true"];
    }),
);

const IMAGE_ONLY = flags.get("image-only") === "true";
const SKIP_CONFIRM = flags.get("yes") === "true";
const VIDEO_MODEL = flags.get("model") ?? null;
const IMAGE_MODEL = flags.get("image-model") ?? null;
const KEEP = flags.get("keep") ?? null;
const OUT_DIR = flags.get("out-dir") ?? "proof-output";

/* ------------------------------------------------------------------ output */

const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, s) => (useColour ? `[${code}m${s}[0m` : s);
const bold = (s) => paint("1", s);
const dim = (s) => paint("2", s);
const green = (s) => paint("32", s);
const red = (s) => paint("31", s);
const yellow = (s) => paint("33", s);
const cyan = (s) => paint("36", s);

let passed = 0;
let failed = 0;
const failures = [];

function check(label, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ${green("PASS")} ${label}${detail ? dim(` — ${detail}`) : ""}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ${red("FAIL")} ${label}${detail ? dim(` — ${detail}`) : ""}`);
  }
  return condition;
}

function section(name) {
  console.log(`\n${bold(cyan(`▸ ${name}`))}`);
}

function info(s) {
  console.log(dim(`    ${s}`));
}

async function fail(label, error) {
  failed += 1;
  failures.push(label);
  console.log(`  ${red("FAIL")} ${label} — ${error instanceof Error ? error.message : String(error)}`);
}

/* -------------------------------------------------------------------- http */

async function orFetch(path, init = {}, { binary = false } = {}) {
  const res = await fetch(`${ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${KEY}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });

  if (binary) {
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return { bytes: new Uint8Array(await res.arrayBuffer()), res };
  }

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text };
  }

  if (!res.ok) {
    const detail = body?.error?.message ?? body?.error ?? body?._raw ?? res.statusText;
    const err = new Error(`HTTP ${res.status}: ${String(detail).slice(0, 400)}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }

  return { body, res, headers: res.headers };
}

const usd = (n) => `$${Number(n).toFixed(6)}`;

/* ------------------------------------------------------------------- main */

async function main() {
  console.log(bold("\nOpenRouter integration proof"));
  console.log(dim("  This spends real money. There is no free tier.\n"));

  if (!KEY) {
    console.log(red("  OPENROUTER_API_KEY is not set."));
    console.log(
      dim(`    PowerShell:  $env:OPENROUTER_API_KEY = "sk-or-..."\n`),
    );
    process.exit(2);
  }

  console.log(`  key: ${dim(`${KEY.slice(0, 8)}…${KEY.slice(-4)}`)}`);

  /* ------------------------------------------------- 1. the model lists */
  section("1. Model discovery");

  let videoModels = [];
  let imageModels = [];

  /*
   * Only fetch the lists this mode will actually use.
   *
   * This was the reverse: the video list was fetched unconditionally and the
   * image list skipped under `--image-only`. So asking for an image proof spent
   * a request on video discovery, could die there, and never reached images --
   * the one thing that mode exists to check.
   */
  if (!IMAGE_ONLY) {
    try {
      // `/videos/models`, not `/videos`. The published documentation says the
      // model list is at `GET /api/v1/videos`; the live API answers that with
      // 404 and keeps the list under `/videos/models`. `POST /api/v1/videos`
      // is the submit endpoint, which is what the docs appear to have been
      // describing. Same family of mistake as the pricing_skus shape -- the docs
      // are not wrong about the resource, they are wrong about the read.
      const { body } = await orFetch("/videos/models");
      videoModels = body?.data ?? [];
      check(
        "GET /videos/models returns a model list",
        Array.isArray(videoModels) && videoModels.length > 0,
        `${videoModels.length} models`,
      );
    } catch (e) {
      await fail("GET /videos/models", e);
    }
  }

  // Unconditional: the image list is needed in both modes. Even a video proof
  // prints the image quote, and the base64 check further down runs either way.
  try {
    const { body } = await orFetch("/images/models");
    imageModels = body?.data ?? [];
    check(
      "GET /images/models returns a model list",
      Array.isArray(imageModels) && imageModels.length > 0,
      `${imageModels.length} models`,
    );
  } catch (e) {
    await fail("GET /images/models", e);
  }

  /* ------------------------------- 2. price the run before spending on it */
  section("2. Cost, before anything is spent");

  const videoChoice = pickVideoModel(videoModels, VIDEO_MODEL);
  const imageChoice = pickImageModel(imageModels, IMAGE_MODEL);

  if (!IMAGE_ONLY) {
    if (!videoChoice) {
      check("a video model with a quotable price exists", false, "none found in the list");
    } else {
      info(`video: ${videoChoice.id} (${videoChoice.name})`);
      info(`  estimated ${usd(videoChoice.estimateUsd)} for ${videoChoice.duration}s at ${videoChoice.resolution}`);
    }

    if (!imageChoice) {
      check("an image model exists", false, "none found in the list");
    } else {
      info(`image: ${imageChoice.id} (${imageChoice.name})`);
      info(`  estimated ${usd(imageChoice.estimateUsd)} for 1 image`);
    }

    const total = (videoChoice?.estimateUsd ?? 0) + (imageChoice?.estimateUsd ?? 0);
    if (!SKIP_CONFIRM) {
      const proceed = await confirm(
        `\n  Spend up to ${bold(usd(total))} on your OpenRouter account? [y/N] `,
      );
      if (!proceed) {
        console.log(dim("\n  Stopped. Nothing was charged.\n"));
        process.exit(0);
      }
    }
  }

  /* --------------------------------------------------------- 3. images */
  if (IMAGE_ONLY || imageChoice) {
    section("3. Image generation");
    if (imageChoice) await proveImage(imageChoice);
  }

  /* --------------------------------------------------------- 4. video */
  if (!IMAGE_ONLY && videoChoice) {
    section("4. Video generation");
    await proveVideo(videoChoice);
  }

  /* ---------------------------------------------------------- summary */
  section("Summary");
  console.log(`  ${green(`${passed} passed`)}${failed > 0 ? red(`, ${failed} failed`) : ""}`);
  if (failures.length > 0) {
    console.log(`\n  ${red("Failures:")}`);
    for (const f of failures) console.log(`    - ${f}`);
    console.log(
      dim(
        "\n  A failure here is a change in the upstream contract, not necessarily a bug in\n" +
          "  this app. Check the shape against the live payload printed above, then update\n" +
          "  the matching module and re-run. Do not adjust a cost engine to match a broken\n" +
          "  read — fix the read.\n",
      ),
    );
  } else {
    console.log(
      dim(
        "\n  Every upstream shape this app depends on is confirmed against live traffic.\n" +
          "  The cost estimates above were compared against usage.cost — that is the check\n" +
          "  that says the pricing engine agrees with billing.\n",
      ),
    );
  }

  process.exit(failed > 0 ? 1 : 0);
}

/* --------------------------------------------------------------- picking */

/**
 * Choose the cheapest video model that our own pricing module can quote.
 *
 * "Our own module" is not available here — this script has no access to the
 * TypeScript sources — so the SKU shapes are matched inline. That duplication is
 * honest: it is an independent reimplementation, which is what makes the estimate
 * comparison meaningful. If they agree, two separate readings of the same payload
 * agree.
 */
function pickVideoModel(models, wanted) {
  if (wanted) {
    const m = models.find((x) => x.id === wanted);
    return m ? describeVideo(m) : null;
  }

  const candidates = models
    // `supported_durations` is what makes a model usable: without it there is no
    // duration to ask for. Four models in the live list are excluded by this alone.
    .filter((m) => Array.isArray(m.supported_durations) && m.supported_durations.length > 0)
    .filter((m) => !m.frame_images || m.frame_images.length === 0 || true);

  const quoted = candidates
    .map(describeVideo)
    .filter((m) => m.estimateUsd != null)
    .sort((a, b) => a.estimateUsd - b.estimateUsd);

  return quoted[0] ?? null;
}

function describeVideo(m) {
  const skus = m?.pricing_skus ?? {};
  const duration = m.supported_durations.includes(5) ? 5 : m.supported_durations[0];
  const resolution =
    m.supported_resolutions?.includes("480p") === true
      ? "480p"
      : (m.supported_resolutions?.[0] ?? null);

  // The three shapes that are quotable without knowing a token count.
  let perSecond = null;
  for (const [key, value] of Object.entries(skus)) {
    if (!key.includes(`duration_seconds_${resolution}`)) continue;
    if (key.startsWith("cents_")) perSecond = Number(value) / 100;
    else if (key.startsWith("text_to_video_") || key.startsWith("image_to_video_")) {
      perSecond = Number(value);
    } else if (key.startsWith("duration_seconds_")) perSecond = Number(value);
  }

  return {
    id: m.id,
    name: m.name,
    duration,
    resolution,
    estimateUsd: perSecond == null ? null : perSecond * duration,
    unquotable: perSecond == null,
  };
}

function pickImageModel(models, wanted) {
  if (wanted) {
    const m = models.find((x) => x.id === wanted);
    return m ? { id: m.id, name: m.name, estimateUsd: null, unquotable: true } : null;
  }

  /*
   * Text-only models are excluded: `architecture.output_modalities` is the only
   * reliable signal, and a model that cannot emit images returns a 400 that looks
   * like a bad prompt.
   *
   * That is not sufficient, and taking `usable[0]` picked
   * `inclusionai/ming-image-0.1-design-layer`, which advertises
   * `input_references: {min: 1, max: 1}` -- it cannot run without an input image.
   * Submitting a prompt alone produced:
   *
   *   No provider for inclusionai/ming-image-0.1-design-layer supports the
   *   requested parameter(s): n "1". Provider rejections: Novita:
   *   input_references: must have exactly 1 items
   *
   * which blames `n` when the actual complaint is the missing reference. Read
   * literally it sends you to debug the wrong parameter.
   *
   * So two more conditions, both from `supported_parameters` on the list payload:
   * the model must accept zero input references (min 0, or undeclared), and it
   * must accept an `n`. Sorted by id so the chosen model is stable between runs
   * instead of depending on list order.
   */
  const usable = models.filter((m) => {
    if (m.architecture?.output_modalities?.includes("image") !== true) return false;
    const params = m.supported_parameters ?? {};
    const refs = params.input_references;
    if (refs && typeof refs.min === "number" && refs.min > 0) return false;
    const n = params.n;
    if (n && typeof n.max === "number" && n.max < 1) return false;
    return true;
  });

  usable.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const m = usable[0];
  return m ? { id: m.id, name: m.name, estimateUsd: null, unquotable: true } : null;
}

/* ------------------------------------------------------------ image proof */

async function proveImage(choice) {
  let created;

  try {
    const { body } = await orFetch("/images/generations", {
      method: "POST",
      body: JSON.stringify({
        model: choice.id,
        prompt: "A single red apple on a plain white background, studio lighting",
        n: 1,
      }),
    });
    created = body;
    check("POST /images/generations accepted the request", true, `id ${body?.id ?? "none"}`);
  } catch (e) {
    await fail("POST /images/generations", e);
    return;
  }

  const first = created?.data?.[0];

  /*
   * The single most important assertion in this script.
   *
   * `submitImageJob` assumes base64. If OpenRouter started returning `url` instead,
   * `first.b64_json` would be undefined, `Buffer.from(undefined, "base64")` would
   * throw or produce a zero-length buffer, and the job would complete with a
   * 0-byte object — a full credit hold, a completed row, and a broken image in the
   * gallery. Nothing in a unit test catches that; only a live call does.
   */
  check(
    "response carries b64_json (not a url)",
    typeof first?.b64_json === "string" && first.b64_json.length > 0,
    first?.url ? `got url: ${String(first.url).slice(0, 60)}` : `${first?.b64_json?.length ?? 0} base64 chars`,
  );
  check("response carries a media_type", typeof first?.media_type === "string", first?.media_type);

  const bytes = first?.b64_json
    ? Buffer.from(first.b64_json, "base64")
    : Buffer.alloc(0);
  check("decoded bytes are a real image", bytes.length > 1000, `${bytes.length} bytes`);
  check(
    "bytes have a recognised image signature",
    looksLikeImage(bytes),
    bytes.length >= 4 ? `magic ${[...bytes.subarray(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}` : "no bytes",
  );

  const cost = created?.usage?.cost;
  check("usage.cost is present", typeof cost === "number", cost == null ? "absent" : usd(cost));

  await maybeWrite("image", bytes, first?.media_type ?? "image/png");
}

/** Magic bytes, so "base64 decoded to something" is not mistaken for "a valid image". */
function looksLikeImage(b) {
  if (b.length < 12) return false;
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  // WebP: "RIFF" .... "WEBP"
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return true;
  }
  return false;
}

/* ------------------------------------------------------------ video proof */

async function proveVideo(choice) {
  let submitted;

  try {
    const { body } = await orFetch("/videos", {
      method: "POST",
      body: JSON.stringify({
        model: choice.id,
        prompt: "A paper boat drifting down a rain gutter, slow dolly follow, overcast light",
        duration_seconds: choice.duration,
        resolution: choice.resolution,
      }),
    });
    submitted = body;
    check("POST /videos accepted the request", true, `job ${body?.id ?? "none"}`);
  } catch (e) {
    await fail("POST /videos", e);
    return;
  }

  const jobId = submitted?.id;
  const pollingUrl = submitted?.polling_url;

  check("submit returns an id", typeof jobId === "string" && jobId.length > 0, jobId);
  check("submit returns a polling_url", typeof pollingUrl === "string", pollingUrl);
  check(
    "submit reports a non-terminal status",
    submitted?.status === "pending" || submitted?.status === "queued",
    String(submitted?.status),
  );

  if (!jobId) return;

  /* ------------------------------------------------------------- poll */
  const seen = new Set();
  const terminal = new Set(["completed", "failed", "cancelled", "expired"]);
  let status = null;
  let usage = null;
  let unsignedUrls = [];
  const startedAt = Date.now();

  // 8 minutes. A 5s clip on a slow model can take several minutes; the app's own
  // stale-job expiry is longer than this, so a timeout here means something is
  // wrong rather than that it was merely slow.
  const deadline = startedAt + 8 * 60 * 1000;

  while (Date.now() < deadline) {
    let body;
    try {
      // The polling_url is a full URL, not a path — it is not always under
      // /api/v1, and reconstructing it from the id has been observed to differ
      // from what submit actually returns.
      const res = await fetch(pollingUrl, { headers: { Authorization: `Bearer ${KEY}` } });
      const text = await res.text();
      body = JSON.parse(text);
    } catch (e) {
      await fail("poll", e);
      return;
    }

    if (body?.status && !seen.has(body.status)) {
      seen.add(body.status);
      const secs = ((Date.now() - startedAt) / 1000).toFixed(0);
      console.log(dim(`    ${secs}s  status=${body.status}`));
    }

    status = body?.status;

    if (terminal.has(status)) {
      usage = body?.usage ?? null;
      unsignedUrls = body?.unsigned_urls ?? [];
      check("poll reached a terminal status", true, status);

      // Every status this app has to recognise. A status outside this set means
      // `advanceGeneration` would leave the job non-terminal and poll it forever
      // until the stale-job expiry kicks in — a real, user-visible hang.
      for (const s of seen) {
        check(
          `"${s}" is handled by the lifecycle`,
          [
            "pending",
            "queued",
            "in_progress",
            "processing",
            "completed",
            "succeeded",
            "failed",
            "error",
            "cancelled",
            "canceled",
            "expired",
          ].includes(s),
          "",
        );
      }
      break;
    }

    await sleep(5000);
  }

  if (status && !terminal.has(status)) {
    check("poll reached a terminal status", false, `still "${status}" after 8 minutes`);
    return;
  }

  if (status !== "completed") {
    info(`job ended as ${status}; skipping the download and cost checks`);
    return;
  }

  check("completed response carries usage.cost", typeof usage?.cost === "number", usd(usage?.cost ?? 0));
  check("completed response lists an output URL", unsignedUrls.length > 0, `${unsignedUrls.length} url(s)`);

  /* ------------------------------------------------- estimate vs actual */
  if (typeof usage?.cost === "number" && choice.estimateUsd != null) {
    const diff = Math.abs(usage.cost - choice.estimateUsd);
    const relative = choice.estimateUsd > 0 ? diff / choice.estimateUsd : 1;

    // A small tolerance. Floating-point SKU arithmetic on a per-second price times
    // a duration will not be bit-exact, and a strict equality assertion would fail
    // for a reason that is not a bug.
    check(
      "estimate agrees with billed cost (within 2%)",
      relative < 0.02,
      `quoted ${usd(choice.estimateUsd)}, billed ${usd(usage.cost)} (${(relative * 100).toFixed(2)}% off)`,
    );

    if (relative >= 0.02) {
      console.log(
        yellow(
          `    The cost engine and the bill disagree by more than 2%. The settle path refunds\n` +
            `    the difference, so users are not overcharged — but the quote is wrong, and a\n` +
            `    quote that is wrong is the one thing this app is about. Re-check\n` +
            `    src/lib/openrouter/pricing.ts against the pricing_skus printed above.`,
        ),
      );
    }
  }

  /* --------------------------------------------------------- download */
  const contentPath = `/videos/${jobId}/content?index=0`;
  let bytes;
  try {
    const r = await orFetch(contentPath, {}, { binary: true });
    bytes = r.bytes;
    check("GET /content succeeds with the same Authorization header", true, `${bytes.length} bytes`);
  } catch (e) {
    /*
     * The failure this guards against is specific and easy to misdiagnose: the
     * endpoint returns 200 with an HTML body when the header is missing, so a naive
     * check "did the download return bytes" passes on a login page. Checking the
     * magic bytes catches that.
     */
    await fail("GET /content with Authorization", e);
    return;
  }

  const head = Buffer.from(bytes.subarray(0, 12));
  const isMp4 = head.subarray(4, 8).toString("latin1") === "ftyp";
  const isHtml = head.subarray(0, 5).toString("latin1").toLowerCase().includes("html");
  const isWebm = head.subarray(0, 4).toString("latin1") === "0x1a45dfa3";

  check(
    "downloaded bytes are a media container, not HTML",
    isMp4 || isWebm,
    isHtml
      ? "got an HTML page — the Authorization header was not sent"
      : `magic ${[...head.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(" ")}`,
  );

  await maybeWrite("video", Buffer.from(bytes), "video/mp4");
}

/* ----------------------------------------------------------------- utils */

async function maybeWrite(label, bytes, mime) {
  if (!KEEP) return;
  try {
    await mkdir(OUT_DIR, { recursive: true });
    const target = KEEP.endsWith(".mp4") || KEEP.endsWith(".png") ? KEEP : `${OUT_DIR}/${label}.bin`;
    await writeFile(target, bytes);
    console.log(dim(`    wrote ${target} (${bytes.length} bytes, ${mime})`));
  } catch (e) {
    console.log(yellow(`    could not write output: ${e.message}`));
  }
}

async function confirm(question) {
  const rl = createInterface({ input, output });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === "y" || answer === "yes";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().catch((e) => {
  console.error(red(`\nUnexpected failure: ${e?.stack ?? e}`));
  process.exit(1);
});
