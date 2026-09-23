/**
 * Login, logout and change-password (spec §6 S1, S2, S6, S7).
 *
 * Two rules shape this module:
 *
 *  1. **Argon2 never runs inside a transaction.** Hashing takes tens of milliseconds and queues
 *     behind the one-at-a-time semaphore; holding one of four pooled connections for that long
 *     would turn a login burst into a database outage. Every hash happens between
 *     transactions, and the state changes that depend on its result are committed afterwards.
 *  2. **The audit row commits with the state change it describes** (S7): the failure counter
 *     and its `login/denied` row, the new session and its `login/ok` row, the new hash and its
 *     `password.change/ok` row are each one transaction.
 *
 * Every failure - unknown email, wrong password, inactive account, malformed stored hash -
 * returns the same `invalid_credentials` result after the same Argon2 work (S1).
 */
import type { Pool } from "../db/pool.ts";

import { withClient, withTransaction } from "../db/pool.ts";
import {
  clearFailedLogins,
  findAccountByEmail,
  findAccountById,
  isLocked,
  recordFailedLogin,
  updatePasswordHash,
  type AccountRole,
} from "../repos/accounts.ts";
import { insertAuditEvent } from "../repos/audit.ts";
import { revokeAccountSessions, revokeSession } from "../repos/sessions.ts";
import { dummyVerify, hashPassword, verifyPassword, checkPasswordPolicy } from "../auth/password.ts";
import { issueSession, resolvePrincipal, type Principal } from "../auth/session.ts";

export interface LoginInput {
  readonly email: string;
  readonly password: string;
  readonly correlationId: string;
  /** A session token the request already carried, revoked on success (rotation). */
  readonly previousToken?: string | null;
}

export type LoginResult =
  | {
      readonly kind: "ok";
      readonly token: string;
      readonly accountId: string;
      readonly role: AccountRole;
    }
  | { readonly kind: "invalid_credentials" }
  | { readonly kind: "locked"; readonly retryAfterSeconds: number };

function secondsUntil(deadline: Date): number {
  return Math.max(1, Math.ceil((deadline.getTime() - Date.now()) / 1000));
}

export async function login(pool: Pool, input: LoginInput): Promise<LoginResult> {
  const account = await withClient(pool, async (client) =>
    findAccountByEmail(client, input.email),
  );

  // Unknown or inactive: the same Argon2 work, the same answer, no row written. An inactive
  // account is not disclosed as such (S1 "generic failures").
  if (account === null || !account.active) {
    await dummyVerify(input.password);
    return { kind: "invalid_credentials" };
  }

  if (isLocked(account)) {
    const lockedUntil = account.locked_until as Date;
    await withTransaction(pool, async (client) => {
      await insertAuditEvent(client, {
        actorAccountId: account.id,
        objectType: "account",
        objectId: account.id,
        action: "login",
        outcome: "denied",
        correlationId: input.correlationId,
      });
    });
    return { kind: "locked", retryAfterSeconds: secondsUntil(lockedUntil) };
  }

  const verified = await verifyPassword(account.password_hash, input.password);

  if (!verified) {
    const state = await withTransaction(pool, async (client) => {
      const failure = await recordFailedLogin(client, account.id);
      await insertAuditEvent(client, {
        actorAccountId: account.id,
        objectType: "account",
        objectId: account.id,
        action: "login",
        outcome: "denied",
        correlationId: input.correlationId,
      });
      return failure;
    });
    if (state.lockedUntil !== null && state.lockedUntil.getTime() > Date.now()) {
      return { kind: "locked", retryAfterSeconds: secondsUntil(state.lockedUntil) };
    }
    return { kind: "invalid_credentials" };
  }

  return withTransaction(pool, async (client): Promise<LoginResult> => {
    // Re-read inside the transaction: the account may have been disabled while we hashed.
    const fresh = await findAccountById(client, account.id);
    if (fresh === null || !fresh.active) {
      return { kind: "invalid_credentials" } as const;
    }
    // ... or locked: a guess that queued behind the Argon2 semaphore while parallel failures
    // reached the lockout threshold must not log in (and clear the lock) just because it
    // verified after the lock was written (slice 5 R, m1). Same answer and same audit row as
    // the pre-hash locked path above.
    if (isLocked(fresh)) {
      await insertAuditEvent(client, {
        actorAccountId: fresh.id,
        objectType: "account",
        objectId: fresh.id,
        action: "login",
        outcome: "denied",
        correlationId: input.correlationId,
      });
      return { kind: "locked", retryAfterSeconds: secondsUntil(fresh.locked_until as Date) } as const;
    }
    await clearFailedLogins(client, fresh.id);
    if (input.previousToken !== null && input.previousToken !== undefined && input.previousToken !== "") {
      const previous = await resolvePrincipal(client, input.previousToken);
      if (previous !== null) {
        await revokeSession(client, previous.sessionId);
      }
    }
    const issued = await issueSession(client, fresh.id);
    await insertAuditEvent(client, {
      actorAccountId: fresh.id,
      objectType: "session",
      objectId: issued.row.id,
      action: "login",
      outcome: "ok",
      correlationId: input.correlationId,
    });
    return { kind: "ok", token: issued.token, accountId: fresh.id, role: fresh.role } as const;
  });
}

export interface LogoutInput {
  readonly principal: Principal;
  readonly correlationId: string;
}

/** Revokes the current session server-side; the cookie is cleared by the route. */
export async function logout(pool: Pool, input: LogoutInput): Promise<void> {
  await withTransaction(pool, async (client) => {
    await revokeSession(client, input.principal.sessionId);
    await insertAuditEvent(client, {
      actorAccountId: input.principal.accountId,
      objectType: "session",
      objectId: input.principal.sessionId,
      action: "logout",
      outcome: "ok",
      correlationId: input.correlationId,
    });
  });
}

export interface ChangePasswordInput {
  readonly principal: Principal;
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly correlationId: string;
}

export type ChangePasswordResult =
  | { readonly kind: "ok"; readonly token: string }
  | { readonly kind: "invalid_current_password" }
  | { readonly kind: "weak_password"; readonly message: string }
  | { readonly kind: "unchanged" };

/**
 * Verifies the current password, applies the policy to the new one, then - in one transaction
 * - stores the new hash, revokes every session of the account and issues a fresh one (S2
 * "rotate on password change", "revoke on reset").
 */
export async function changePassword(
  pool: Pool,
  input: ChangePasswordInput,
): Promise<ChangePasswordResult> {
  const account = await withClient(pool, async (client) =>
    findAccountById(client, input.principal.accountId),
  );
  if (account === null || !account.active) {
    return { kind: "invalid_current_password" };
  }

  const verified = await verifyPassword(account.password_hash, input.currentPassword);
  if (!verified) {
    await withTransaction(pool, async (client) => {
      await insertAuditEvent(client, {
        actorAccountId: account.id,
        objectType: "account",
        objectId: account.id,
        action: "password.change",
        outcome: "denied",
        correlationId: input.correlationId,
      });
    });
    return { kind: "invalid_current_password" };
  }

  const policy = checkPasswordPolicy(input.newPassword);
  if (!policy.ok) {
    return { kind: "weak_password", message: policy.message ?? "that password cannot be used" };
  }

  const sameAsBefore = await verifyPassword(account.password_hash, input.newPassword);
  if (sameAsBefore) {
    return { kind: "unchanged" };
  }

  const newHash = await hashPassword(input.newPassword);

  return withTransaction(pool, async (client) => {
    const fresh = await findAccountById(client, account.id);
    if (fresh === null || !fresh.active) {
      return { kind: "invalid_current_password" } as const;
    }
    if (fresh.password_hash !== account.password_hash) {
      // Someone else changed the password while we were hashing; refuse rather than clobber.
      return { kind: "invalid_current_password" } as const;
    }
    await updatePasswordHash(client, fresh.id, newHash);
    await revokeAccountSessions(client, fresh.id);
    const issued = await issueSession(client, fresh.id);
    await insertAuditEvent(client, {
      actorAccountId: fresh.id,
      objectType: "account",
      objectId: fresh.id,
      action: "password.change",
      outcome: "ok",
      correlationId: input.correlationId,
    });
    return { kind: "ok", token: issued.token } as const;
  });
}
