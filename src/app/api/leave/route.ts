/**
 * `POST /api/leave` — submit a leave request for the caller's own employee record
 * (spec §2 Leave, §6 S3, S4, S7).
 *
 * Body: `kind` (`annual` | `personal`), `start_date`, `end_date`, `csrf`, as JSON or as a form.
 * There is **no `reason` field and no other category** (spec §2: "No medical category/free-text
 * reason"), and no `employee_id`: the owner is the employee record linked to the session's
 * account. Any other key — `employee_id`, `status`, `decided_by`, `weekdays`, `version` — is an
 * over-post and a hard `400 invalid_input` with no detail (`z.strictObject`).
 *
 * Answers: `200 {ok, location, request}` · `400 invalid_input` (+ `fields` when the value is
 * correctable, including the ≥1-weekday rule reported on `end_date`) · `401` · `403` (not linked,
 * or a deactivated record) · `409 conflict_overlap` · `413` `415` `429` `503`. The full table
 * lives in `src/server/dto/leave.ts`.
 *
 * The handler is exported separately from `POST` so the integration suite can drive it with a
 * plain `Request` and a test pool, with no Next.js request context.
 */
import type { Pool } from "../../../server/db/pool.ts";

import { getPool } from "../../../server/db/pool.ts";
import { CapacityError } from "../../../server/auth/semaphore.ts";
import { leaveCreateSchema } from "../../../server/dto/leave.ts";
import { parseFields } from "../../../server/http/forms.ts";
import {
  authorizeLeaveMutation,
  invalidLeaveInputResponse,
  leaveMutationResponse,
} from "../../../server/http/leave.ts";
import { rateLimited } from "../../../server/http/response.ts";
import { submitLeave } from "../../../server/services/leave.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleLeaveCreate(request: Request, pool: Pool): Promise<Response> {
  const authorized = await authorizeLeaveMutation(pool, request);
  if (!authorized.ok) {
    return authorized.response;
  }

  const parsed = parseFields(leaveCreateSchema, authorized.fields);
  if (!parsed.ok) {
    return parsed.reason === "unknown_key"
      ? invalidLeaveInputResponse()
      : invalidLeaveInputResponse(parsed.fields);
  }

  try {
    const result = await submitLeave(
      pool,
      { principal: authorized.principal, correlationId: authorized.correlationId },
      parsed.value,
    );
    return leaveMutationResponse(result, "submitted");
  } catch (error) {
    if (error instanceof CapacityError) {
      return rateLimited(error.retryAfterSeconds);
    }
    throw error;
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleLeaveCreate(request, getPool());
}
