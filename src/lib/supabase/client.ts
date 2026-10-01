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

/**
 * Sign out and return home.
 *
 * Wrapped rather than inlined because `@supabase/ssr` writes the refreshed
 * session cookies, and a client-side `signOut()` that races the navigation can
 * leave a stale cookie behind -- which shows up as "signed out, but the header
 * still says otherwise" on the next load. Awaiting it before navigating avoids
 * that.
 */
export async function signOut(): Promise<void> {
  const supabase = createClient();
  if (!supabase) {
    const response = await fetch("/api/auth/local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "signout" }),
    });
    if (!response.ok) throw new Error("Could not sign out.");
    return;
  }
  await supabase.auth.signOut();
}
