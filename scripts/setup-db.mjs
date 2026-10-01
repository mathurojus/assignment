import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadEnvConfig } from "@next/env";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import { migrate as migratePostgres } from "drizzle-orm/postgres-js/migrator";

loadEnvConfig(process.cwd());

if (process.env.DATABASE_URL) {
  const client = postgres(process.env.DATABASE_URL, { max: 1, prepare: false });
  try {
    await migratePostgres(drizzlePostgres(client), { migrationsFolder: resolve("drizzle") });
  } finally {
    await client.end();
  }
  process.exit(0);
}

const dataDir = resolve(process.env.VANTAGE_DB_PATH ?? ".data/vantage");
await mkdir(dirname(dataDir), { recursive: true });

const client = new PGlite(dataDir);
await migratePglite(drizzlePglite(client), { migrationsFolder: resolve("drizzle") });
await client.close();
