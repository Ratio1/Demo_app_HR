/**
 * `POST /api/employees/<id>` - edit an employee record (spec §2, §6 S3, S4).
 *
 * Body: the six editable fields plus `version` and `csrf`. `version` is required on every edit;
 * if it no longer matches the row, the answer is `409 conflict_stale` with the **current**
 * record projected through `HrEmployeeDTO` - so the body of a conflict carries no field the
 * caller was not already allowed to see.
 *
 * `active` and `account_id` are not editable here: `active` changes only through
 * `/api/employees/<id>/status`, which runs the cascade, and the account link is written only by
 * `manage create-user --employee`. Both are unknown keys and a hard `400`.
 *
 * A malformed or unknown id is `404 not_found`; the role check has already refused everyone but
 * `hr_admin`, so a `404` discloses nothing an HR admin may not know.
 */
import type { Pool } from "../../../../server/db/pool.ts";

import { getPool } from "../../../../server/db/pool.ts";
import { CapacityError } from "../../../../server/auth/semaphore.ts";
import { employeeUpdateSchema } from "../../../../server/dto/employees.ts";
import {
  authorizeEmployeeMutation,
  employeeMutationResponse,
  invalidInputResponse,
} from "../../../../server/http/employees.ts";
import { parseFields } from "../../../../server/http/forms.ts";
import { rateLimited } from "../../../../server/http/response.ts";
import { updateEmployee } from "../../../../server/services/employees.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleEmployeeUpdate(
  request: Request,
  pool: Pool,
  id: string,
): Promise<Response> {
  const authorized = await authorizeEmployeeMutation(pool, request);
  if (!authorized.ok) {
    return authorized.response;
  }

  const parsed = parseFields(employeeUpdateSchema, authorized.fields);
  if (!parsed.ok) {
    return parsed.reason === "unknown_key"
      ? invalidInputResponse()
      : invalidInputResponse(parsed.fields);
  }

  try {
    const result = await updateEmployee(
      pool,
      { principal: authorized.principal, correlationId: authorized.correlationId },
      id,
      parsed.value,
    );
    return employeeMutationResponse(result, "updated");
  } catch (error) {
    if (error instanceof CapacityError) {
      return rateLimited(error.retryAfterSeconds);
    }
    throw error;
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await context.params;
  return handleEmployeeUpdate(request, getPool(), id);
}
