import { readdir, readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
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

const sql = neon(databaseUrl);
await sql.query(
  `CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  [],
);

const appliedRows = await sql.query("SELECT name FROM schema_migrations", []);
const applied = new Set(appliedRows.map((row) => row.name));
const migrationsDirectory = fileURLToPath(
  new URL("../db/migrations/", import.meta.url),
);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((file) => extname(file) === ".sql")
  .sort((left, right) => left.localeCompare(right));

for (const migrationFile of migrationFiles) {
  if (applied.has(migrationFile)) continue;

  const migrationUrl = new URL(
    `../db/migrations/${migrationFile}`,
    import.meta.url,
  );
  const migrationSql = await readFile(fileURLToPath(migrationUrl), "utf8");
  const statements = splitSqlStatements(migrationSql);
  if (statements.length === 0) {
    throw new Error(`Migration ${migrationFile} is empty.`);
  }

  await sql.transaction(
    (transaction) => [
      ...statements.map((statement) => transaction.query(statement, [])),
      transaction.query(
        "INSERT INTO schema_migrations (name) VALUES ($1)",
        [migrationFile],
      ),
    ],
    { isolationLevel: "Serializable" },
  );

  console.log(
    `Applied ${basename(migrationFile)} (${statements.length} statements).`,
  );
}

if (migrationFiles.every((file) => applied.has(file))) {
  console.log("Database schema is already up to date.");
}

function splitSqlStatements(source) {
  const statements = [];
  let current = "";
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      current += character;
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      current += character;
      if (character === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      current += character;
      if ((quote === "'" || quote === '"') && character === quote) {
        if (next === quote) {
          current += next;
          index += 1;
        } else {
          quote = null;
        }
      } else if (quote.startsWith("$") && source.startsWith(quote, index)) {
        current += source.slice(index + 1, index + quote.length);
        index += quote.length - 1;
        quote = null;
      }
      continue;
    }

    if (character === "-" && next === "-") {
      current += character + next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      current += character + next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      current += character;
      continue;
    }
    if (character === "$") {
      const dollarQuote = source.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (dollarQuote) {
        quote = dollarQuote;
        current += dollarQuote;
        index += dollarQuote.length - 1;
        continue;
      }
    }
    if (character === ";") {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
      continue;
    }
    current += character;
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  if (quote || blockComment) {
    throw new Error("Migration contains an unterminated SQL literal or comment.");
  }
  return statements;
}
