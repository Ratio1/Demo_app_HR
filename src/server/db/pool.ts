/**
 * The single database entry point (spec §5).
 *
 *  - one lazy pool per process: zero idle minimum, four connections maximum, five-second
 *    acquisition timeout, bounded query and connection timeouts, all code defaults;
 *  - TLS with chain and hostname verification against the CA bundled in the image - never
 *    `rejectUnauthorized: false`, never a CA fetched at runtime;
 *  - DATE (OID 1082) stays an ISO string end to end, so no JS midnight timestamp can appear;
 *  - nothing here connects at import or build time.
 *
 * The TLS shape is the one proven by spike S0 from inside the pinned container image.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool, types, type PoolClient, type PoolConfig, type QueryResultRow } from "pg";

import { loadDbConfig, type DbConfig } from "../config/env.js";

/** PostgreSQL OID of DATE. */
export const DATE_OID = 1082;

/**
 * Path of the bundled CA, relative to the working directory: `certs/dev-ca.crt` next to the
 * server in the image, and the same path in the repository. Resolving against the working
 * directory keeps this module usable from the Next server and from the compiled CLI without
 * `__dirname` or `import.meta.url`, which differ between the two module systems.
 */
export const CA_CERTIFICATE_PATH = "certs/dev-ca.crt";

const POOL_MAX_CONNECTIONS = 4;
const POOL_MIN_CONNECTIONS = 0;
const CONNECTION_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 30_000;
const STATEMENT_TIMEOUT_MS = 10_000;

// DATE values are handed to the application exactly as PostgreSQL wrote them.
types.setTypeParser(DATE_OID, (value: string) => value);

/** The DATE parser actually registered on the driver, for tests that prove the contract. */
export function registeredDateParser(): (value: string) => unknown {
  return types.getTypeParser(DATE_OID) as (value: string) => unknown;
}

export function readCaCertificate(caPath: string = CA_CERTIFICATE_PATH): string {
  const absolute = resolve(process.cwd(), caPath);
  try {
    return readFileSync(absolute, "utf8");
  } catch {
    throw new Error(
      `TLS CA certificate not found at ${absolute}. Copy the dev CA there before starting or building (it is git-ignored).`,
    );
  }
}

export function buildPoolConfig(config: DbConfig, caPath?: string): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    ssl: {
      ca: readCaCertificate(caPath),
      rejectUnauthorized: true,
      servername: config.host,
    },
    min: POOL_MIN_CONNECTIONS,
    max: POOL_MAX_CONNECTIONS,
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: IDLE_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS,
    application_name: "demo-app-hr",
    allowExitOnIdle: true,
  };
}

/**
 * A pool that is not the process singleton: used by the CLI, which exits when its command is
 * done, and by the integration tests, which need both database roles in one process.
 */
export function createPool(config: DbConfig, caPath?: string): Pool {
  const pool = new Pool(buildPoolConfig(config, caPath));
  // An idle client that dies must not take the process with it, and must not log anything
  // that could carry a credential or a row.
  pool.on("error", () => {
    console.error("db: idle client error; the connection was discarded");
  });
  return pool;
}

let singleton: Pool | undefined;

/** The process-wide pool. Created on first use, never at import or build time. */
export function getPool(): Pool {
  singleton ??= createPool(loadDbConfig());
  return singleton;
}

export async function closePool(): Promise<void> {
  const pool = singleton;
  singleton = undefined;
  if (pool !== undefined) {
    await pool.end();
  }
}

export async function withClient<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await run(client);
  } finally {
    client.release();
  }
}

/** BEGIN/COMMIT around `run`, rolling back on any throw. */
export async function withTransaction<T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withClient(pool, async (client) => {
    await client.query("BEGIN");
    try {
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already unusable; releasing it is enough.
      }
      throw error;
    }
  });
}

/** Parameterised query helper: every call site passes values separately from the SQL. */
export async function queryRows<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, values as unknown[]);
  return result.rows;
}
