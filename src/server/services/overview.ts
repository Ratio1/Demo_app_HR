/**
 * The `/` overview figures (spec §2 Dashboard, §6 S4).
 *
 * Two functions, not one with a branch, so an HR total cannot reach an employee's overview by
 * accident: `hrOverview` is the only place that counts anything organization-wide, and
 * `employeeOverview` reads exactly one row — the caller's own. Spec §2: "employees only own
 * request status, never colleagues' leave or HR-only totals."
 *
 * `pendingApprovals` and `leaveRequests` are both `0` in this slice: `leave_requests` exists
 * but nothing writes to it until slice 3, and a fabricated number would be worse than an
 * honest placeholder.
 */
import type { Pool, PoolClient } from "../db/pool.ts";

import { withClient } from "../db/pool.ts";
import type { Principal } from "../auth/session.ts";
import {
  countActiveByDepartment,
  countActiveEmployees,
  findEmployeeByAccountId,
} from "../repos/employees.ts";
import type {
  EmployeeOverviewDTO,
  HrOverviewDTO,
  OverviewDTO,
  ReadResult,
} from "../dto/employees.ts";

async function hrOverview(client: PoolClient): Promise<HrOverviewDTO> {
  const [headcount, departments] = await Promise.all([
    countActiveEmployees(client),
    countActiveByDepartment(client),
  ]);
  return { role: "hr_admin", headcount, departments, pendingApprovals: 0 };
}

async function employeeOverview(
  client: PoolClient,
  accountId: string,
): Promise<EmployeeOverviewDTO> {
  const record = await findEmployeeByAccountId(client, accountId);
  return { role: "employee", fullName: record?.full_name ?? null, leaveRequests: 0 };
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
