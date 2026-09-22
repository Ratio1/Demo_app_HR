/**
 * `POST /api/leave/<id>/cancel` — the owner withdraws their own pending request
 * (spec §2 Leave, §6 S3, S4, S7).
 *
 * Body: `version`, `csrf`. `status` is deliberately not a body field: the only transition this
 * route can make is `pending → cancelled`, so there is nothing for a caller to choose.
 *
 * Cancelling is the **owner's alone**. A request belonging to someone else answers
 * `404 not_found`, not `403` — including for an `hr_admin`, who can see the request in the queue
 * but may not withdraw it: a `403` would confirm the request exists to a caller who guessed an
 * id, and existence is not theirs to learn (access matrix §1's disclosure rule).
 *
 * Answers: `200 {ok, location, request}` · `400` · `401` · `403` (bad Origin/CSRF) · `404` ·
 * `409 conflict_not_pending` (already decided or cancelled, with the current record) ·
 * `409 conflict_stale` · `413` `415` `429` `503`.
 */
import type { Pool } from "../../../../../server/db/pool.ts";

import { getPool } from "../../../../../server/db/pool.ts";
import { CapacityError } from "../../../../../server/auth/semaphore.ts";
import { leaveCancelSchema } from "../../../../../server/dto/leave.ts";
import { parseFields } from "../../../../../server/http/forms.ts";
import {
  authorizeLeaveMutation,
  invalidLeaveInputResponse,
  leaveMutationResponse,
} from "../../../../../server/http/leave.ts";
import { rateLimited } from "../../../../../server/http/response.ts";
import { cancelLeave } from "../../../../../server/services/leave.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleLeaveCancel(
  request: Request,
  pool: Pool,
  id: string,
): Promise<Response> {
  const authorized = await authorizeLeaveMutation(pool, request);
  if (!authorized.ok) {
    return authorized.response;
  }

  const parsed = parseFields(leaveCancelSchema, authorized.fields);
  if (!parsed.ok) {
    return parsed.reason === "unknown_key"
      ? invalidLeaveInputResponse()
      : invalidLeaveInputResponse(parsed.fields);
  }

  try {
    const result = await cancelLeave(
      pool,
      { principal: authorized.principal, correlationId: authorized.correlationId },
      id,
      parsed.value,
    );
    return leaveMutationResponse(result, "cancelled");
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
  return handleLeaveCancel(request, getPool(), id);
}
