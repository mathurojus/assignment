import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Session refresh.
 *
 * Named `proxy.ts` rather than `middleware.ts`: Next.js 16 deprecated the middleware
 * convention and renamed it to proxy, because the word "middleware" collides with
 * the Express sense of the term and invites the wrong assumptions about where this
 * code runs. Functionality is identical -- only the filename and the export name
 * changed. See `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`.
 *
 * This file exists for one reason no other file in the app can do: Supabase's
 * access token is a JWT with a short lifetime, and the only place a *response* can
 * legitimately write a cookie during a page load is here. A Server Component can
 * read cookies but not set them, which means without this step the refreshed token
 * is discarded and the user is silently signed out roughly an hour in, regardless
 * of how long they intended to stay.
 *
 * The side effect is that auth is refreshed on every navigation, which is cheap --
 * `getUser()` here does a local JWT check and only reaches the network when the
 * token is actually expired.
 */
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Unconfigured is not an error. The app is designed to boot without auth so that
  // `/setup` and the model list are reachable on a fresh clone; a proxy that threw
  // here would take the entire site down instead.
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Deliberately not `getSession()`. That reads a JWT claim without checking the
  // signature and will happily treat a token signed with a long-dead key as valid.
  // `getUser()` asks Supabase whether the token is real.
  //
  // The result is deliberately ignored. This call exists for its side effect --
  // refreshing an expiring token into a Set-Cookie -- not to gate the request.
  // Whether a page requires a session is a decision each page makes, because it
  // has to render as UI ("sign in to see your gallery") rather than as a
  // redirect bounce, and because a redirect here would turn a 401 into HTML for
  // the API routes that call `getSessionUser()` themselves.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  /**
   * Everything except static assets and the API.
   *
   * The API routes call `getSessionUser()` themselves and need to answer 401 as
   * JSON, so redirecting them here would turn an auth failure into an HTML page
   * that the client cannot parse.
   */
  matcher: [
    /*
     * Everything except:
     *  - /api/*            (route handlers manage their own auth and error shape)
     *  - /_next/static, /_next/image  (build output)
     *  - anything with a file extension (favicon.ico, robots.txt, sw.js)
     */
    "/((?!api/|_next/static|_next/image|favicon.ico|.*\\.[\\w]+$).*)",
  ],
};