import { Pool, type QueryResult, type QueryResultRow } from "pg";

import { getRequiredEnv } from "@/lib/env";

declare global {
  var __dbPool: Pool | undefined;
}

function createPool() {
  return new Pool({
    connectionString: getRequiredEnv("DATABASE_URL"),
  });
}

export function getDb() {
  if (!globalThis.__dbPool) {
    globalThis.__dbPool = createPool();
  }

  return globalThis.__dbPool;
}

export async function dbQuery<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
) {
  return getDb().query<T>(text, values);
}

export async function withTransaction<T>(
  run: (query: <R extends QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<QueryResult<R>>) => Promise<T>,
) {
  const client = await getDb().connect();

  try {
    await client.query("begin");
    const result = await run((text, values = []) => client.query(text, values));
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
