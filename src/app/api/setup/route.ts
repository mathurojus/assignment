import { env, envProblems, features, hasDatabase, hasOpenRouterKey } from "@/lib/env";

/**
 * What this machine has configured, and what is therefore missing.
 *
 * This route exists so `npm run dev` is useful before anything is configured.
 * The alternative -- crashing on import, or returning a generic 500 -- makes a
 * new user hunt through logs for a variable name. Here the UI gets a checklist.
 *
 * It reports presence, never values. An endpoint that echoes configuration is
 * an endpoint someone will paste into a bug report.
 */
export const dynamic = "force-dynamic";

export interface SetupCheck {
  key: string;
  label: string;
  ok: boolean;
  /** Why it matters, and what breaks without it. */
  required: boolean;
  blocking: string | null;
  /** Where to get it. */
  where: string;
  /** The exact env var, when one maps to this capability. */
  variable: string | null;
}

const CHECKS: SetupCheck[] = [
  {
    key: "openrouter",
    label: "OpenRouter API key",
    ok: hasOpenRouterKey,
    required: true,
    blocking: hasOpenRouterKey
      ? null
      : "Generation and prompt enhancement are disabled. The model list still loads, because that endpoint needs no key.",
    where: "openrouter.ai/keys",
    variable: "OPENROUTER_API_KEY",
  },
  {
    key: "database",
    label: "Local demo database",
    ok: hasDatabase,
    required: true,
    blocking: hasDatabase
      ? null
      : "Nothing can be stored, so nothing can be generated. Sign-in, gallery and credits all depend on it.",
    where: "Stored in .data/vantage",
    variable: null,
  },
  {
    key: "auth",
    label: "Basic authentication",
    ok: true,
    required: false,
    blocking: null,
    where: "Email and password accounts use the local demo database",
    variable: null,
  },
  {
    key: "storage",
    label: "Media storage",
    // The local driver needs no credentials, so it counts as satisfied unless
    // Supabase was explicitly selected without a service key.
    ok: features.storage,
    required: false,
    blocking: features.storage
      ? null
      : "STORAGE_DRIVER is 'supabase' but SUPABASE_SERVICE_ROLE_KEY is not set.",
    where: "Supabase dashboard > Project Settings > API > service_role",
    variable: "SUPABASE_SERVICE_ROLE_KEY",
  },
  {
    key: "publicMedia",
    label: "Publicly reachable media",
    ok: features.publicMedia,
    required: false,
    blocking: features.publicMedia
      ? null
      : "Image-to-video is disabled. OpenRouter has to fetch your start frame, and it cannot reach localhost.",
    where: "Set PUBLIC_MEDIA_BASE_URL, or switch STORAGE_DRIVER to supabase",
    variable: "PUBLIC_MEDIA_BASE_URL",
  },
];

export async function GET() {
  const missing = CHECKS.filter((c) => c.required && !c.ok);

  return Response.json(
    {
      // The one number the UI needs to decide whether to show the banner.
      ready: missing.length === 0,
      checks: CHECKS,
      problems: envProblems,
      features,
      storageDriver: env.STORAGE_DRIVER,
    },
    {
      headers: {
        // Never cached: the answer changes the moment someone adds a key.
        "cache-control": "no-store",
      },
    },
  );
}
