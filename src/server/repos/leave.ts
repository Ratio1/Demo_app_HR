/**
 * Leave request rows: the only module that writes `leave_requests` (spec §2 Leave, §5).
 *
 * Every statement is parameterised, every date is bound as **text and cast with `$n::date`**
 * (data contract C4 — no `Date` is ever constructed, so no midnight timestamp can appear), and
 * every read projects the exact column list `LeaveRequestRecord` / `ApprovalRecord` declares.
 * `decided_by` is selected by **nothing**: no projection carries the deciding administrator's
 * identity, so it cannot leak through a DTO by accident.
 *
 * ## Locking, and why there is no deadlock
 *
 * Three paths take row locks, and the order is the same everywhere:
 *
 *  - **submit** — `lockEmployeeByAccountId` (`employees` row, `FOR UPDATE`) → overlap check →
 *    `INSERT`. Serializing on the employee row is what makes the overlap check sound: a second
 *    overlapping submission for the same employee waits, then re-reads and loses with
 *    `409 conflict_overlap` (spec §2: "Serialize employee-row locking, overlap checks, and
 *    creation").
 *  - **cancel / decide** — `lockLeaveRequest` (`leave_requests` row, `FOR UPDATE`) → status and
 *    version re-check → guarded `UPDATE`. Neither path ever takes the employee lock, so the pair
 *    **employee → leave_request** is the only order that exists.
 *  - **the slice-2 deactivation cascade** — `lockEmployee` → `disableAccount` (`settings` row) →
 *    `cancelPendingLeaveFor` (implicit locks on that employee's pending leave rows). Same order:
 *    employee → settings → leave rows.
 *
 * Nothing in the application takes them the other way round, so no cycle is possible. A decision
 * racing the cascade is resolved by the engine: the cascade's `UPDATE … WHERE status = 'pending'`
 * blocks on the row the decision holds, re-evaluates after it commits, and correctly leaves an
 * approved request alone (spec §2: "completed history remains").
 *
 * The guarded writes carry `AND status = 'pending' AND version = $n` as well as the lock, so
 * removing the lock would cost contention behaviour but not correctness (data contract §3's rule
 * that `FOR UPDATE` is a hint, never the only guard).
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "../db/pool.ts";
import type {
  ApprovalRecord,
  LeaveDecision,
  LeaveKind,
  LeaveRequestRecord,
} from "../dto/leave.ts";

/** The exact projection `LeaveRequestRecord` names; no `SELECT *`, and never `decided_by`. */
const LEAVE_SELECT = `SELECT l.id, l.employee_id, l.kind, l.start_date, l.end_date, l.status,
              l.decided_at, l.created_at, l.version
         FROM leave_requests l`;

/** The same projection joined to the employee fields an approver is entitled to see. */
const APPROVAL_SELECT = `SELECT l.id, l.employee_id, l.kind, l.start_date, l.end_date, l.status,
              l.decided_at, l.created_at, l.version,
              e.code AS employee_code, e.full_name AS employee_full_name,
              e.department AS employee_department
         FROM leave_requests l
         JOIN employees e ON e.id = l.employee_id`;

/** Canonical 8-4-4-4-12 hex form. A malformed id is never sent to the database. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isLeaveRequestId(value: string): boolean {
  return UUID_SHAPE.test(value);
}

export interface EmployeeOwnerRow {
  readonly id: string;
  readonly active: boolean;
}

/**
 * The caller's own employee row, locked `FOR UPDATE`, resolved from the **session's** account id
 * — never from anything the request body carried. `null` means the account has no employee
 * record, which spec §2 makes a hard refusal to submit ("Linked users submit …").
 */
export async function lockEmployeeByAccountId(
  client: PoolClient,
  accountId: string,
): Promise<EmployeeOwnerRow | null> {
  const result = await client.query<EmployeeOwnerRow>(
    "SELECT id, active FROM employees WHERE account_id = $1 FOR UPDATE",
    [accountId],
  );
  return result.rows[0] ?? null;
}

/** The same row without a lock, for the reads and for the self-approval comparison. */
export async function findEmployeeIdByAccountId(
  client: PoolClient,
  accountId: string,
): Promise<string | null> {
  const result = await client.query<{ id: string }>(
    "SELECT id FROM employees WHERE account_id = $1",
    [accountId],
  );
  return result.rows[0]?.id ?? null;
}

export interface LeaveLockRow {
  readonly id: string;
  readonly employee_id: string;
  readonly status: string;
  readonly version: number;
}

/**
 * Serializes every change to one leave request. Returns `null` when no row has that id, which the
 * services turn into `404 not_found`.
 */
export async function lockLeaveRequest(
  client: PoolClient,
  id: string,
): Promise<LeaveLockRow | null> {
  if (!isLeaveRequestId(id)) {
    return null;
  }
  const result = await client.query<LeaveLockRow>(
    "SELECT id, employee_id, status, version FROM leave_requests WHERE id = $1 FOR UPDATE",
    [id],
  );
  return result.rows[0] ?? null;
}

/**
 * Whether this employee already has a `pending` or `approved` request touching the range. Two
 * inclusive ranges overlap exactly when each starts on or before the other ends; `cancelled` and
 * `rejected` requests are not in the way (spec §2: "no overlapping pending/approved requests").
 *
 * Must be called **after** the employee row lock, or two concurrent submissions can both see no
 * overlap and both insert.
 */
export async function hasOverlappingLeave(
  client: PoolClient,
  employeeId: string,
  startDate: string,
  endDate: string,
): Promise<boolean> {
  const result = await client.query<{ one: number }>(
    `SELECT 1 AS one
       FROM leave_requests
      WHERE employee_id = $1
        AND status IN ('pending', 'approved')
        AND start_date <= $3::date
        AND end_date >= $2::date
      LIMIT 1`,
    [employeeId, startDate, endDate],
  );
  return result.rows.length > 0;
}

export interface LeaveInsertInput {
  readonly employeeId: string;
  readonly kind: LeaveKind;
  /** ISO `YYYY-MM-DD`, bound as text and cast by the statement. */
  readonly startDate: string;
  readonly endDate: string;
}

/**
 * Inserts a `pending` request. `status`, `decided_by`, `decided_at` and `version` are not
 * parameters at all: a new request is pending, undecided and version 1, by construction.
 */
export async function insertLeaveRequest(
  client: PoolClient,
  input: LeaveInsertInput,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO leave_requests
       (id, employee_id, kind, start_date, end_date, status, version, created_at)
     VALUES ($1, $2, $3, $4::date, $5::date, 'pending', 1, now())`,
    [id, input.employeeId, input.kind, input.startDate, input.endDate],
  );
  return id;
}

/**
 * The owner's withdrawal: `pending → cancelled`, guarded by both the status and the expected
 * version. Returns the number of rows changed; `0` means the request moved under the caller.
 * `decided_by`/`decided_at` stay `NULL` — a cancellation is not a decision, which is also what
 * `leave_requests_pending_undecided` and `leave_requests_decision_recorded` allow.
 */
export async function cancelLeaveRequest(
  client: PoolClient,
  id: string,
  expectedVersion: number,
): Promise<number> {
  const result = await client.query(
    `UPDATE leave_requests
        SET status = 'cancelled', version = version + 1
      WHERE id = $1 AND version = $2 AND status = 'pending'`,
    [id, expectedVersion],
  );
  return result.rowCount ?? 0;
}

/**
 * The administrator's decision: `pending → approved | rejected`, recording who decided and when,
 * guarded by both the status and the expected version. Exactly one of two racing decisions can
 * change a row, because the loser's `status = 'pending'` predicate no longer holds.
 */
export async function decideLeaveRequest(
  client: PoolClient,
  id: string,
  expectedVersion: number,
  decision: LeaveDecision,
  decidedByAccountId: string,
): Promise<number> {
  const result = await client.query(
    `UPDATE leave_requests
        SET status = $3, decided_by = $4, decided_at = now(), version = version + 1
      WHERE id = $1 AND version = $2 AND status = 'pending'`,
    [id, expectedVersion, decision === "approve" ? "approved" : "rejected", decidedByAccountId],
  );
  return result.rowCount ?? 0;
}

export async function findLeaveRequestById(
  client: PoolClient,
  id: string,
): Promise<LeaveRequestRecord | null> {
  if (!isLeaveRequestId(id)) {
    return null;
  }
  const result = await client.query<LeaveRequestRecord>(`${LEAVE_SELECT} WHERE l.id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function findApprovalById(
  client: PoolClient,
  id: string,
): Promise<ApprovalRecord | null> {
  if (!isLeaveRequestId(id)) {
    return null;
  }
  const result = await client.query<ApprovalRecord>(`${APPROVAL_SELECT} WHERE l.id = $1`, [id]);
  return result.rows[0] ?? null;
}

/**
 * One employee's own history, newest range first. The `employee_id = $1` predicate is in the SQL,
 * so a colleague's row is never fetched and then filtered out (spec §3).
 */
export async function listLeaveForEmployee(
  client: PoolClient,
  employeeId: string,
  limit: number,
): Promise<LeaveRequestRecord[]> {
  const result = await client.query<LeaveRequestRecord>(
    `${LEAVE_SELECT}
      WHERE l.employee_id = $1
      ORDER BY l.created_at DESC, l.start_date DESC, l.id
      LIMIT $2`,
    [employeeId, limit],
  );
  return result.rows;
}

/** The HR queue: every `pending` request, oldest start date first. */
export async function listPendingApprovals(
  client: PoolClient,
  limit: number,
): Promise<ApprovalRecord[]> {
  const result = await client.query<ApprovalRecord>(
    `${APPROVAL_SELECT}
      WHERE l.status = 'pending'
      ORDER BY l.start_date, l.created_at, l.id
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/** The decided-history section: the most recently decided requests, newest first. */
export async function listDecidedApprovals(
  client: PoolClient,
  limit: number,
): Promise<ApprovalRecord[]> {
  const result = await client.query<ApprovalRecord>(
    `${APPROVAL_SELECT}
      WHERE l.status IN ('approved', 'rejected')
      ORDER BY l.decided_at DESC, l.id
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/** How many requests are waiting for a decision, for the HR overview (data contract C5). */
export async function countPendingLeave(client: PoolClient): Promise<number> {
  const result = await client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM leave_requests WHERE status = 'pending'",
  );
  return Number(result.rows[0]?.total ?? 0);
}

/** How many requests one employee has ever submitted, in any status. */
export async function countLeaveForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<number> {
  const result = await client.query<{ total: number }>(
    "SELECT count(*)::int AS total FROM leave_requests WHERE employee_id = $1",
    [employeeId],
  );
  return Number(result.rows[0]?.total ?? 0);
}
