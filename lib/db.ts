import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { required } from "./config";
import * as schema from "./schema";

function connect() {
  return drizzle(new Pool({
    connectionString: required("DATABASE_URL"),
    max: 4,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    options: "-c statement_timeout=15000",
  }), { schema });
}

let connection: ReturnType<typeof connect> | undefined;
export function db() {
  return connection ??= connect();
}

export type Transaction = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];
