/**
 * The shared front half of the three leave Route Handlers, and the one mapping from a leave
 * service result to an HTTP answer (spec §6 S3, S4).
 *
 * The guard order is `http/authorize.ts`'s, the same one the employee routes run, with one
 * difference per route:
 *
 *  - `POST /api/leave` and `POST /api/leave/<id>/cancel` require **a live session**, not a role:
 *    an `employee` and an `hr_admin` may both own leave (spec §2, "HR admins may also have
 *    employee records"). Whether the caller is *linked* is the service's check, not the guard's,
 *    because it is a property of the data rather than of the request.
 *  - `POST /api/leave/<id>/decision` requires `hr_admin`, refused before the id is looked at.
 *
 * One mapping function, so no handler can turn a service result into the wrong status, and the
 * `location` of a success is built **here** from the request's own id — never from anything the
 * caller sent, so there is no open-redirect surface (S3).
 */
import type { Pool } from "../db/pool.ts";

import { authorizeFieldMutation, type AuthorizedMutation } from "./authorize.ts";
import { jsonResponse, problemResponse } from "./response.ts";
import {
  savedLeaveLocation,
  type LeaveMutationResult,
  type LeaveSavedFlag,
} from "../dto/leave.ts";

export type LeaveRequestAuthorization = AuthorizedMutation;

/** Submit and cancel: any live session with a valid CSRF token. */
export async function authorizeLeaveMutation(
  pool: Pool,
  request: Request,
): Promise<LeaveRequestAuthorization> {
  return authorizeFieldMutation(pool, request);
}

/** Decide: `hr_admin` only. The self-approval bar is the service's, and is checked again there. */
export async function authorizeLeaveDecision(
  pool: Pool,
  request: Request,
): Promise<LeaveRequestAuthorization> {
  return authorizeFieldMutation(pool, request, { requireRole: "hr_admin" });
}

/**
 * The one mapping from a leave service result to an HTTP answer. A conflict carries back the
 * caller's own projection of the record — `OwnLeaveDTO` for an owner, `ApprovalDTO` for an
 * administrator — so a `409` body can never contain a field the caller was not already entitled
 * to see.
 */
export function leaveMutationResponse<T extends { readonly id: string }>(
  result: LeaveMutationResult<T>,
  saved: LeaveSavedFlag,
): Response {
  switch (result.kind) {
    case "ok":
      return jsonResponse(200, {
        ok: true,
        location: savedLeaveLocation(result.request.id, saved),
        request: result.request,
      });
    case "invalid":
      return jsonResponse(400, { error: "invalid_input", fields: result.fields });
    case "forbidden":
      return problemResponse(403, "forbidden");
    case "not_found":
      return problemResponse(404, "not_found");
    case "conflict_overlap":
      return problemResponse(409, "conflict_overlap");
    case "conflict_not_pending":
      return jsonResponse(409, { error: "conflict_not_pending", current: result.current });
    case "conflict_stale":
      return jsonResponse(409, { error: "conflict_stale", current: result.current });
    default:
      return problemResponse(503, "db_unavailable");
  }
}

/** An over-posted or duplicated key carries no detail; a correctable value carries per-field messages. */
export function invalidLeaveInputResponse(fields?: Record<string, string>): Response {
  return fields === undefined
    ? problemResponse(400, "invalid_input")
    : jsonResponse(400, { error: "invalid_input", fields });
}
