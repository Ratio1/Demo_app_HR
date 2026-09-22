/**
 * `POST /api/leave/<id>/decision` — an `hr_admin` approves or rejects a pending request
 * (spec §2 Leave, §6 S3, S4, S7).
 *
 * Body: `action` (`approve` | `reject`), `version`, `csrf`. `status`, `decided_by` and
 * `decided_at` are not body fields: who decided is the session's account and when is the server's
 * clock, so neither can be supplied by a caller.
 *
 * **Self-approval is barred** (spec §2: "An HR admin's request needs a different HR admin; never
 * bypass self-approval"). The service compares the request's `employee_id` against the deciding
 * administrator's own linked employee record *before* it considers the request's state, answers
 * `403 forbidden`, and writes a `denied` audit row. The `own` flag on `ApprovalDTO` lets the page
 * disable the button, but the button is not the control.
 *
 * Answers: `200 {ok, location, request}` · `400` · `401` · `403` (not `hr_admin`, bad
 * Origin/CSRF, or self-approval) · `404` · `409 conflict_not_pending` (the racing decision's
 * loser, with the current record) · `409 conflict_stale` · `413` `415` `429` `503`.
 */
import type { Pool } from "../../../../../server/db/pool.ts";

import { getPool } from "../../../../../server/db/pool.ts";
import { CapacityError } from "../../../../../server/auth/semaphore.ts";
import { leaveDecisionSchema } from "../../../../../server/dto/leave.ts";
import { parseFields } from "../../../../../server/http/forms.ts";
import {
  authorizeLeaveDecision,
  invalidLeaveInputResponse,
  leaveMutationResponse,
} from "../../../../../server/http/leave.ts";
import { rateLimited } from "../../../../../server/http/response.ts";
import { decideLeave } from "../../../../../server/services/leave.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleLeaveDecision(
  request: Request,
  pool: Pool,
  id: string,
): Promise<Response> {
  const authorized = await authorizeLeaveDecision(pool, request);
  if (!authorized.ok) {
    return authorized.response;
  }

  const parsed = parseFields(leaveDecisionSchema, authorized.fields);
  if (!parsed.ok) {
    return parsed.reason === "unknown_key"
      ? invalidLeaveInputResponse()
      : invalidLeaveInputResponse(parsed.fields);
  }

  try {
    const result = await decideLeave(
      pool,
      { principal: authorized.principal, correlationId: authorized.correlationId },
      id,
      parsed.value,
    );
    return leaveMutationResponse(result, parsed.value.action === "approve" ? "approved" : "rejected");
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
  return handleLeaveDecision(request, getPool(), id);
}
