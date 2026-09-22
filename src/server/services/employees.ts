/**
 * Employee reads and mutations (spec §2, §6 S4, S7).
 *
 * This module is the authorization boundary for everything about `employees`: **every**
 * function takes the `Principal` the caller resolved from the database on this request and
 * re-checks the role itself, so a page, a Route Handler and a future caller all get the same
 * answer. Neither the navigation nor the absence of a link is ever the control (S4: "UI hiding
 * /UUID secrecy is not authorization").
 *
 * Three rules shape the mutations:
 *
 *  1. **`SELECT … FOR UPDATE` on the employee row first** (D8's row-lock ruling). The version
 *     the transaction then compares cannot move under it, so the optimistic check is exact
 *     rather than best-effort, and the deactivation cascade cannot interleave with an edit.
 *  2. **The audit rows commit with the change they describe** (S7): they are written with the
 *     same `PoolClient`, inside the same transaction. A refused cascade has no business
 *     mutation to commit with, so its `denied` row is written afterwards, in a transaction of
 *     its own, exactly as `disableUser` does.
 *  3. **One last-admin guard.** The cascade calls `disableAccount`, the same repository
 *     function `manage disable-user` calls, so the last-active-HR-admin rule cannot be
 *     bypassed by going through the web (spec §2).
 */
import type { Pool, PoolClient } from "../db/pool.ts";

import { withClient, withTransaction } from "../db/pool.ts";
import type { Principal } from "../auth/session.ts";
import { LastAdminError, disableAccount } from "../repos/accounts.ts";
import { insertAuditEvent } from "../repos/audit.ts";
import {
  cancelPendingLeaveFor,
  findEmployeeByAccountId,
  findEmployeeById,
  insertEmployee,
  isCodeTaken,
  isWorkEmailTaken,
  listActiveEmployees,
  listEmployees,
  lockEmployee,
  setEmployeeActive,
  updateEmployeeFields,
  uniqueViolationField,
  type EmployeeWriteInput,
} from "../repos/employees.ts";
import {
  projectDirectory,
  savedLocation,
  toHrEmployee,
  toOwnProfile,
  type DirectoryDTO,
  type EmployeeCreateInput,
  type EmployeeMutationResult,
  type EmployeeStatusInput,
  type EmployeeUpdateInput,
  type FieldErrors,
  type HrEmployeeDTO,
  type OwnProfileDTO,
  type ReadResult,
} from "../dto/employees.ts";

export { savedLocation };

const DUPLICATE_CODE = "That employee code is already in use.";
const DUPLICATE_EMAIL = "That work email is already in use.";

/** A database failure closes the page with a sanitized `503`; no SQLSTATE, no row, no host. */
async function read<T>(run: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { kind: "ok", data: await run() };
  } catch {
    return { kind: "unavailable" };
  }
}

function isHr(principal: Principal): boolean {
  return principal.role === "hr_admin";
}

function writeInput(input: EmployeeCreateInput | EmployeeUpdateInput): EmployeeWriteInput {
  return {
    code: input.code,
    full_name: input.full_name,
    work_email: input.work_email,
    title: input.title,
    department: input.department,
    start_date: input.start_date,
  };
}

/** The fresh record after a write, projected through the HR DTO. */
async function reloadHrEmployee(client: PoolClient, id: string): Promise<HrEmployeeDTO> {
  const record = await findEmployeeById(client, id);
  if (record === null) {
    throw new Error("employee row vanished inside its own transaction");
  }
  return toHrEmployee(record);
}

/* ---------------------------------------------------------------------------------- reads */

/** `/employees`: every record, active and inactive. HR only. */
export async function listEmployeesForHr(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<HrEmployeeDTO[]>> {
  if (!isHr(principal)) {
    return { kind: "forbidden" };
  }
  return read(async () =>
    withClient(pool, async (client) => (await listEmployees(client)).map(toHrEmployee)),
  );
}

/** One record for the editor. `null` data means no employee has that id. HR only. */
export async function getEmployeeForHr(
  pool: Pool,
  principal: Principal,
  id: string,
): Promise<ReadResult<HrEmployeeDTO | null>> {
  if (!isHr(principal)) {
    return { kind: "forbidden" };
  }
  return read(async () =>
    withClient(pool, async (client) => {
      const record = await findEmployeeById(client, id);
      return record === null ? null : toHrEmployee(record);
    }),
  );
}

/**
 * `/directory`: active colleagues, for any live session. The `active = true` predicate is in
 * the SQL for **every** role — the slice brief's exit criterion is that deactivating an
 * employee hides them from the directory an HR admin is looking at — and the projection then
 * gives an `employee` four fields and an `hr_admin` those four plus the code and the status.
 */
export async function loadDirectory(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<DirectoryDTO>> {
  return read(async () =>
    withClient(pool, async (client) =>
      projectDirectory(principal.role, await listActiveEmployees(client)),
    ),
  );
}

/**
 * `/me`: the caller's own record, read-only, for any live session. `null` data is the
 * "no employee record linked" state an `hr_admin` can legitimately be in (spec §2 requires a
 * link only for `employee`-role accounts); it is not an error.
 */
export async function loadOwnProfile(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<OwnProfileDTO | null>> {
  return read(async () =>
    withClient(pool, async (client) => {
      const record = await findEmployeeByAccountId(client, principal.accountId);
      return record === null ? null : toOwnProfile(record);
    }),
  );
}

/* ------------------------------------------------------------------------------ mutations */

export interface MutationRequest {
  readonly principal: Principal;
  readonly correlationId: string;
}

/** `POST /api/employees`. */
export async function createEmployee(
  pool: Pool,
  request: MutationRequest,
  input: EmployeeCreateInput,
): Promise<EmployeeMutationResult> {
  if (!isHr(request.principal)) {
    return { kind: "forbidden" };
  }
  const values = writeInput(input);

  try {
    return await withTransaction(pool, async (client) => {
      const duplicates: Record<string, string> = {};
      if (await isCodeTaken(client, values.code)) {
        duplicates.code = DUPLICATE_CODE;
      }
      if (await isWorkEmailTaken(client, values.work_email)) {
        duplicates.work_email = DUPLICATE_EMAIL;
      }
      if (Object.keys(duplicates).length > 0) {
        return { kind: "invalid", fields: duplicates } as const;
      }

      const id = await insertEmployee(client, values);
      await insertAuditEvent(client, {
        actorAccountId: request.principal.accountId,
        objectType: "employee",
        objectId: id,
        action: "employee.create",
        outcome: "ok",
        correlationId: request.correlationId,
      });
      return { kind: "ok", employee: await reloadHrEmployee(client, id) } as const;
    });
  } catch (error) {
    return duplicateOrUnavailable(error);
  }
}

/** `POST /api/employees/<id>` — the edit, guarded by `version`. */
export async function updateEmployee(
  pool: Pool,
  request: MutationRequest,
  id: string,
  input: EmployeeUpdateInput,
): Promise<EmployeeMutationResult> {
  if (!isHr(request.principal)) {
    return { kind: "forbidden" };
  }
  const values = writeInput(input);

  try {
    return await withTransaction(pool, async (client) => {
      const locked = await lockEmployee(client, id);
      if (locked === null) {
        return { kind: "not_found" } as const;
      }
      if (locked.version !== input.version) {
        return { kind: "conflict_stale", current: await reloadHrEmployee(client, id) } as const;
      }

      const duplicates: Record<string, string> = {};
      if (await isCodeTaken(client, values.code, id)) {
        duplicates.code = DUPLICATE_CODE;
      }
      if (await isWorkEmailTaken(client, values.work_email, id)) {
        duplicates.work_email = DUPLICATE_EMAIL;
      }
      if (Object.keys(duplicates).length > 0) {
        return { kind: "invalid", fields: duplicates } as const;
      }

      const changed = await updateEmployeeFields(client, id, input.version, values);
      if (changed === 0) {
        // Unreachable while the row lock is held; treated as a stale edit rather than trusted.
        return { kind: "conflict_stale", current: await reloadHrEmployee(client, id) } as const;
      }
      await insertAuditEvent(client, {
        actorAccountId: request.principal.accountId,
        objectType: "employee",
        objectId: id,
        action: "employee.update",
        outcome: "ok",
        correlationId: request.correlationId,
      });
      return { kind: "ok", employee: await reloadHrEmployee(client, id) } as const;
    });
  } catch (error) {
    return duplicateOrUnavailable(error);
  }
}

/**
 * `POST /api/employees/<id>/status` — activate, or deactivate with the whole cascade.
 *
 * **Deactivation, in one transaction:** the employee row is locked, `active` goes to `false`,
 * the linked account is disabled through `disableAccount` (which revokes every session of that
 * account and refuses to leave the organization with no active HR administrator), and every
 * `pending` leave request of that employee becomes `cancelled`. One audit row per effect, all
 * under this request's correlation id. If the last-admin rule fires, `LastAdminError` rolls the
 * entire transaction back — `employees.active` included — and the refusal is audited on its own.
 *
 * **Activation reverses only `employees.active`.** Accounts are re-enabled by the operator
 * through the CLI, never by the web (spec §4: accounts are CLI-provisioned).
 */
export async function setEmployeeStatus(
  pool: Pool,
  request: MutationRequest,
  id: string,
  input: EmployeeStatusInput,
): Promise<EmployeeMutationResult> {
  if (!isHr(request.principal)) {
    return { kind: "forbidden" };
  }
  const activating = input.action === "activate";

  try {
    return await withTransaction(pool, async (client) => {
      const locked = await lockEmployee(client, id);
      if (locked === null) {
        return { kind: "not_found" } as const;
      }
      if (locked.version !== input.version) {
        return { kind: "conflict_stale", current: await reloadHrEmployee(client, id) } as const;
      }

      const changed = await setEmployeeActive(client, id, input.version, activating);
      if (changed === 0) {
        return { kind: "conflict_stale", current: await reloadHrEmployee(client, id) } as const;
      }

      if (activating) {
        await insertAuditEvent(client, {
          actorAccountId: request.principal.accountId,
          objectType: "employee",
          objectId: id,
          action: "employee.activate",
          outcome: "ok",
          correlationId: request.correlationId,
        });
        return { kind: "ok", employee: await reloadHrEmployee(client, id) } as const;
      }

      await insertAuditEvent(client, {
        actorAccountId: request.principal.accountId,
        objectType: "employee",
        objectId: id,
        action: "employee.deactivate",
        outcome: "ok",
        correlationId: request.correlationId,
      });

      if (locked.account_id !== null) {
        // Throws LastAdminError, rolling back everything above, when this would leave no
        // active HR administrator. Same function as `manage disable-user` (spec §2).
        await disableAccount(client, locked.account_id);
        await insertAuditEvent(client, {
          actorAccountId: request.principal.accountId,
          objectType: "account",
          objectId: locked.account_id,
          action: "account.disable",
          outcome: "ok",
          correlationId: request.correlationId,
        });
      }

      for (const leaveId of await cancelPendingLeaveFor(client, id)) {
        await insertAuditEvent(client, {
          actorAccountId: request.principal.accountId,
          objectType: "leave_request",
          objectId: leaveId,
          action: "leave.cancel",
          outcome: "ok",
          correlationId: request.correlationId,
        });
      }

      return { kind: "ok", employee: await reloadHrEmployee(client, id) } as const;
    });
  } catch (error) {
    if (error instanceof LastAdminError) {
      try {
        await withTransaction(pool, async (client) => {
          await insertAuditEvent(client, {
            actorAccountId: request.principal.accountId,
            objectType: "employee",
            objectId: id,
            action: "employee.deactivate",
            outcome: "denied",
            correlationId: request.correlationId,
          });
        });
      } catch {
        // The refusal stands even if the audit row cannot be written; the caller still gets 409.
      }
      return { kind: "conflict_last_admin" };
    }
    return duplicateOrUnavailable(error);
  }
}

/**
 * A `23505` that slipped past the in-transaction pre-check (a concurrent insert of the same
 * code or work email) becomes the same per-field message; anything else is a sanitized `503`.
 */
function duplicateOrUnavailable(error: unknown): EmployeeMutationResult {
  const field = uniqueViolationField(error);
  if (field !== null) {
    const fields: FieldErrors = { [field]: field === "code" ? DUPLICATE_CODE : DUPLICATE_EMAIL };
    return { kind: "invalid", fields };
  }
  return { kind: "unavailable" };
}
