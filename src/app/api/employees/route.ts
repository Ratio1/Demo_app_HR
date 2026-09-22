/**
 * `POST /api/employees` - create an employee record (spec §2, §6 S3, S4).
 *
 * Body: `code, full_name, work_email, title, department, start_date, csrf`, as JSON or as a
 * form. `account_id`, `role`, `id`, `active`, `version` or any other key is an over-post and a
 * hard `400 invalid_input` with no detail (`z.strictObject`).
 *
 * Answers: `200 {ok, location, employee}` · `400 invalid_input` (+ `fields` when the value is
 * correctable) · `401` · `403` · `409 conflict_stale` never here · `413` `415` `429` `503`.
 * The full table lives in `src/server/dto/employees.ts`.
 *
 * The handler is exported separately from `POST` so the integration suite can drive it with a
 * plain `Request` and a test pool, with no Next.js request context.
 */
import type { Pool } from "../../../server/db/pool.ts";

import { getPool } from "../../../server/db/pool.ts";
import { CapacityError } from "../../../server/auth/semaphore.ts";
import { employeeCreateSchema } from "../../../server/dto/employees.ts";
import {
  authorizeEmployeeMutation,
  employeeMutationResponse,
  invalidInputResponse,
} from "../../../server/http/employees.ts";
import { parseFields } from "../../../server/http/forms.ts";
import { rateLimited } from "../../../server/http/response.ts";
import { createEmployee } from "../../../server/services/employees.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleEmployeeCreate(request: Request, pool: Pool): Promise<Response> {
  const authorized = await authorizeEmployeeMutation(pool, request);
  if (!authorized.ok) {
    return authorized.response;
  }

  const parsed = parseFields(employeeCreateSchema, authorized.fields);
  if (!parsed.ok) {
    return parsed.reason === "unknown_key"
      ? invalidInputResponse()
      : invalidInputResponse(parsed.fields);
  }

  try {
    const result = await createEmployee(
      pool,
      { principal: authorized.principal, correlationId: authorized.correlationId },
      parsed.value,
    );
    return employeeMutationResponse(result, "created");
  } catch (error) {
    if (error instanceof CapacityError) {
      return rateLimited(error.retryAfterSeconds);
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleEmployeeCreate(request, getPool());
}
