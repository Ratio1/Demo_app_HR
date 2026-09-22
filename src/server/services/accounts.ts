/**
 * Account provisioning (spec §4, §6 S1/S7) - the operations `manage` exposes.
 *
 * Accounts exist only because an operator created one: there is no sign-up, no public setup
 * page and no default credential. Every function here runs under the maintenance role, and
 * every one of them writes its audit row in the same transaction as the change.
 *
 * The web layer will call these same functions (slice 2's deactivation cascade calls
 * `disableAccount`), which is what keeps the last-active-HR-admin protection in one place.
 */
import type { Pool } from "../db/pool.js";

import { withClient, withTransaction } from "../db/pool.js";
import {
  LastAdminError,
  countAccounts,
  disableAccount,
  findAccountByEmail,
  insertAccount,
  normalizeEmail,
  updatePasswordHash,
  type AccountRole,
} from "../repos/accounts.js";
import { insertAuditEvent } from "../repos/audit.js";
import { revokeAccountSessions } from "../repos/sessions.js";
import { getPublicOrigin, setPublicOrigin } from "../repos/settings.js";
import { checkPasswordPolicy, hashPassword } from "../auth/password.js";
import { validatePublicOrigin } from "../auth/origin.js";

/** A refusal an operator can act on. The message never contains a password. */
export class ProvisioningError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProvisioningError";
    this.code = code;
  }
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export function validateEmail(raw: string): string {
  const email = normalizeEmail(raw);
  if (email.length < 3 || email.length > 254 || !EMAIL_SHAPE.test(email)) {
    throw new ProvisioningError("invalid_email", "that does not look like an email address");
  }
  return email;
}

function requireAcceptablePassword(password: string): void {
  const policy = checkPasswordPolicy(password);
  if (!policy.ok) {
    throw new ProvisioningError("weak_password", policy.message ?? "that password cannot be used");
  }
}

export interface BootstrapInput {
  readonly email: string;
  readonly password: string;
  readonly publicOrigin: string;
  readonly correlationId: string;
}

export interface BootstrapResult {
  readonly accountId: string;
  readonly email: string;
  readonly publicOrigin: string;
}

/**
 * Provisions the first administrator and the public origin, atomically (spec §4). It refuses
 * outright if *any* account already exists, so it can never be used to add a second
 * administrator or to reset a forgotten password.
 */
export async function bootstrap(pool: Pool, input: BootstrapInput): Promise<BootstrapResult> {
  const email = validateEmail(input.email);
  requireAcceptablePassword(input.password);
  const origin = validatePublicOrigin(input.publicOrigin);
  if (!origin.ok || origin.value === undefined) {
    throw new ProvisioningError("invalid_origin", origin.message ?? "invalid public origin");
  }

  const existing = await withClient(pool, async (client) => countAccounts(client));
  if (existing > 0) {
    throw new ProvisioningError(
      "already_provisioned",
      "this database already has accounts: use create-user or reset-password",
    );
  }

  const passwordHash = await hashPassword(input.password);

  return withTransaction(pool, async (client) => {
    if ((await countAccounts(client)) > 0) {
      throw new ProvisioningError(
        "already_provisioned",
        "this database already has accounts: use create-user or reset-password",
      );
    }
    const account = await insertAccount(client, {
      email,
      passwordHash,
      role: "hr_admin",
    });
    await setPublicOrigin(client, origin.value as string);
    await insertAuditEvent(client, {
      actorAccountId: account.id,
      objectType: "account",
      objectId: account.id,
      action: "account.bootstrap",
      outcome: "ok",
      correlationId: input.correlationId,
    });
    await insertAuditEvent(client, {
      actorAccountId: account.id,
      objectType: "settings",
      objectId: null,
      action: "settings.set_origin",
      outcome: "ok",
      correlationId: input.correlationId,
    });
    return { accountId: account.id, email: account.email, publicOrigin: origin.value as string };
  });
}

export interface SetOriginInput {
  readonly origin: string;
  readonly correlationId: string;
}

export async function setOrigin(pool: Pool, input: SetOriginInput): Promise<string> {
  const origin = validatePublicOrigin(input.origin);
  if (!origin.ok || origin.value === undefined) {
    throw new ProvisioningError("invalid_origin", origin.message ?? "invalid public origin");
  }
  const value = origin.value;
  await withTransaction(pool, async (client) => {
    await setPublicOrigin(client, value);
    await insertAuditEvent(client, {
      actorAccountId: null,
      objectType: "settings",
      objectId: null,
      action: "settings.set_origin",
      outcome: "ok",
      correlationId: input.correlationId,
    });
  });
  return value;
}

export async function currentOrigin(pool: Pool): Promise<string | null> {
  return withClient(pool, async (client) => getPublicOrigin(client));
}

export interface CreateUserInput {
  readonly email: string;
  readonly password: string;
  readonly role: AccountRole;
  /** Required for the `employee` role: the `employees.code` this login belongs to. */
  readonly employeeCode?: string | undefined;
  readonly correlationId: string;
}

export interface CreateUserResult {
  readonly accountId: string;
  readonly email: string;
  readonly role: AccountRole;
  readonly employeeCode: string | null;
}

/**
 * Creates one account and, when a code is given, links it to that employee row. An
 * `employee`-role account without a link is refused (spec §2); a code that does not exist or
 * is already linked is refused too, so the at-most-one-employee-per-account rule holds
 * whatever the caller intended.
 */
export async function createUser(pool: Pool, input: CreateUserInput): Promise<CreateUserResult> {
  const email = validateEmail(input.email);
  requireAcceptablePassword(input.password);
  const code = input.employeeCode?.trim() ?? "";

  if (input.role === "employee" && code === "") {
    throw new ProvisioningError(
      "employee_link_required",
      "an employee-role account must be linked to an employee record: pass --employee <code>",
    );
  }

  const existing = await withClient(pool, async (client) => findAccountByEmail(client, email));
  if (existing !== null) {
    throw new ProvisioningError("email_taken", "an account with that email already exists");
  }

  const passwordHash = await hashPassword(input.password);

  return withTransaction(pool, async (client) => {
    if ((await findAccountByEmail(client, email)) !== null) {
      throw new ProvisioningError("email_taken", "an account with that email already exists");
    }
    const account = await insertAccount(client, { email, passwordHash, role: input.role });

    if (code !== "") {
      const linked = await client.query(
        `UPDATE employees SET account_id = $1, updated_at = now(), version = version + 1
          WHERE code = $2 AND account_id IS NULL`,
        [account.id, code],
      );
      if ((linked.rowCount ?? 0) !== 1) {
        const present = await client.query<{ one: number }>(
          "SELECT 1 AS one FROM employees WHERE code = $1",
          [code],
        );
        throw new ProvisioningError(
          present.rowCount === 1 ? "employee_already_linked" : "employee_not_found",
          present.rowCount === 1
            ? "that employee record already has a login"
            : "no employee record has that code",
        );
      }
    }

    await insertAuditEvent(client, {
      actorAccountId: account.id,
      objectType: "account",
      objectId: account.id,
      action: "account.create",
      outcome: "ok",
      correlationId: input.correlationId,
    });

    return {
      accountId: account.id,
      email: account.email,
      role: account.role,
      employeeCode: code === "" ? null : code,
    };
  });
}

export interface ResetPasswordInput {
  readonly email: string;
  readonly password: string;
  readonly correlationId: string;
}

/**
 * Operator-driven recovery (S1 "operator-only recovery"): the new password is set, the lockout
 * counters are cleared and every session of that account is revoked, in one transaction.
 */
export async function resetPassword(
  pool: Pool,
  input: ResetPasswordInput,
): Promise<{ readonly accountId: string; readonly revokedSessions: number }> {
  const email = validateEmail(input.email);
  requireAcceptablePassword(input.password);

  const account = await withClient(pool, async (client) => findAccountByEmail(client, email));
  if (account === null) {
    throw new ProvisioningError("account_not_found", "no account has that email");
  }

  const passwordHash = await hashPassword(input.password);

  return withTransaction(pool, async (client) => {
    const fresh = await findAccountByEmail(client, email);
    if (fresh === null) {
      throw new ProvisioningError("account_not_found", "no account has that email");
    }
    await updatePasswordHash(client, fresh.id, passwordHash);
    const revoked = await revokeAccountSessions(client, fresh.id);
    await insertAuditEvent(client, {
      actorAccountId: fresh.id,
      objectType: "account",
      objectId: fresh.id,
      action: "account.reset_password",
      outcome: "ok",
      correlationId: input.correlationId,
    });
    return { accountId: fresh.id, revokedSessions: revoked };
  });
}

export interface DisableUserInput {
  readonly email: string;
  readonly correlationId: string;
}

/**
 * Deactivates an account, revoking its sessions in the same transaction, unless it is the last
 * active HR administrator - in which case nothing is written and the refusal itself is
 * audited, in a transaction of its own (there is no business mutation to commit with).
 */
export async function disableUser(
  pool: Pool,
  input: DisableUserInput,
): Promise<{ readonly accountId: string; readonly revokedSessions: number }> {
  const email = validateEmail(input.email);

  const account = await withClient(pool, async (client) => findAccountByEmail(client, email));
  if (account === null) {
    throw new ProvisioningError("account_not_found", "no account has that email");
  }
  if (!account.active) {
    throw new ProvisioningError("already_disabled", "that account is already disabled");
  }

  try {
    return await withTransaction(pool, async (client) => {
      const result = await disableAccount(client, account.id);
      await insertAuditEvent(client, {
        actorAccountId: result.account.id,
        objectType: "account",
        objectId: result.account.id,
        action: "account.disable",
        outcome: "ok",
        correlationId: input.correlationId,
      });
      return { accountId: result.account.id, revokedSessions: result.revokedSessions };
    });
  } catch (error) {
    if (error instanceof LastAdminError) {
      await withTransaction(pool, async (client) => {
        await insertAuditEvent(client, {
          actorAccountId: account.id,
          objectType: "account",
          objectId: account.id,
          action: "account.disable",
          outcome: "denied",
          correlationId: input.correlationId,
        });
      });
      throw new ProvisioningError(
        "last_admin",
        "refusing to disable the last active HR administrator",
      );
    }
    throw error;
  }
}
