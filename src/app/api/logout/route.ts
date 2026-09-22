/**
 * `POST /api/logout` (spec §6 S2, S3, S5).
 *
 * The session is revoked **server-side** in the database; the expiring cookie and
 * `Clear-Site-Data` are defence in depth, never the mechanism (ruling R-G). Logging out on one
 * replica therefore logs the account out on the other one too.
 *
 * Answers:
 *   `303 → /login`  always, whether or not a session was present (logout is idempotent)
 *   `403 forbidden` bad Origin, or a live session whose CSRF token does not match
 *   `503 db_unavailable` unprovisioned or database failure
 */
import type { Pool } from "../../../server/db/pool.ts";

import { getPool } from "../../../server/db/pool.ts";
import { CSRF_FIELD_NAME, csrfMatches } from "../../../server/auth/csrf.ts";
import {
  SESSION_COOKIE_NAME,
  clearedSessionCookie,
  loadPrincipal,
} from "../../../server/auth/session.ts";
import { guardMutation } from "../../../server/http/guard.ts";
import { readCookie } from "../../../server/http/request.ts";
import { problemResponse, seeOther } from "../../../server/http/response.ts";
import { logout } from "../../../server/services/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Cleared cookies plus the cache directives a logout must carry (S5). */
const LOGOUT_RESPONSE = {
  cookies: [clearedSessionCookie()],
  headers: { "Clear-Site-Data": '"cache", "cookies"' },
} as const;

export async function handleLogout(request: Request, pool: Pool): Promise<Response> {
  const guard = await guardMutation(pool, request);
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const principal = await loadPrincipal(pool, readCookie(request, SESSION_COOKIE_NAME));
    if (principal === null) {
      // No live session: still clear the cookie and send the browser to /login.
      return seeOther("/login", LOGOUT_RESPONSE);
    }

    if (!csrfMatches(guard.context.form.get(CSRF_FIELD_NAME), principal.csrfToken)) {
      return problemResponse(403, "forbidden");
    }

    await logout(pool, { principal, correlationId: guard.context.correlationId });
    return seeOther("/login", LOGOUT_RESPONSE);
  } catch {
    return problemResponse(503, "db_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleLogout(request, getPool());
}
