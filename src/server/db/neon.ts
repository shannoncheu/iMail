import "server-only";

import { neon } from "@neondatabase/serverless";

export type DatabaseRow = Record<string, unknown>;

export type DatabaseQuery = <Row extends DatabaseRow = DatabaseRow>(
  statement: string,
  parameters?: readonly unknown[],
) => Promise<Row[]>;

export function createNeonQuery(databaseUrl: string): DatabaseQuery {
  const normalizedUrl = databaseUrl.trim();
  if (!normalizedUrl) {
    throw new Error("A PostgreSQL DATABASE_URL is required.");
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(normalizedUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(parsedUrl.protocol)) {
    throw new Error("DATABASE_URL must use the postgres or postgresql scheme.");
  }

  const sql = neon(normalizedUrl);

  return async <Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ) => {
    const rows = await sql.query(statement, [...parameters]);
    return rows as Row[];
  };
}
