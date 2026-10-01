import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env, hasDatabase } from "@/lib/env";
import * as schema from "./schema";

/**
 * The concrete database type.
 *
 * Named explicitly rather than inferred from `db`, because `db` is memoised on
 * `globalThis` and a `NonNullable<typeof db>` alias makes the type circular:
 * the global is annotated with `Database`, `Database` is derived from `db`,
 * and `db` reads the global.
 */
export type Database = PostgresJsDatabase<typeof schema>;

/**
 * A single lazily-created connection, memoised on globalThis.
 *
 * Next's dev server re-evaluates modules on every hot reload. Without this,
 * each reload opens another pool until Postgres refuses connections. The global
 * cache is the standard workaround.
 *
 * Typed as `unknown` and cast on read, for the same circularity reason above.
 */
const globalForDb = globalThis as unknown as { __vantageDb?: unknown };

function create(): Database {
  const client = postgres(env.DATABASE_URL!, {
    // Supabase's pooler caps concurrent connections per client. Keep well under.
    max: env.STORAGE_DRIVER === "supabase" ? 5 : 10,
    idle_timeout: 20,
    connect_timeout: 15,
    // Keep the session cheap: we do our own timestamptz math.
    prepare: false,
    onnotice: () => {},
  });
  return drizzle(client, { schema, casing: "snake_case" });
}

export const db: Database | null = hasDatabase
  ? ((globalForDb.__vantageDb as Database | undefined) ??= create())
  : null;

export { schema };
export * from "./schema";

/**
 * Routes that need the database call this instead of touching `db` directly, so
 * a missing DATABASE_URL produces a message that says what to do rather than a
 * TypeError about a null connection.
 */
export function requireDb(): Database {
  if (!db) {
    throw new DatabaseUnavailableError();
  }
  return db;
}

export class DatabaseUnavailableError extends Error {
  readonly code = "DATABASE_UNAVAILABLE";
  constructor() {
    super(
      "DATABASE_URL is not set, so there is nowhere to store generations. " +
        "Set it to your Supabase connection string (use the pooler, not the " +
        "direct connection) and run `npm run db:push`.",
    );
    this.name = "DatabaseUnavailableError";
  }
}

export function isDatabaseUnavailable(e: unknown): e is DatabaseUnavailableError {
  return e instanceof DatabaseUnavailableError;
}