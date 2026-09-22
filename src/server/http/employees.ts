/**
 * The shared front half of the three employee Route Handlers (spec §6 S3, S4).
 *
 * One function, so the three routes cannot drift in the order they refuse things, and one
 * mapping from `EmployeeMutationResult` to a status, so a service result can never be turned
 * into the wrong answer by a handler:
 *
 *  1. `guardFieldMutation` - 64 KiB cap on the stream, media type, provisioning, exact `Origin`;
 *  2. session - no live session is `401 unauthenticated`, never a redirect (these are `fetch`
 *     callers, and a redirect would be followed silently);
 *  3. CSRF - the session's synchronizer token, compared in constant time (`403`);
 *  4. role - anything but `hr_admin` is `403 forbidden` **before** the id is looked at, so an
 *     `employee` learns nothing about which ids exist (the slice brief's rule: any employee
 *     mutation, or another employee's record, is `403`).
 *
 * The service then re-checks the role itself: this is the outer gate, not the only one.
 */
import type { Pool } from "../db/pool.ts";

import { authorizeFieldMutation, type AuthorizedMutation } from "./authorize.ts";
import { jsonResponse, problemResponse } from "./response.ts";
import { savedLocation, type EmployeeMutationResult } from "../dto/employees.ts";

export type EmployeeRequest = AuthorizedMutation;

/**
 * Steps 1–4 with `hr_admin` required. Slice 3 moved the steps themselves into
 * `http/authorize.ts`, which `http/leave.ts` shares; the order and every refusal are unchanged.
 */
export async function authorizeEmployeeMutation(
  pool: Pool,
  request: Request,
): Promise<EmployeeRequest> {
  return authorizeFieldMutation(pool, request, { requireRole: "hr_admin" });
}

/**
 * The one mapping from a service result to an HTTP answer. `location` is built here from the
 * employee's own id, never from anything the caller sent, so the redirect target cannot be
 * steered (no open redirect, spec §6 S3).
 */
export function employeeMutationResponse(
  result: EmployeeMutationResult,
  saved: "created" | "updated" | "status",
): Response {
  switch (result.kind) {
    case "ok":
      return jsonResponse(200, {
        ok: true,
        location: savedLocation(result.employee.id, saved),
        employee: result.employee,
      });
    case "invalid":
      return jsonResponse(400, { error: "invalid_input", fields: result.fields });
    case "forbidden":
      return problemResponse(403, "forbidden");
    case "not_found":
      return problemResponse(404, "not_found");
    case "conflict_stale":
      return jsonResponse(409, { error: "conflict_stale", current: result.current });
    case "conflict_last_admin":
      return problemResponse(409, "conflict_last_admin");
    default:
      return problemResponse(503, "db_unavailable");
  }
}

/** An over-posted or duplicated key carries no detail; a correctable value carries per-field messages. */
export function invalidInputResponse(fields?: Record<string, string>): Response {
  return fields === undefined
    ? problemResponse(400, "invalid_input")
    : jsonResponse(400, { error: "invalid_input", fields });
}
