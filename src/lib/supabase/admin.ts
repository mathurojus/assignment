import "server-only";
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { env, hasSupabaseAdmin } from "@/lib/env";

/**
 * Service-role Supabase client. Bypasses RLS.
 *
 * Imported with `server-only` so that a stray client-side import is a build
 * error rather than a leaked service-role key in a browser bundle.
 */
export async function getSupabaseAdmin() {
  if (!hasSupabaseAdmin) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. It is required for the supabase storage driver.",
    );
  }
  return createSupabaseClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}