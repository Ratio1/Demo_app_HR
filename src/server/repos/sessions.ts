/**
 * Session rows (spec §6 S2).
 *
 * The clear-text token never reaches this module's SQL: callers hash it first and pass the
 * digest. A row is live when it is not revoked, its absolute deadline is in the future, and it
 * has been seen within the idle window; the two deadlines are stored, not inferred, so every
 * replica agrees without sharing memory.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "../db/pool.js";

import type { AccountRole } from "./accounts.js";

/** Idle 30 minutes, absolute 8 hours (S2). Code constants, never configuration. */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 8 * 60 * 60 * 1000;

/**
 * `last_seen_at` is refreshed at most this often, so a read-heavy page does not write a row
 * per request. Well below the idle window, so the window itself stays accurate.
 */
export const SESSION_TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionRow {
  readonly id: string;
  readonly token_sha256: string;
  readonly csrf_token: string;
  readonly account_id: string;
  readonly created_at: Date;
  readonly last_seen_at: Date;
  readonly absolute_expires_at: Date;
  readonly revoked_at: Date | null;
}

/** A session joined to the account it belongs to, as the request guard needs it. */
export interface SessionWithAccount {
  readonly session: SessionRow;
  readonly accountEmail: string;
  readonly accountRole: AccountRole;
  readonly accountActive: boolean;
}

export interface InsertSessionInput {
  readonly accountId: string;
  readonly tokenSha256: string;
  readonly csrfToken: string;
}

export async function insertSession(
  client: PoolClient,
  input: InsertSessionInput,
): Promise<SessionRow> {
  const id = randomUUID();
  const absoluteExpiresAt = new Date(Date.now() + SESSION_ABSOLUTE_MS).toISOString();
  const result = await client.query<SessionRow>(
    `INSERT INTO sessions
       (id, token_sha256, csrf_token, account_id, created_at, last_seen_at, absolute_expires_at)
     VALUES ($1, $2, $3, $4, now(), now(), $5)
     RETURNING id, token_sha256, csrf_token, account_id, created_at, last_seen_at, absolute_expires_at, revoked_at`,
    [id, input.tokenSha256, input.csrfToken, input.accountId, absoluteExpiresAt],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("session insert returned no row");
  }
  return row;
}

/**
 * Looks a session up by token digest and joins the account, so the guard re-reads `active` and
 * `role` from the database on every request (S2 "Recheck current account/role").
 */
export async function findSessionByTokenHash(
  client: PoolClient,
  tokenSha256: string,
): Promise<SessionWithAccount | null> {
  const result = await client.query<
    SessionRow & { account_email: string; account_role: AccountRole; account_active: boolean }
  >(
    `SELECT s.id, s.token_sha256, s.csrf_token, s.account_id, s.created_at, s.last_seen_at,
            s.absolute_expires_at, s.revoked_at,
            a.email AS account_email, a.role AS account_role, a.active AS account_active
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_sha256 = $1`,
    [tokenSha256],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    session: {
      id: row.id,
      token_sha256: row.token_sha256,
      csrf_token: row.csrf_token,
      account_id: row.account_id,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
      absolute_expires_at: row.absolute_expires_at,
      revoked_at: row.revoked_at,
    },
    accountEmail: row.account_email,
    accountRole: row.account_role,
    accountActive: row.account_active,
  };
}

/** Refreshes the idle clock. Called only when the row is older than the touch interval. */
export async function touchSession(client: PoolClient, sessionId: string): Promise<void> {
  await client.query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
}

export async function revokeSession(client: PoolClient, sessionId: string): Promise<number> {
  const result = await client.query(
    "UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL",
    [sessionId],
  );
  return result.rowCount ?? 0;
}

/** Revokes every live session of an account: logout-everywhere, password change, disable. */
export async function revokeAccountSessions(
  client: PoolClient,
  accountId: string,
  exceptSessionId?: string,
): Promise<number> {
  const result =
    exceptSessionId === undefined
      ? await client.query(
          "UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL",
          [accountId],
        )
      : await client.query(
          "UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL AND id <> $2",
          [accountId, exceptSessionId],
        );
  return result.rowCount ?? 0;
}

export function isSessionLive(session: SessionRow, now: Date = new Date()): boolean {
  if (session.revoked_at !== null) {
    return false;
  }
  const at = now.getTime();
  if (session.absolute_expires_at.getTime() <= at) {
    return false;
  }
  return at - session.last_seen_at.getTime() < SESSION_IDLE_MS;
}
