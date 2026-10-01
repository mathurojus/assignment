/**
 * Display formatting.
 *
 * Kept separate from `lib/pricing.ts` on purpose. That module is the cost
 * engine: it decides what a job costs, and its arithmetic is covered by tests
 * against live OpenRouter payloads. This module only decides how a number looks.
 * Mixing the two means a rounding change for aesthetics can quietly move money.
 */

/**
 * Credits, from micro-credits.
 *
 * Micro-credits are integers so the ledger never loses precision. Credits are
 * micro / 10_000 because one credit is $0.01 and there are 1_000_000 micro-USD
 * per dollar.
 *
 * The division is by 10_000 and not by 1_000_000 because the caller already holds
 * micro-*credits*, not micro-USD. Getting that wrong is a factor of a hundred,
 * which is the kind of bug that reads as a generous price rather than as a bug.
 */
export function formatCredits(microCredits: number): string {
  const credits = microCredits / 10_000;
  // Balances below a hundredth of a credit are almost certainly a rounding
  // artefact from a very small upstream charge. Show a dash rather than $0.00.
  if (Math.abs(credits) < 0.01) return "0";

  return credits.toLocaleString("en-US", {
    minimumFractionDigits: Number.isInteger(credits) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

/**
 * US dollars, from micro-USD.
 *
 * A minimum of two decimals always. A price shown as "$0.3" reads as a typo, and
 * on a cost screen it undermines confidence in every other number next to it.
 */
export function formatUsd(microUsd: number | null | undefined): string {
  if (microUsd === null || microUsd === undefined || !Number.isFinite(microUsd)) {
    return "—";
  }
  const usd = microUsd / 1_000_000;
  if (usd === 0) return "$0.00";
  return `$${usd.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: usd < 0.01 ? 4 : 2,
  })}`;
}

/** The same, from a plain USD float rather than micro-units. */
export function usdFromFloat(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "—";
  return formatUsd(Math.round(usd * 1_000_000));
}

/** Bytes as a short human string. Video files are large enough to need it. */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Seconds as `0:05` / `1:23`. Used for clip length. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) {
    return "—";
  }
  const whole = Math.max(0, Math.round(seconds));
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** An ISO timestamp as a short local date, for gallery tiles. */
export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return "—";
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  });
}

/** Milliseconds as "1.2s" / "340ms". Used for the generation timer. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return formatDuration(seconds);
}

/**
 * How long until `iso` becomes actionable again, in words.
 *
 * For rate limits and retry hints, where a number of seconds is not something a
 * person can act on.
 */
export function humanizeWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "now";
  if (seconds < 60) return `in ${Math.ceil(seconds)}s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.ceil(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}