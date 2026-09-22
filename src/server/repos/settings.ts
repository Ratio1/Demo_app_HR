/**
 * The `settings` singleton (spec §4): the exact public origin every mutation is compared
 * against, stored in the database rather than in a fifth environment variable.
 *
 * `public_origin` is written only by `manage bootstrap` and `manage set-origin`, both of which
 * validate the value first (`validatePublicOrigin`). The absence of the row is the
 * "unprovisioned" state: the request guard then has no reference origin and fails closed.
 */
import type { PoolClient } from "../db/pool.ts";

export interface SettingsRow {
  readonly id: number;
  readonly public_origin: string;
  readonly updated_at: Date;
}

export async function getSettings(client: PoolClient): Promise<SettingsRow | null> {
  const result = await client.query<SettingsRow>(
    "SELECT id, public_origin, updated_at FROM settings WHERE id = 1",
  );
  return result.rows[0] ?? null;
}

/** The configured origin, or `null` while the application is unprovisioned. */
export async function getPublicOrigin(client: PoolClient): Promise<string | null> {
  const row = await getSettings(client);
  return row?.public_origin ?? null;
}

/**
 * Inserts or updates the singleton without a vendor UPSERT (spec §5: no `ON CONFLICT`): the
 * UPDATE runs first and the INSERT happens only if it touched nothing.
 */
export async function setPublicOrigin(client: PoolClient, origin: string): Promise<void> {
  const updated = await client.query(
    "UPDATE settings SET public_origin = $1, updated_at = now() WHERE id = 1",
    [origin],
  );
  if ((updated.rowCount ?? 0) === 0) {
    await client.query(
      "INSERT INTO settings (id, public_origin, updated_at) VALUES (1, $1, now())",
      [origin],
    );
  }
}
