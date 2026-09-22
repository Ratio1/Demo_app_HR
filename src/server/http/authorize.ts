/**
 * The front half of every `/api/**` mutation handler (spec §6 S3, S4; access matrix R12).
 *
 * Extracted in slice 3 from `http/employees.ts`, where slice 2 fixed the order for the three
 * employee routes. The leave routes need the same order with a different role requirement, and an
 * authorization boundary copied into a second file is a boundary that will eventually disagree
 * with itself — so there is one function, and both surfaces call it:
 *
 *  1. `guardFieldMutation` — 64 KiB cap applied **while reading the stream**, media type
 *     (`application/json` or `application/x-www-form-urlencoded`), provisioning, then exact
 *     `Origin` equality against `settings.public_origin`;
 *  2. session — no live session is `401 unauthenticated`, never a redirect (these are `fetch`
 *     callers, and a redirect would be followed silently and land HTML in a JSON parser);
 *  3. CSRF — the session's synchronizer token, compared in constant time (`403`);
 *  4. role — when the route names one, anything else is `403 forbidden` **before** the object id
 *     is looked at, so a caller who may not use the route learns nothing about which ids exist.
 *
 * The service then re-checks everything it depends on: this is the outer gate, not the only one.
 */
import type { Pool } from "../db/pool.ts";

import { CSRF_FIELD_NAME, csrfMatches } from "../auth/csrf.ts";
import { SESSION_COOKIE_NAME, loadPrincipal, type Principal } from "../auth/session.ts";
import type { AccountRole } from "../repos/accounts.ts";
import type { BodyFields } from "./forms.ts";
import { guardFieldMutation } from "./guard.ts";
import { readCookie } from "./request.ts";
import { problemResponse } from "./response.ts";

export type AuthorizedMutation =
  | {
      readonly ok: true;
      readonly principal: Principal;
      readonly fields: BodyFields;
      readonly correlationId: string;
    }
  | { readonly ok: false; readonly response: Response };

export interface AuthorizeOptions {
  /** When set, only this role may proceed; anything else is `403` before the body is parsed. */
  readonly requireRole?: AccountRole;
}

export async function authorizeFieldMutation(
  pool: Pool,
  request: Request,
  options: AuthorizeOptions = {},
): Promise<AuthorizedMutation> {
  const guard = await guardFieldMutation(pool, request);
  if (!guard.ok) {
    return { ok: false, response: guard.response };
  }

  let principal: Principal | null;
  try {
    principal = await loadPrincipal(pool, readCookie(request, SESSION_COOKIE_NAME));
  } catch {
    return { ok: false, response: problemResponse(503, "db_unavailable") };
  }
  if (principal === null) {
    return { ok: false, response: problemResponse(401, "unauthenticated") };
  }

  if (!csrfMatches(guard.context.fields[CSRF_FIELD_NAME], principal.csrfToken)) {
    return { ok: false, response: problemResponse(403, "forbidden") };
  }

  if (options.requireRole !== undefined && principal.role !== options.requireRole) {
    return { ok: false, response: problemResponse(403, "forbidden") };
  }

  return {
    ok: true,
    principal,
    fields: guard.context.fields,
    correlationId: guard.context.correlationId,
  };
}
