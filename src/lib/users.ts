import { sql } from "drizzle-orm";
import { requireDb, schema } from "./db";
import { env } from "@/lib/env";

/**
 * User provisioning.
 *
 * `ensureUser` is idempotent and safe to call on every authenticated request.
 * It is the single place that creates a row and grants signup credits, so the
 * grant cannot happen twice or be skipped when someone signs in through a
 * different path (OAuth callback vs magic link vs password).
 */

export interface EnsureUserInput {
  id: string;
  email: string;
  name?: string | null;
  avatarUrl?: string | null;
  passwordHash?: string | null;
}

export interface EnsureUserResult {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
  credits: number;
  isAdmin: boolean;
  /** True when this call is what created the user. */
  created: boolean;
}

const ADMIN_SET = new Set(env.ADMIN_EMAILS.map((e) => e.toLowerCase()));

export async function ensureUser(input: EnsureUserInput): Promise<EnsureUserResult> {
  const db = requireDb();
  const startingCredits = Math.round(env.FREE_STARTING_CREDITS * 10_000);

  return db.transaction(async (tx) => {
    // Serialise per user, so two concurrent first-requests cannot both decide
    // the row does not exist and both insert.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.id}))`);

    const [existing] = await tx
      .select()
      .from(schema.users)
      .where(sql`${schema.users.id} = ${input.id}::uuid`)
      .limit(1);

    if (existing) {
      // Keep the denormalised profile fields fresh from the auth provider
      // without touching the balance.
      const [refreshed] = await tx
        .update(schema.users)
        .set({
          name: input.name ?? existing.name,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl,
          email: input.email,
          updatedAt: new Date(),
        })
        .where(sql`${schema.users.id} = ${input.id}::uuid`)
        .returning();

      return { ...(refreshed ?? existing), created: false };
    }

    const isAdmin = ADMIN_SET.has(input.email.toLowerCase());

    const [inserted] = await tx
      .insert(schema.users)
      .values({
        id: input.id,
        email: input.email,
        passwordHash: input.passwordHash ?? null,
        name: input.name ?? null,
        avatarUrl: input.avatarUrl ?? null,
        credits: startingCredits,
        isAdmin,
      })
      .returning();

    if (startingCredits > 0) {
      await tx.insert(schema.creditLedger).values({
        userId: input.id,
        delta: startingCredits,
        reason: "signup_grant",
        balanceAfter: inserted.credits,
        metadata: { source: "first_auth", credits: env.FREE_STARTING_CREDITS },
      });
    }

    return { ...inserted, created: true };
  });
}

export async function getUserById(id: string) {
  const db = requireDb();
  const [user] = await db
    .select()
    .from(schema.users)
    .where(sql`${schema.users.id} = ${id}::uuid`)
    .limit(1);
  return user ?? null;
}
