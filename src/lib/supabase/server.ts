import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { env } from "@/lib/env";

export function isSupabaseConfigured(): boolean {
  return Boolean(env.NEXT_PUBLIC_SUPABASE_URL && env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

/**
 * Request-scoped Supabase client that reads the session from cookies.
 *
 * Never cache this across requests. It is bound to the request's cookies, and
 * reusing it would leak one user's session into another user's response.
 */
export async function createClient() {
  if (!isSupabaseConfigured()) return null;

  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      // Server Components cannot set cookies, so writes are collected and
      // flushed by middleware.ts. See the note there.
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component. Middleware handles the refresh.
        }
      },
    },
  });
}

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

/**
 * The signed-in user, or null.
 *
 * A user row is created on first sight. That means the signup credit grant and
 * the admin flag are applied the moment someone first authenticates, whether
 * that was via the OAuth callback, a magic link, or a password login.
 */
export async function getSessionUser(): Promise<SessionUser | null> {
  const supabase = await createClient();
  if (!supabase) return null;

  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user?.email) return null;

  const user = data.user;
  const { ensureUser } = await import("@/lib/users");
  const row = await ensureUser({
    id: user.id,
    email: user.email,
    name: (user.user_metadata?.["name"] as string | undefined) ?? user.user_metadata?.["full_name"] ?? null,
    avatarUrl: (user.user_metadata?.["avatar_url"] as string | undefined) ?? null,
  });

  return {
    id: user.id,
    email: user.email,
    name: row.name,
    avatarUrl: row.avatarUrl,
    isAdmin: row.isAdmin,
  };
}