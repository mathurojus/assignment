import { defineConfig } from "drizzle-kit";

/**
 * Migrations are generated from src/lib/db/schema.ts with no database
 * connection required, so `npm run db:generate` works offline.
 */
export default defineConfig({
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://localhost:5432/vantage",
  },
  strict: true,
  verbose: true,
});