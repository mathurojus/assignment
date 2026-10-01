import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import {
  createLocalAccount,
  createLocalSession,
  deleteLocalSession,
  LOCAL_SESSION_COOKIE,
  verifyLocalPassword,
} from "@/lib/auth/local";

const credentials = z.object({
  action: z.enum(["signup", "signin"]),
  email: z.string().trim().email().max(254).transform((email) => email.toLowerCase()),
  password: z.string().min(8).max(128),
});

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: "Invalid request origin." }, { status: 403 });
  }

  let body: unknown;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 2048) throw new Error();
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof body === "object" && body !== null && "action" in body && body.action === "signout") {
    await deleteLocalSession(request.cookies.get(LOCAL_SESSION_COOKIE)?.value);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(LOCAL_SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: request.nextUrl.protocol === "https:", path: "/", maxAge: 0 });
    return response;
  }

  const parsed = credentials.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter a valid email and a password of at least 8 characters." }, { status: 400 });
  }

  const { action, email, password } = parsed.data;
  try {
    const user = action === "signup"
      ? await createLocalAccount(email, password)
      : await verifyLocalPassword(email, password);

    if (!user) {
      return NextResponse.json({ error: "That email and password do not match." }, { status: 401 });
    }

    const token = await createLocalSession(user.id);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(LOCAL_SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });
    return response;
  } catch (error) {
    console.error("[auth/local] account request failed", error);
    return NextResponse.json(
      { error: action === "signup" ? "Could not create account. That email may already be registered." : "Could not sign in. Try again." },
      { status: action === "signup" ? 409 : 500 },
    );
  }
}
