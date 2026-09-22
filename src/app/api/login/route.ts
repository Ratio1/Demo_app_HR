/**
 * `POST /api/login` (spec §6 S1, S2, S3, S6).
 *
 * A native HTML form posts `email`, `password` and `csrf`. The CSRF value is the double-submit
 * pair `src/proxy.ts` minted for `GET /login`: the `__Host-csrf` cookie and the hidden field
 * must carry the same 256-bit token, and the request's `Origin` must equal
 * `settings.public_origin` exactly.
 *
 * Answers:
 *   `303 → /`                              success; `__Host-session` set, login cookie cleared
 *   `303 → /login?error=invalid_credentials`  wrong email or password (one generic answer)
 *   `303 → /login?error=invalid_input`     malformed or over-posted body
 *   `403 forbidden`                        missing/`null`/mismatched Origin, or CSRF mismatch
 *   `429 too_many_attempts` + `Retry-After` locked account, or the hashing queue is full
 *   `503 db_unavailable`                   unprovisioned or database failure
 *
 * The handler is exported separately from `POST` so the integration tests can drive it with a
 * plain `Request` and a test pool, with no Next.js request context.
 */
import type { Pool } from "../../../server/db/pool.ts";

import { getPool } from "../../../server/db/pool.ts";
import { CSRF_FIELD_NAME, LOGIN_CSRF_COOKIE_NAME, clearedLoginCsrfCookie, csrfMatches, isWellFormedToken } from "../../../server/auth/csrf.ts";
import { SESSION_COOKIE_NAME, sessionCookie } from "../../../server/auth/session.ts";
import { CapacityError } from "../../../server/auth/semaphore.ts";
import { loginForm, parseForm } from "../../../server/http/forms.ts";
import { guardMutation } from "../../../server/http/guard.ts";
import { readCookie } from "../../../server/http/request.ts";
import { problemResponse, rateLimited, seeOther } from "../../../server/http/response.ts";
import { login } from "../../../server/services/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handleLogin(request: Request, pool: Pool): Promise<Response> {
  const guard = await guardMutation(pool, request);
  if (!guard.ok) {
    return guard.response;
  }

  const cookieToken = readCookie(request, LOGIN_CSRF_COOKIE_NAME);
  const submitted = guard.context.form.get(CSRF_FIELD_NAME);
  if (!isWellFormedToken(cookieToken) || !csrfMatches(submitted, cookieToken)) {
    return problemResponse(403, "forbidden");
  }

  const parsed = parseForm(loginForm, guard.context.form);
  if (!parsed.ok) {
    // An over-posted or duplicated key is refused outright; a field the user can fix sends
    // them back to the form.
    return parsed.reason === "unknown_key"
      ? problemResponse(400, "invalid_input")
      : seeOther("/login?error=invalid_input");
  }

  try {
    const result = await login(pool, {
      email: parsed.value.email,
      password: parsed.value.password,
      correlationId: guard.context.correlationId,
      previousToken: readCookie(request, SESSION_COOKIE_NAME) ?? null,
    });

    if (result.kind === "locked") {
      return rateLimited(result.retryAfterSeconds);
    }
    if (result.kind === "invalid_credentials") {
      return seeOther("/login?error=invalid_credentials");
    }
    return seeOther("/", {
      cookies: [sessionCookie(result.token), clearedLoginCsrfCookie()],
    });
  } catch (error) {
    if (error instanceof CapacityError) {
      return rateLimited(error.retryAfterSeconds);
    }
    return problemResponse(503, "db_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleLogin(request, getPool());
}
