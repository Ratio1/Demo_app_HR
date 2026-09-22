/**
 * Leave reads and mutations (spec §2 Leave, §6 S4, S7).
 *
 * This module is the authorization boundary for everything about `leave_requests`: **every**
 * function takes the `Principal` the caller resolved from the database on this request and
 * re-checks what that principal may do, so a page, a Route Handler and a future caller all get
 * the same answer. The route guard is the outer gate, not the only one, and neither the UI's
 * hidden button nor an unguessable request id is ever the control (S4).
 *
 * Four rules shape the mutations:
 *
 *  1. **The owner is the session's, never the body's.** `POST /api/leave` has no `employee_id`
 *     field; the employee row is resolved from `principal.accountId` and locked in the same
 *     statement (`lockEmployeeByAccountId`). An account with no employee record cannot submit at
 *     all (spec §2: "Linked users submit …").
 *  2. **Lock, then check, then write.** Submitting locks the employee row before the overlap
 *     check, so two concurrent overlapping submissions serialize and exactly one wins; cancelling
 *     and deciding lock the request row before the status and version checks. Each write
 *     additionally carries `AND status = 'pending' AND version = $expected`, so the lock is a
 *     contention hint and not the only guard. The lock order is documented in `repos/leave.ts`.
 *  3. **The audit row commits with the change it describes** (S7): written with the same
 *     `PoolClient`, inside the same transaction, under this request's correlation id. A rolled
 *     back mutation takes its audit row with it.
 *  4. **Self-approval is barred before anything else about the request is considered** (spec §2:
 *     "An HR admin's request needs a different HR admin; never bypass self-approval"), so an
 *     administrator cannot learn the state of their own request's row by watching which conflict
 *     they get. The refusal is audited as `denied`.
 *
 * Disclosure follows the access matrix: a request that is not the caller's to cancel answers
 * `404 not_found`, never `403`, because "that request exists" is not the caller's to learn.
 */
import type { Pool, PoolClient } from "../db/pool.ts";

import { withClient, withTransaction } from "../db/pool.ts";
import type { Principal } from "../auth/session.ts";
import { insertAuditEvent, type AuditAction } from "../repos/audit.ts";
import {
  cancelLeaveRequest,
  countLeaveForEmployee,
  decideLeaveRequest,
  findApprovalById,
  findEmployeeIdByAccountId,
  findLeaveRequestById,
  hasOverlappingLeave,
  insertLeaveRequest,
  listDecidedApprovals,
  listLeaveForEmployee,
  listPendingApprovals,
  lockEmployeeByAccountId,
  lockLeaveRequest,
} from "../repos/leave.ts";
import { LEAVE_RANGE_MESSAGES, validateLeaveRange } from "../../shared/dates.ts";
import {
  DECIDED_HISTORY_LIMIT,
  LEAVE_PAGE_LIMIT,
  LEAVE_RANGE_MESSAGE_FIELD,
  toApproval,
  toOwnLeave,
  type ApprovalDTO,
  type ApprovalsDTO,
  type LeaveCancelInput,
  type LeaveCreateInput,
  type LeaveDecisionInput,
  type LeaveMutationResult,
  type OwnLeaveDTO,
  type OwnLeaveListDTO,
  type ReadResult,
} from "../dto/leave.ts";

/** A database failure closes the page with a sanitized `503`; no SQLSTATE, no row, no host (S6). */
async function read<T>(run: () => Promise<T>): Promise<ReadResult<T>> {
  try {
    return { kind: "ok", data: await run() };
  } catch {
    return { kind: "unavailable" };
  }
}

export interface LeaveMutationRequest {
  readonly principal: Principal;
  readonly correlationId: string;
}

async function audit(
  client: PoolClient,
  request: LeaveMutationRequest,
  objectId: string,
  action: AuditAction,
  outcome: "ok" | "denied",
): Promise<void> {
  await insertAuditEvent(client, {
    actorAccountId: request.principal.accountId,
    objectType: "leave_request",
    objectId,
    action,
    outcome,
    correlationId: request.correlationId,
  });
}

/** The fresh row after a write, projected for its owner. */
async function reloadOwnLeave(client: PoolClient, id: string): Promise<OwnLeaveDTO> {
  const record = await findLeaveRequestById(client, id);
  if (record === null) {
    throw new Error("leave request vanished inside its own transaction");
  }
  return toOwnLeave(record);
}

/** The fresh row after a decision, projected for the administrator who took it. */
async function reloadApproval(
  client: PoolClient,
  id: string,
  viewerEmployeeId: string | null,
): Promise<ApprovalDTO> {
  const record = await findApprovalById(client, id);
  if (record === null) {
    throw new Error("leave request vanished inside its own transaction");
  }
  return toApproval(record, viewerEmployeeId);
}

/* ---------------------------------------------------------------------------------- reads */

/**
 * `/leave`: the caller's own history, for any live session. `{ linked: false }` is the
 * "no employee record linked" state an `hr_admin` can legitimately be in — it is a shape of the
 * data, not an error, and it is the only thing such an account can be told about leave.
 */
export async function loadOwnLeave(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<OwnLeaveListDTO>> {
  return read(async () =>
    withClient(pool, async (client): Promise<OwnLeaveListDTO> => {
      const employeeId = await findEmployeeIdByAccountId(client, principal.accountId);
      if (employeeId === null) {
        return { linked: false };
      }
      const rows = await listLeaveForEmployee(client, employeeId, LEAVE_PAGE_LIMIT);
      return { linked: true, requests: rows.map(toOwnLeave) };
    }),
  );
}

/**
 * `/approvals`: the pending queue and the last decisions. **HR only** — an `employee` gets
 * `forbidden` here and never reaches a colleague's row, because the role is checked before any
 * query runs (S4: server-side authorization for routes, lists and counts alike).
 */
export async function loadApprovals(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<ApprovalsDTO>> {
  if (principal.role !== "hr_admin") {
    return { kind: "forbidden" };
  }
  return read(async () =>
    withClient(pool, async (client): Promise<ApprovalsDTO> => {
      const viewerEmployeeId = await findEmployeeIdByAccountId(client, principal.accountId);
      const [pending, decided] = await Promise.all([
        listPendingApprovals(client, LEAVE_PAGE_LIMIT),
        listDecidedApprovals(client, DECIDED_HISTORY_LIMIT),
      ]);
      return {
        pending: pending.map((row) => toApproval(row, viewerEmployeeId)),
        decided: decided.map((row) => toApproval(row, viewerEmployeeId)),
      };
    }),
  );
}

/** How many requests the caller's own employee record has, for a page that needs only the count. */
export async function countOwnLeave(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<number>> {
  return read(async () =>
    withClient(pool, async (client) => {
      const employeeId = await findEmployeeIdByAccountId(client, principal.accountId);
      return employeeId === null ? 0 : countLeaveForEmployee(client, employeeId);
    }),
  );
}

/* ------------------------------------------------------------------------------ mutations */

/**
 * `POST /api/leave` — submit a request for the caller's own employee record.
 *
 * One transaction: lock the caller's employee row, refuse an overlapping `pending`/`approved`
 * request, insert, audit. The weekday count is re-derived here from the same
 * `validateLeaveRange` the schema and the form use, so a client that posts directly cannot make
 * the stored range and the displayed count disagree.
 */
export async function submitLeave(
  pool: Pool,
  request: LeaveMutationRequest,
  input: LeaveCreateInput,
): Promise<LeaveMutationResult<OwnLeaveDTO>> {
  // Re-derived server-side; the schema already refused anything that fails here.
  const range = validateLeaveRange(input.start_date, input.end_date);
  if (!range.ok) {
    return {
      kind: "invalid",
      fields: { [LEAVE_RANGE_MESSAGE_FIELD]: LEAVE_RANGE_MESSAGES[range.problem] },
    };
  }

  try {
    return await withTransaction(pool, async (client) => {
      const owner = await lockEmployeeByAccountId(client, request.principal.accountId);
      if (owner === null || !owner.active) {
        // No employee record, or a deactivated one: neither may own new leave (spec §2).
        return { kind: "forbidden" } as const;
      }

      if (await hasOverlappingLeave(client, owner.id, input.start_date, input.end_date)) {
        return { kind: "conflict_overlap" } as const;
      }

      const id = await insertLeaveRequest(client, {
        employeeId: owner.id,
        kind: input.kind,
        startDate: input.start_date,
        endDate: input.end_date,
      });
      await audit(client, request, id, "leave.submit", "ok");
      return { kind: "ok", request: await reloadOwnLeave(client, id) } as const;
    });
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * `POST /api/leave/<id>/cancel` — the owner withdraws their own pending request.
 *
 * Ownership is compared against the employee record linked to the **session's** account. Any
 * other caller, including an `hr_admin` looking at the queue, gets `404 not_found`: cancelling is
 * the owner's alone (spec §2, "cancel own pending requests"), and a `403` would confirm that the
 * request exists.
 */
export async function cancelLeave(
  pool: Pool,
  request: LeaveMutationRequest,
  id: string,
  input: LeaveCancelInput,
): Promise<LeaveMutationResult<OwnLeaveDTO>> {
  try {
    return await withTransaction(pool, async (client) => {
      const locked = await lockLeaveRequest(client, id);
      if (locked === null) {
        return { kind: "not_found" } as const;
      }

      const ownerEmployeeId = await findEmployeeIdByAccountId(client, request.principal.accountId);
      if (ownerEmployeeId === null || locked.employee_id !== ownerEmployeeId) {
        return { kind: "not_found" } as const;
      }

      if (locked.status !== "pending") {
        return {
          kind: "conflict_not_pending",
          current: await reloadOwnLeave(client, id),
        } as const;
      }
      if (locked.version !== input.version) {
        return { kind: "conflict_stale", current: await reloadOwnLeave(client, id) } as const;
      }

      const changed = await cancelLeaveRequest(client, id, input.version);
      if (changed === 0) {
        // Unreachable while the row lock is held; treated as a lost race rather than trusted.
        return {
          kind: "conflict_not_pending",
          current: await reloadOwnLeave(client, id),
        } as const;
      }

      await audit(client, request, id, "leave.cancel", "ok");
      return { kind: "ok", request: await reloadOwnLeave(client, id) } as const;
    });
  } catch {
    return { kind: "unavailable" };
  }
}

/**
 * `POST /api/leave/<id>/decision` — an `hr_admin` approves or rejects a pending request.
 *
 * The self-approval bar is checked **first**, before the pending and version checks, so an
 * administrator gets the same `403` for their own request whatever state it is in, and the
 * refusal is recorded as a `denied` audit row. Racing decisions are resolved by the row lock plus
 * the `AND status = 'pending' AND version = $expected` guard: exactly one wins, the other gets
 * `409 conflict_not_pending` and writes nothing.
 */
export async function decideLeave(
  pool: Pool,
  request: LeaveMutationRequest,
  id: string,
  input: LeaveDecisionInput,
): Promise<LeaveMutationResult<ApprovalDTO>> {
  if (request.principal.role !== "hr_admin") {
    return { kind: "forbidden" };
  }
  const action: AuditAction = input.action === "approve" ? "leave.approve" : "leave.reject";

  try {
    return await withTransaction(pool, async (client) => {
      const locked = await lockLeaveRequest(client, id);
      if (locked === null) {
        return { kind: "not_found" } as const;
      }

      const viewerEmployeeId = await findEmployeeIdByAccountId(client, request.principal.accountId);
      if (viewerEmployeeId !== null && locked.employee_id === viewerEmployeeId) {
        // Spec §2: an HR admin's own request needs a different HR admin. The row is the receipt.
        await audit(client, request, id, action, "denied");
        return { kind: "forbidden" } as const;
      }

      if (locked.status !== "pending") {
        return {
          kind: "conflict_not_pending",
          current: await reloadApproval(client, id, viewerEmployeeId),
        } as const;
      }
      if (locked.version !== input.version) {
        return {
          kind: "conflict_stale",
          current: await reloadApproval(client, id, viewerEmployeeId),
        } as const;
      }

      const changed = await decideLeaveRequest(
        client,
        id,
        input.version,
        input.action,
        request.principal.accountId,
      );
      if (changed === 0) {
        // Unreachable while the row lock is held; treated as a lost race rather than trusted.
        return {
          kind: "conflict_not_pending",
          current: await reloadApproval(client, id, viewerEmployeeId),
        } as const;
      }

      await audit(client, request, id, action, "ok");
      return {
        kind: "ok",
        request: await reloadApproval(client, id, viewerEmployeeId),
      } as const;
    });
  } catch {
    return { kind: "unavailable" };
  }
}
