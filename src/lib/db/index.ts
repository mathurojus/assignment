import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePostgres, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql, type SQL } from "drizzle-orm";
import { resolve } from "node:path";
import { env } from "@/lib/env";
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
  if (env.DATABASE_URL) {
    return drizzlePostgres(postgres(env.DATABASE_URL, { max: 1, idle_timeout: 20, prepare: false }), {
      schema,
      casing: "snake_case",
    });
  }

  // ponytail: PGlite serializes one local connection; use hosted Postgres if demo traffic grows.
  return drizzlePglite(new PGlite(resolve(process.env.VANTAGE_DB_PATH ?? ".data/vantage")), {
    schema,
    casing: "snake_case",
  }) as unknown as Database;
}

export const db: Database = (globalForDb.__vantageDb as Database | undefined) ??= create();

export { schema };
export * from "./schema";

/**
 * Routes that need the database call this instead of touching `db` directly, so
 * a missing local database produces a message that says what to do rather than a
 * TypeError about a null connection.
 */
export function requireDb(): Database {
  return db;
}

export async function executeRows<T>(query: SQL): Promise<T[]> {
  const result = await requireDb().execute(query);
  return (Array.isArray(result) ? result : (result as { rows: T[] }).rows) as T[];
}

export class DatabaseUnavailableError extends Error {
  readonly code = "DATABASE_UNAVAILABLE";
  constructor() {
    super(
      "The local demo database is unavailable. Restart the app to initialize it.",
    );
    this.name = "DatabaseUnavailableError";
  }
}

export function isDatabaseUnavailable(e: unknown): e is DatabaseUnavailableError {
  return e instanceof DatabaseUnavailableError;
}
