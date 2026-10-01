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
  const user = data.user;
  // Bind `user` first, then guard on it. Checking `data.user?.email` and reading
  // `user.email` afterwards leaves the compiler unable to tell the object is
  // non-null, because the narrowing was applied to the optional chain rather
  // than to a name it can follow.
  if (error || !user?.email) return null;

  const { ensureUser } = await import("@/lib/users");

  /**
   * Read one string out of the auth provider's metadata.
   *
   * `user_metadata` is `UserMetadata`, whose index signature is `any`, so a raw
   * read is `any` and leaks out of the function as `string | undefined`. Only a
   * string is acceptable here -- a number or object in a display name would be
   * rendered as `[object Object]`.
   */
  const meta = (key: string): string | null => {
    const value = user.user_metadata?.[key];
    return typeof value === "string" && value.trim() ? value : null;
  };

  // `ensureUser` returns the stored row, whose columns are nullable in the
  // schema. `SessionUser` normalises those to `| null`, because a component
  // asking "is there a name?" needs a real null rather than `undefined`, and
  // mixing the two is what produces `undefined` rendering as the text "null".
  const row = await ensureUser({
    id: user.id,
    email: user.email,
    name: meta("name") ?? meta("full_name"),
    avatarUrl: meta("avatar_url"),
  });

  return {
    id: user.id,
    email: user.email,
    name: row.name ?? null,
    avatarUrl: row.avatarUrl ?? null,
    isAdmin: row.isAdmin,
  };
}