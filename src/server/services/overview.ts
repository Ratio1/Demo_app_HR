/**
 * The `/` overview figures (spec §2 Dashboard, §6 S4).
 *
 * Two functions, not one with a branch, so an HR total cannot reach an employee's overview by
 * accident: `hrOverview` is the only place that counts anything organization-wide, and
 * `employeeOverview` reads exactly one employee's rows — the caller's own, resolved from the
 * session's account id and never from a parameter. Spec §2: "employees only own request status,
 * never colleagues' leave or HR-only totals."
 *
 * Slice 3 replaces both of slice 2's placeholder zeros with real numbers: `pendingApprovals` is
 * the size of the approval queue, and an employee's overview now carries their own most recent
 * requests and the status of the latest one, projected through the same `OwnLeaveDTO` the
 * `/leave` page uses.
 */
import type { Pool, PoolClient } from "../db/pool.ts";

import { withClient } from "../db/pool.ts";
import type { Principal } from "../auth/session.ts";
import {
  countActiveByDepartment,
  countActiveEmployees,
  findEmployeeByAccountId,
} from "../repos/employees.ts";
import {
  countLeaveForEmployee,
  countPendingLeave,
  listLeaveForEmployee,
} from "../repos/leave.ts";
import type {
  EmployeeOverviewDTO,
  HrOverviewDTO,
  OverviewDTO,
  ReadResult,
} from "../dto/employees.ts";
import { OVERVIEW_OWN_LEAVE_LIMIT, toOwnLeave } from "../dto/leave.ts";

async function hrOverview(client: PoolClient): Promise<HrOverviewDTO> {
  const [headcount, departments, pendingApprovals] = await Promise.all([
    countActiveEmployees(client),
    countActiveByDepartment(client),
    countPendingLeave(client),
  ]);
  return { role: "hr_admin", headcount, departments, pendingApprovals };
}

async function employeeOverview(
  client: PoolClient,
  accountId: string,
): Promise<EmployeeOverviewDTO> {
  const record = await findEmployeeByAccountId(client, accountId);
  if (record === null) {
    // An account with no employee record owns no leave and is shown no totals of any kind.
    return {
      role: "employee",
      fullName: null,
      leaveRequests: 0,
      own_requests: [],
      latest_status: null,
    };
  }
  const [rows, leaveRequests] = await Promise.all([
    listLeaveForEmployee(client, record.id, OVERVIEW_OWN_LEAVE_LIMIT),
    countLeaveForEmployee(client, record.id),
  ]);
  const own_requests = rows.map(toOwnLeave);
  return {
    role: "employee",
    fullName: record.full_name,
    leaveRequests,
    own_requests,
    latest_status: own_requests[0]?.status ?? null,
  };
}

/** Any live session. The shape returned is decided by the principal's role, never by a parameter. */
export async function loadOverview(
  pool: Pool,
  principal: Principal,
): Promise<ReadResult<OverviewDTO>> {
  try {
    const data = await withClient(pool, async (client) =>
      principal.role === "hr_admin"
        ? hrOverview(client)
        : employeeOverview(client, principal.accountId),
    );
    return { kind: "ok", data };
  } catch {
    return { kind: "unavailable" };
  }
}
