import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { sql } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

/**
 * A real Postgres, in process, with no server.
 *
 * PGlite is Postgres compiled to WebAssembly. That matters here specifically
 * because the credit tests are about *concurrency*: `pg_advisory_xact_lock`,
 * `FOR UPDATE SKIP LOCKED`, partial indexes and CHECK constraints all behave the
 * same as they do on a real server. A mocked database would prove nothing about
 * whether two simultaneous deducts can overdraw, which is the one question these
 * tests exist to answer.
 *
 * This also means the suite runs on the free tier with no Docker and no Supabase
 * project.
 */

const MIGRATIONS_DIR = path.join(process.cwd(), "drizzle");

function readMigrations(): string[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  return files.map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
}

export interface TestDb {
  db: ReturnType<typeof drizzle<typeof schema>>;
  pglite: PGlite;
  close: () => Promise<void>;
  /** Wipe all rows. Cheaper than a fresh instance between tests. */
  truncate: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();

  for (const migration of readMigrations()) {
    await pglite.exec(migration);
  }

  // The ledger immutability trigger is hand-written SQL rather than
  // drizzle-kit output, so it is applied here too. Without it the
  // "append-only" test would pass vacuously.
  await pglite.exec(schema.ledgerImmutabilitySql);

  const db = drizzle(pglite, { schema });

  const truncate = async () => {
    await db.execute(
      sql`TRUNCATE users, generations, credit_ledger, daily_spend, rate_limits RESTART IDENTITY CASCADE`,
    );
  };

  return { db, pglite, close: () => pglite.close(), truncate };
}

/** A uuid that is stable per call site, for readable failures. */
export function testUserId(label: string): string {
  // Deterministic UUID from the label, so a failing test names its own subject.
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) >>> 0;
  }
  const hex = hash.toString(16).padStart(8, "0").repeat(4).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}