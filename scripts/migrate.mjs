import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL?.trim();

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run database migrations.");
}

let parsedDatabaseUrl;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
}
if (!['postgres:', 'postgresql:'].includes(parsedDatabaseUrl.protocol)) {
  throw new Error("DATABASE_URL must be a PostgreSQL connection URL.");
}

const migrationUrl = new URL(
  "../db/migrations/0001_auth_foundation.sql",
  import.meta.url,
);
const migrationSql = await readFile(fileURLToPath(migrationUrl), "utf8");

// This migration intentionally contains no procedural blocks or semicolons in
// string literals. Keeping one statement per entry lets Neon's HTTP driver run
// the whole migration as one transaction without enabling unsafe interpolation.
const statements = migrationSql
  .split(";")
  .map((statement) => statement.trim())
  .filter(Boolean);

if (statements.length === 0) {
  throw new Error("The auth foundation migration is empty.");
}

const sql = neon(databaseUrl);

await sql.transaction(
  (transaction) =>
    statements.map((statement) => transaction.query(statement, [])),
  { isolationLevel: "Serializable" },
);

console.log(`Applied auth foundation migration (${statements.length} statements).`);
