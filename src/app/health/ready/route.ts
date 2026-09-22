/**
 * `GET /health/ready` (spec §8): the database is reachable, the schema is the one this build
 * expects, and the application has been provisioned.
 *
 * Three checks, one round trip each, all through the runtime role's own grants:
 *   1. `SELECT 1`                          - the pool can reach the database over TLS;
 *   2. `schema_migrations` contains `0001_init` - migrations have been applied;
 *   3. `settings` has its singleton row    - `manage bootstrap` has run.
 *
 * Any failure is `503` with the **same** body shape and no internals: no SQLSTATE, no host, no
 * role, no migration list, no error text (§8, S6).
 */
import { getPool, withClient } from "../../../server/db/pool.ts";
import { jsonResponse } from "../../../server/http/response.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The migration this build requires. A newer database is fine; an older one is not ready. */
export const REQUIRED_MIGRATION_ID = "0001_init";

export async function readiness(pool = getPool()): Promise<{ ready: boolean }> {
  try {
    return await withClient(pool, async (client) => {
      await client.query("SELECT 1");
      const migrated = await client.query<{ one: number }>(
        "SELECT 1 AS one FROM schema_migrations WHERE id = $1",
        [REQUIRED_MIGRATION_ID],
      );
      if (migrated.rowCount !== 1) {
        return { ready: false };
      }
      const provisioned = await client.query<{ one: number }>(
        "SELECT 1 AS one FROM settings WHERE id = 1",
      );
      return { ready: provisioned.rowCount === 1 };
    });
  } catch {
    return { ready: false };
  }
}

export async function GET(): Promise<Response> {
  const { ready } = await readiness();
  return ready ? jsonResponse(200, { status: "ready" }) : jsonResponse(503, { status: "not_ready" });
}
