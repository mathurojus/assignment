import { createBrowserClient } from "@supabase/ssr";
import { env } from "@/lib/env";

export function isSupabaseConfigured(): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Browser-side Supabase client.
 *
 * Returns null when Supabase is not configured, which callers treat as "auth is
 * off". That is the whole point of the local-first design: the app boots and
 * every page renders, and auth-dependent routes report that they need setup
 * rather than the whole app 500ing.
 */
export function createClient() {
  if (!isSupabaseConfigured()) return null;
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!);
}