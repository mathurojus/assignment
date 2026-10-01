/**
 * Environment parsing.
 *
 * Design decision: **a missing variable never crashes boot.**
 *
 * The usual `env.ts` throws at import time if anything is unset, which turns
 * "I haven't pasted my key yet" into "the whole app is a 500 on every route,
 * including the login page". That is a bad first-run experience and it hides
 * which of twenty variables is actually missing.
 *
 * So instead: every variable is validated and defaulted here, problems are
 * collected as readable strings rather than thrown, and code that genuinely
 * needs a value calls `require()` and gets a message that names the variable.
 * `GET /api/setup` surfaces the same list, which is what powers the setup
 * banner in the UI.
 */
import { z } from "zod"

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )

/** Accepts "25", "2.50", "$2.50". Empty or unparseable falls back. */
const money = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (!v || !v.trim()) return fallback
      const n = Number(v.replace(/[$,\s]/g, ""))
      return Number.isFinite(n) ? n : fallback
    })

const url = z
  .string()
  .optional()
  .transform((v) => {
    if (!v || !v.trim()) return undefined
    try {
      return new URL(v).toString().replace(/\/$/, "")
    } catch {
      return undefined
    }
  })

const int = (fallback: number) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (!v || !v.trim()) return fallback
      const n = Number.parseInt(v, 10)
      return Number.isFinite(n) ? n : fallback
    })

const schema = z.object({
  // OpenRouter
  OPENROUTER_API_KEY: z.string().trim().optional().transform((v) => v || undefined),

  // Optional hosted PostgreSQL for serverless deployments; local defaults to PGlite.
  DATABASE_URL: z.string().trim().optional().transform((v) => v || undefined),

  // Supabase (optional: local fallbacks exist for both auth and storage)
  NEXT_PUBLIC_SUPABASE_URL: url,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),

  // App origin
  NEXT_PUBLIC_APP_URL: url,
  NEXT_PUBLIC_SITE_URL: url,

  // Storage
  STORAGE_DRIVER: z.enum(["local", "supabase"]).default("local"),
  STORAGE_BUCKET: z.string().trim().default("vantage-media"),
  PUBLIC_MEDIA_BASE_URL: url,

  // Credits
  FREE_STARTING_CREDITS: int(200),
  GLOBAL_DAILY_SPEND_CAP_USD: money(25),
  CREDIT_RESERVE_CEILING_USD: money(2.0),

  // Worker
  WORKER_SECRET: z.string().trim().optional().transform((v) => v || undefined),
  // Vercel Cron. When set on a Vercel project, the platform sends
  // `Authorization: Bearer $CRON_SECRET` on every cron invocation, which is what
  // lets the tick route stay closed while still being driven by cron. Separate
  // from WORKER_SECRET because the local worker and the browser heartbeat send
  // that one instead.
  CRON_SECRET: z.string().trim().optional().transform((v) => v || undefined),
  WORKER_BATCH_SIZE: int(5),
  JOB_MAX_AGE_MINUTES: int(30),

  // Rate limiting
  RATE_LIMIT_JOBS_PER_HOUR: int(10),
  MAX_CONCURRENT_JOBS_PER_USER: int(2),

  // Uploads
  //
  // 4 MB, not 32, because Vercel rejects a request body over 4.5 MB before this
  // code runs — so a higher number here is a limit the app advertises and the
  // platform silently overrides with an unexplained 413. Raise it only when
  // self-hosting behind something with a larger ceiling.
  MAX_UPLOAD_MB: int(4),

  // Enhancer
  //
  // Defaults to a `:free` model rather than the more capable
  // `openai/gpt-4o-mini`, because the brief is explicit that everything runs on
  // free tiers and enhancement is the one place that can honour it: rewriting a
  // prompt is a text task, and OpenRouter's free tier covers text (50 requests a
  // day on free models, confirmed live against `GET /api/v1/key`).
  //
  // The trade is rewrite quality, and it is a real one -- set this to
  // `openai/gpt-4o-mini` if you are already paying for image generation and want
  // the better prose. Enhancement is optional either way: a failure returns the
  // user's original prompt, it never blocks a generation.
  //
  // Any `:free` model works; the catalogue currently lists 20. This one was
  // chosen because it answered a real request (see the README's verification
  // table), not because it is the best of the twenty.
  ENHANCER_MODEL: z.string().trim().default("google/gemma-4-31b-it:free"),

  // Webhooks
  OPENROUTER_WEBHOOK_SECRET: z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined),

  // Admin
  ADMIN_EMAILS: csv,
})

export type Env = z.output<typeof schema>

function load(): { env: Env; problems: string[] } {
  const raw: Record<string, string | undefined> = {}
  for (const key of Object.keys(schema.shape)) {
    raw[key] = process.env[key]
  }

  const parsed = schema.safeParse(raw)
  if (parsed.success) {
    return { env: parsed.data, problems: [] }
  }

  // A bad value should not take the app down. Fall back to defaults and
  // report what was wrong, so the user can see it in the setup banner.
  const fallback = schema.safeParse({})
  const problems = parsed.error.issues.map(
    (issue) =>
      `${issue.path.join(".") || "(root)"}: ${issue.message}` +
      (raw[issue.path.join(".")] ? ` (got "${String(raw[issue.path.join(".")]).slice(0, 40)}")` : ""),
  )
  return { env: (fallback.success ? fallback.data : {}) as Env, problems }
}

const loaded = load()

/** Parsed, defaulted environment. Never throws. */
export const env: Env = loaded.env

/** Human-readable env problems, safe to show in the UI. */
export const envProblems: readonly string[] = loaded.problems

/**
 * Assert a variable is present, or throw an error that names it.
 * Used by the code paths that genuinely cannot work without the value.
 */
export function requireEnv<K extends keyof Env>(
  key: K,
  opts?: { hint?: string },
): NonNullable<Env[K]> {
  const value = env[key]
  if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
    const hint = opts?.hint ? ` ${opts.hint}` : ""
    throw new Error(`Missing required environment variable ${String(key)}.${hint}`)
  }
  return value as NonNullable<Env[K]>
}

export const hasOpenRouterKey = Boolean(env.OPENROUTER_API_KEY)
export const hasDatabase = true
export const hasSupabase = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY)
export const hasSupabaseAdmin = Boolean(env.SUPABASE_SERVICE_ROLE_KEY)

/** Everything needed to actually generate media. */
export const canGenerate = hasOpenRouterKey && hasDatabase

/** Feature flags, computed once so the UI and the API agree. */
export const features = {
  openrouter: hasOpenRouterKey,
  database: hasDatabase,
  auth: true,
  storage: env.STORAGE_DRIVER === "supabase" ? hasSupabaseAdmin : true,
  /** OpenRouter's servers must be able to fetch our start frames. */
  publicMedia: Boolean(env.PUBLIC_MEDIA_BASE_URL),
  webhooks: Boolean(env.OPENROUTER_WEBHOOK_SECRET),
  imageToVideo: Boolean(env.PUBLIC_MEDIA_BASE_URL) || env.STORAGE_DRIVER === "supabase",
} as const
