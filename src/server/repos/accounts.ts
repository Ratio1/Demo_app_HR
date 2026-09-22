/**
 * Account rows: the only module that writes `accounts` (spec §5, §6 S1/S4/S6).
 *
 * Every statement is parameterised. Emails are lowercased before they touch SQL, matching the
 * `accounts_email_lowercase` CHECK, so "A@example.test" and "a@example.test" are one account.
 *
 * `disableAccount` lives here rather than in a service because the last-active-HR-admin
 * protection must hold for *every* caller - the `manage disable-user` command today, the
 * deactivation cascade of slice 2 tomorrow - and the only way to guarantee that is one
 * function, taking the caller's transaction, that does the re-count itself (spec §2
 * "Protect last active HR admin, including CLI/concurrent changes").
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "../db/pool.js";

export const ACCOUNT_ROLES = ["hr_admin", "employee"] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Five failures lock the account for fifteen minutes (S6, access matrix §2.1). */
export const MAX_FAILED_LOGINS = 5;
export const LOCKOUT_MINUTES = 15;

export interface AccountRow {
  readonly id: string;
  readonly email: string;
  readonly password_hash: string;
  readonly role: AccountRole;
  readonly active: boolean;
  readonly failed_logins: number;
  readonly locked_until: Date | null;
  readonly password_changed_at: Date;
  readonly version: number;
  readonly created_at: Date;
}

/** The email form that is stored and compared. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export class LastAdminError extends Error {
  constructor() {
    super("refusing to disable the last active HR administrator");
    this.name = "LastAdminError";
  }
}

const ACCOUNT_COLUMNS =
  "id, email, password_hash, role, active, failed_logins, locked_until, password_changed_at, version, created_at";

export async function findAccountByEmail(
  client: PoolClient,
  email: string,
): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE email = $1`,
    [normalizeEmail(email)],
  );
  return result.rows[0] ?? null;
}

export async function findAccountById(
  client: PoolClient,
  id: string,
): Promise<AccountRow | null> {
  const result = await client.query<AccountRow>(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function countAccounts(client: PoolClient): Promise<number> {
  const result = await client.query<{ total: string }>("SELECT count(*) AS total FROM accounts");
  return Number(result.rows[0]?.total ?? "0");
}

export async function countActiveAdmins(client: PoolClient): Promise<number> {
  const result = await client.query<{ total: string }>(
    "SELECT count(*) AS total FROM accounts WHERE role = 'hr_admin' AND active = true",
  );
  return Number(result.rows[0]?.total ?? "0");
}

export interface CreateAccountInput {
  readonly email: string;
  readonly passwordHash: string;
  readonly role: AccountRole;
}

/** Inserts an account. A duplicate email raises the unique-violation the caller maps to 400. */
export async function insertAccount(
  client: PoolClient,
  input: CreateAccountInput,
): Promise<AccountRow> {
  const id = randomUUID();
  const result = await client.query<AccountRow>(
    `INSERT INTO accounts (id, email, password_hash, role, active, failed_logins, password_changed_at, version, created_at)
     VALUES ($1, $2, $3, $4, true, 0, now(), 1, now())
     RETURNING ${ACCOUNT_COLUMNS}`,
    [id, normalizeEmail(input.email), input.passwordHash, input.role],
  );
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("account insert returned no row");
  }
  return row;
}

/**
 * Sets a new hash, clears the lockout counters and bumps the version, in one statement.
 * Session revocation is the caller's job, in the same transaction.
 */
export async function updatePasswordHash(
  client: PoolClient,
  accountId: string,
  passwordHash: string,
): Promise<void> {
  await client.query(
    `UPDATE accounts
        SET password_hash = $2,
            password_changed_at = now(),
            failed_logins = 0,
            locked_until = NULL,
            version = version + 1
      WHERE id = $1`,
    [accountId, passwordHash],
  );
}

export interface FailedLoginState {
  readonly failedLogins: number;
  readonly lockedUntil: Date | null;
}

/**
 * Records one failed login **atomically**, so two concurrent attempts at four failures cannot
 * both land on five without locking:
 *
 *  - an expired lock resets the counter to one rather than leaving it at five for ever;
 *  - reaching the threshold sets `locked_until` in the same statement that increments.
 */
export async function recordFailedLogin(
  client: PoolClient,
  accountId: string,
): Promise<FailedLoginState> {
  // The lock expiry is computed here and passed as a parameter rather than built with a
  // vendor interval function, so the statement stays portable (spec §5).
  const lockUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString();
  const result = await client.query<{ failed_logins: number; locked_until: Date | null }>(
    `UPDATE accounts
        SET failed_logins =
              CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                   ELSE failed_logins + 1 END,
            locked_until =
              CASE WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                              ELSE failed_logins + 1 END) >= $2
                   THEN $3
                   WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
                   ELSE locked_until END
      WHERE id = $1
      RETURNING failed_logins, locked_until`,
    [accountId, MAX_FAILED_LOGINS, lockUntil],
  );
  const row = result.rows[0];
  return {
    failedLogins: row?.failed_logins ?? 0,
    lockedUntil: row?.locked_until ?? null,
  };
}

/** Clears the failure counters after a successful login. */
export async function clearFailedLogins(client: PoolClient, accountId: string): Promise<void> {
  await client.query(
    `UPDATE accounts SET failed_logins = 0, locked_until = NULL
      WHERE id = $1 AND (failed_logins <> 0 OR locked_until IS NOT NULL)`,
    [accountId],
  );
}

/** True while `locked_until` is in the future. */
export function isLocked(account: AccountRow, now: Date = new Date()): boolean {
  return account.locked_until !== null && account.locked_until.getTime() > now.getTime();
}

/**
 * Serializes every admin-affecting change on the `settings` singleton (D8: row locks instead
 * of the portable anchors). Callers take this lock **before** the write whose effect on the
 * active-admin count has to be counted exactly once.
 *
 * Before bootstrap there is no settings row; there are also no accounts to protect, so the
 * absence is not an error.
 */
export async function lockAdminGuard(client: PoolClient): Promise<void> {
  await client.query("SELECT id FROM settings WHERE id = 1 FOR UPDATE");
}

export interface DisableAccountResult {
  readonly account: AccountRow;
  readonly revokedSessions: number;
}

/**
 * Deactivates an account and revokes its sessions inside the caller's transaction, refusing
 * with `LastAdminError` if that would leave no active HR administrator.
 *
 * The count is taken **after** the update and inside the same transaction, behind the
 * `settings` row lock, so two administrators disabling each other concurrently cannot both
 * observe a healthy count and both commit.
 */
export async function disableAccount(
  client: PoolClient,
  accountId: string,
): Promise<DisableAccountResult> {
  await lockAdminGuard(client);

  const updated = await client.query<AccountRow>(
    `UPDATE accounts
        SET active = false, version = version + 1
      WHERE id = $1
      RETURNING ${ACCOUNT_COLUMNS}`,
    [accountId],
  );
  const account = updated.rows[0];
  if (account === undefined) {
    throw new Error("account not found");
  }

  const remainingAdmins = await countActiveAdmins(client);
  if (remainingAdmins === 0) {
    throw new LastAdminError();
  }

  const revoked = await client.query(
    "UPDATE sessions SET revoked_at = now() WHERE account_id = $1 AND revoked_at IS NULL",
    [accountId],
  );

  return { account, revokedSessions: revoked.rowCount ?? 0 };
}
