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
 *   `429` + `Retry-After`                   locked account, or the hashing queue is full — a
 *                                           small HTML page, not `{"error":...}`: `LoginForm` is
 *                                           a plain, script-free form (ruling R-G), so a real
 *                                           browser navigates straight to this body and never
 *                                           gets to parse JSON (see `lockedOutPage` below)
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
import { htmlResponse, problemResponse, seeOther } from "../../../server/http/response.ts";
import { login } from "../../../server/services/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The `429` a real browser lands on directly (see the file doc comment). Same status and
 * `Retry-After` contract as `rateLimited` elsewhere in the app; only the body changes, to the
 * same "Too many attempts. Try again in N seconds." copy `LeaveForm`/`EmployeeForm` already
 * render for this status when it arrives over `fetch`, so the message is consistent whichever
 * transport happens to answer it. No stylesheet is linked — this response is not part of the
 * app shell — but the markup carries no inline script or style either way.
 */
function lockedOutPage(retryAfterSeconds: number): Response {
  const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Too many attempts — Demo_App_HR</title>
  </head>
  <body>
    <main>
      <h1>Too many attempts</h1>
      <p role="alert">Too many attempts. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.</p>
      <p><a href="/login">Return to sign in</a></p>
    </main>
  </body>
</html>
`;
  return htmlResponse(429, html, { headers: { "Retry-After": String(seconds) } });
}

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
      return lockedOutPage(result.retryAfterSeconds);
    }
    if (result.kind === "invalid_credentials") {
      return seeOther("/login?error=invalid_credentials");
    }
    return seeOther("/", {
      cookies: [sessionCookie(result.token), clearedLoginCsrfCookie()],
    });
  } catch (error) {
    if (error instanceof CapacityError) {
      return lockedOutPage(error.retryAfterSeconds);
    }
    return problemResponse(503, "db_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handleLogin(request, getPool());
}
