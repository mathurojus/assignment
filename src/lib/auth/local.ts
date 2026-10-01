import "server-only";
import { createHash, randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { and, eq, gt, lt } from "drizzle-orm";
import { cookies } from "next/headers";
import { requireDb, schema } from "@/lib/db";
import { ensureUser } from "@/lib/users";

const scrypt = promisify(scryptCallback);
export const LOCAL_SESSION_COOKIE = "vantage_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function createLocalAccount(email: string, password: string) {
  const salt = randomBytes(16);
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return ensureUser({
    id: randomUUID(),
    email,
    passwordHash: `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`,
  });
}

export async function verifyLocalPassword(email: string, password: string) {
  const db = requireDb();
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);

  if (!user?.passwordHash) return null;
  const [, encodedSalt, encodedHash] = user.passwordHash.split("$");
  if (!encodedSalt || !encodedHash) return null;

  const expected = Buffer.from(encodedHash, "base64url");
  const actual = (await scrypt(password, Buffer.from(encodedSalt, "base64url"), expected.length)) as Buffer;
  return timingSafeEqual(actual, expected) ? user : null;
}

export async function createLocalSession(userId: string) {
  const token = randomBytes(32).toString("base64url");
  const db = requireDb();
  await db.delete(schema.authSessions).where(lt(schema.authSessions.expiresAt, new Date()));
  await db.insert(schema.authSessions).values({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  return token;
}

export async function getLocalSessionUser() {
  const token = (await cookies()).get(LOCAL_SESSION_COOKIE)?.value;
  if (!token) return null;

  const [row] = await requireDb()
    .select({ user: schema.users })
    .from(schema.authSessions)
    .innerJoin(schema.users, eq(schema.users.id, schema.authSessions.userId))
    .where(
      and(
        eq(schema.authSessions.tokenHash, hashToken(token)),
        gt(schema.authSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  const user = row?.user;
  return user
    ? {
        id: user.id,
        email: user.email,
        name: user.name,
        avatarUrl: user.avatarUrl,
        isAdmin: user.isAdmin,
        creditsMicro: user.credits,
      }
    : null;
}

export async function deleteLocalSession(token: string | undefined) {
  if (!token) return;
  await requireDb()
    .delete(schema.authSessions)
    .where(eq(schema.authSessions.tokenHash, hashToken(token)));
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
