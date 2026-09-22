/**
 * `POST /api/employees/<id>/status` - activate or deactivate (spec §2, §6 S3, S4, S7).
 *
 * Body: `action` (`activate` | `deactivate`), `version`, `csrf`. `active` is deliberately not a
 * body field: the change has to run the deactivation cascade and the last-active-HR-admin
 * re-count, so it cannot be a column an editor writes.
 *
 * Deactivation is one transaction (see `services/employees.ts`): the record is hidden from the
 * directory, the linked login is disabled, every session of that account is revoked and the
 * employee's pending leave is cancelled, with one audit row per effect under one correlation
 * id. If that would leave no active HR administrator the whole transaction rolls back and the
 * answer is `409 conflict_last_admin` - nothing written.
 *
 * Answers: `200 {ok, location, employee}` · `400` · `401` · `403` · `404` ·
 * `409 conflict_stale` (with the current record) · `409 conflict_last_admin` · `413` `415`
 * `429` `503`.
 */
import type { Pool } from "../../../../../server/db/pool.ts";

import { getPool } from "../../../../../server/db/pool.ts";
import { CapacityError } from "../../../../../server/auth/semaphore.ts";
import { employeeStatusSchema } from "../../../../../server/dto/employees.ts";
import {
  authorizeEmployeeMutation,
  employeeMutationResponse,
  invalidInputResponse,
} from "../../../../../server/http/employees.ts";
import { parseFields } from "../../../../../server/http/forms.ts";
import { rateLimited } from "../../../../../server/http/response.ts";
import { setEmployeeStatus } from "../../../../../server/services/employees.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleEmployeeStatus(
  request: Request,
  pool: Pool,
  id: string,
): Promise<Response> {
  const authorized = await authorizeEmployeeMutation(pool, request);
  if (!authorized.ok) {
    return authorized.response;
  }

  const parsed = parseFields(employeeStatusSchema, authorized.fields);
  if (!parsed.ok) {
    return parsed.reason === "unknown_key"
      ? invalidInputResponse()
      : invalidInputResponse(parsed.fields);
  }

  try {
    const result = await setEmployeeStatus(
      pool,
      { principal: authorized.principal, correlationId: authorized.correlationId },
      id,
      parsed.value,
    );
    return employeeMutationResponse(result, "status");
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
  return handleEmployeeStatus(request, getPool(), id);
}
