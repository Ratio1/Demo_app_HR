/**
 * Employee rows: the only module that writes `employees` (spec §2, §5).
 *
 * Every statement is parameterised and every read projects the exact column list
 * `EmployeeRecord` declares — including the linked account's email through a `LEFT JOIN`, so
 * `account_id` never has to leave this layer as a UUID.
 *
 * Two rules the callers depend on:
 *
 *  - **`start_date` is a string.** The pool registers a DATE type parser that hands the value
 *    back exactly as PostgreSQL wrote it (`src/server/db/pool.ts`), so `YYYY-MM-DD` travels
 *    from the column to the DTO without ever becoming a `Date` (spec §2).
 *  - **`lockEmployee` is taken first.** Every mutation in `services/employees.ts` opens with
 *    `SELECT … FOR UPDATE` on the employee row, so the version it then compares cannot move
 *    under it. The deactivation cascade takes the `settings` row lock afterwards, inside
 *    `disableAccount`: the lock order is always **employee row → settings row**, and nothing in
 *    this application takes them the other way round.
 */
import { randomUUID } from "node:crypto";

import type { PoolClient } from "../db/pool.ts";
import type { EmployeeRecord } from "../dto/employees.ts";

/** The exact projection `EmployeeRecord` names; no `SELECT *` anywhere. */
const EMPLOYEE_SELECT = `SELECT e.id, e.code, e.full_name, e.work_email, e.title, e.department,
              e.start_date, e.active, e.account_id, a.email AS account_email, e.version
         FROM employees e
         LEFT JOIN accounts a ON a.id = e.account_id`;

/** Canonical 8-4-4-4-12 hex form. A malformed id is never sent to the database. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function isEmployeeId(value: string): boolean {
  return UUID_SHAPE.test(value);
}

export interface EmployeeLockRow {
  readonly id: string;
  readonly version: number;
  readonly active: boolean;
  readonly account_id: string | null;
}

/**
 * Serializes every change to one employee (the D8 row-lock ruling). Returns `null` when no row
 * has that id, which the services turn into `404 not_found`.
 */
export async function lockEmployee(
  client: PoolClient,
  id: string,
): Promise<EmployeeLockRow | null> {
  if (!isEmployeeId(id)) {
    return null;
  }
  const result = await client.query<EmployeeLockRow>(
    "SELECT id, version, active, account_id FROM employees WHERE id = $1 FOR UPDATE",
    [id],
  );
  return result.rows[0] ?? null;
}

export async function findEmployeeById(
  client: PoolClient,
  id: string,
): Promise<EmployeeRecord | null> {
  if (!isEmployeeId(id)) {
    return null;
  }
  const result = await client.query<EmployeeRecord>(`${EMPLOYEE_SELECT} WHERE e.id = $1`, [id]);
  return result.rows[0] ?? null;
}

/** The record linked to an account, or `null` for an account with no employee row. */
export async function findEmployeeByAccountId(
  client: PoolClient,
  accountId: string,
): Promise<EmployeeRecord | null> {
  const result = await client.query<EmployeeRecord>(`${EMPLOYEE_SELECT} WHERE e.account_id = $1`, [
    accountId,
  ]);
  return result.rows[0] ?? null;
}

/** Every employee, active and inactive: the HR list only. */
export async function listEmployees(client: PoolClient): Promise<EmployeeRecord[]> {
  const result = await client.query<EmployeeRecord>(
    `${EMPLOYEE_SELECT} ORDER BY e.active DESC, e.full_name, e.code`,
  );
  return result.rows;
}

/**
 * Active employees only, with `active = true` applied **in SQL** rather than filtered after
 * projection: the directory of an `employee` must not fetch a hidden row at all (spec §3).
 */
export async function listActiveEmployees(client: PoolClient): Promise<EmployeeRecord[]> {
  const result = await client.query<EmployeeRecord>(
    `${EMPLOYEE_SELECT} WHERE e.active = true ORDER BY e.full_name, e.code`,
  );
  return result.rows;
}

/**
 * Whether another row already holds this code. `exceptId` lets an edit keep its own value.
 * The comparison is exact, matching the `employees_code_key` unique constraint; work emails
 * are compared lowercased, matching `employees_work_email_lowercase`.
 */
export async function isCodeTaken(
  client: PoolClient,
  code: string,
  exceptId?: string,
): Promise<boolean> {
  const result = await client.query<{ one: number }>(
    exceptId === undefined
      ? "SELECT 1 AS one FROM employees WHERE code = $1"
      : "SELECT 1 AS one FROM employees WHERE code = $1 AND id <> $2",
    exceptId === undefined ? [code] : [code, exceptId],
  );
  return result.rows.length > 0;
}

export async function isWorkEmailTaken(
  client: PoolClient,
  workEmail: string,
  exceptId?: string,
): Promise<boolean> {
  const result = await client.query<{ one: number }>(
    exceptId === undefined
      ? "SELECT 1 AS one FROM employees WHERE work_email = $1"
      : "SELECT 1 AS one FROM employees WHERE work_email = $1 AND id <> $2",
    exceptId === undefined ? [workEmail] : [workEmail, exceptId],
  );
  return result.rows.length > 0;
}

export interface EmployeeWriteInput {
  readonly code: string;
  readonly full_name: string;
  readonly work_email: string;
  readonly title: string;
  readonly department: string;
  /** ISO `YYYY-MM-DD`, passed as a string parameter and cast by the column's type. */
  readonly start_date: string;
}

/**
 * Inserts an employee. `account_id` is not a parameter at all: the link is written only by
 * `linkEmployeeAccount`, which `manage create-user --employee` calls (spec §2).
 */
export async function insertEmployee(
  client: PoolClient,
  input: EmployeeWriteInput,
): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO employees
       (id, code, full_name, work_email, title, department, start_date, active, version, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, true, 1, now(), now())`,
    [
      id,
      input.code,
      input.full_name,
      input.work_email,
      input.title,
      input.department,
      input.start_date,
    ],
  );
  return id;
}

/**
 * Applies an edit guarded by the expected version, bumping `version` and `updated_at` in the
 * same statement. Returns the number of rows changed: `0` means the version moved, which the
 * caller answers with `409 conflict_stale`.
 */
export async function updateEmployeeFields(
  client: PoolClient,
  id: string,
  expectedVersion: number,
  input: EmployeeWriteInput,
): Promise<number> {
  const result = await client.query(
    `UPDATE employees
        SET code = $3, full_name = $4, work_email = $5, title = $6, department = $7,
            start_date = $8, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2`,
    [
      id,
      expectedVersion,
      input.code,
      input.full_name,
      input.work_email,
      input.title,
      input.department,
      input.start_date,
    ],
  );
  return result.rowCount ?? 0;
}

/** The `active` flag is written only here and only by the status route's cascade. */
export async function setEmployeeActive(
  client: PoolClient,
  id: string,
  expectedVersion: number,
  active: boolean,
): Promise<number> {
  const result = await client.query(
    `UPDATE employees
        SET active = $3, version = version + 1, updated_at = now()
      WHERE id = $1 AND version = $2`,
    [id, expectedVersion, active],
  );
  return result.rowCount ?? 0;
}

/**
 * Cancels every pending leave request of one employee, returning the ids so the caller can
 * write one audit row per cancelled request under the same correlation id. Approved, rejected
 * and already-cancelled requests are untouched (spec §2: "completed history remains").
 */
export async function cancelPendingLeaveFor(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const result = await client.query<{ id: string }>(
    `UPDATE leave_requests
        SET status = 'cancelled', version = version + 1
      WHERE employee_id = $1 AND status = 'pending'
      RETURNING id`,
    [employeeId],
  );
  return result.rows.map((row) => row.id);
}

export type LinkEmployeeOutcome = "linked" | "not_found" | "already_linked" | "inactive";

/**
 * Links an account to an employee record, refusing a code that does not exist, already has a
 * login, or belongs to a deactivated employee. All three conditions are in the `WHERE` clause,
 * so the check and the write are one statement and cannot race; the diagnosis afterwards only
 * decides which message the operator sees.
 */
export async function linkEmployeeAccount(
  client: PoolClient,
  code: string,
  accountId: string,
): Promise<LinkEmployeeOutcome> {
  const linked = await client.query(
    `UPDATE employees
        SET account_id = $1, updated_at = now(), version = version + 1
      WHERE code = $2 AND account_id IS NULL AND active = true`,
    [accountId, code],
  );
  if ((linked.rowCount ?? 0) === 1) {
    return "linked";
  }
  const existing = await client.query<{ active: boolean; account_id: string | null }>(
    "SELECT active, account_id FROM employees WHERE code = $1",
    [code],
  );
  const row = existing.rows[0];
  if (row === undefined) {
    return "not_found";
  }
  if (row.account_id !== null) {
    return "already_linked";
  }
  return "inactive";
}

export async function countActiveEmployees(client: PoolClient): Promise<number> {
  const result = await client.query<{ total: string }>(
    "SELECT count(*) AS total FROM employees WHERE active = true",
  );
  return Number(result.rows[0]?.total ?? "0");
}

export interface DepartmentCount {
  readonly department: string;
  readonly count: number;
}

export async function countActiveByDepartment(client: PoolClient): Promise<DepartmentCount[]> {
  const result = await client.query<{ department: string; total: string }>(
    `SELECT department, count(*) AS total
       FROM employees
      WHERE active = true
      GROUP BY department
      ORDER BY department`,
  );
  return result.rows.map((row) => ({ department: row.department, count: Number(row.total) }));
}

/**
 * Which field a `23505` unique violation was about, so a lost race produces the same per-field
 * message as the pre-check inside the transaction. The constraint names come from
 * `migrations/0001_init.sql`.
 */
export function uniqueViolationField(error: unknown): "code" | "work_email" | null {
  const candidate = error as { code?: unknown; constraint?: unknown } | null;
  if (candidate === null || typeof candidate !== "object" || candidate.code !== "23505") {
    return null;
  }
  if (candidate.constraint === "employees_code_key") {
    return "code";
  }
  if (candidate.constraint === "employees_work_email_key") {
    return "work_email";
  }
  return null;
}
