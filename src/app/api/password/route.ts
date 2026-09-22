/**
 * `POST /api/password` - the change-password route (spec §6 S1, S2, S3).
 *
 * The form posts `current_password`, `new_password` and `csrf`, where `csrf` is the
 * synchronizer token of the caller's own session (`principal.csrfToken`). On success the
 * password is replaced, **every** session of the account is revoked and a fresh one is issued
 * in the same transaction, so other devices are signed out and this browser is not.
 *
 * Answers:
 *   `303 → /me?status=password_changed`        success; a new `__Host-session` is set
 *   `303 → /me?error=invalid_current_password` the current password did not verify
 *   `303 → /me?error=weak_password`            the new password fails the S1 policy
 *   `303 → /me?error=password_unchanged`       the new password equals the old one
 *   `303 → /me?error=invalid_input`            malformed or over-posted body
 *   `401 unauthenticated` / `403 forbidden`    no live session / bad Origin or CSRF
 *   `429` + `Retry-After`                      the hashing queue is full — a small HTML page,
 *                                               not `{"error":...}`: `ChangePasswordForm` is a
 *                                               plain, script-free form (ruling R-G), same as
 *                                               `/api/login`'s own lockout page (slice-4 "App
 *                                               defects found" #5, extended here in the fix
 *                                               round — see `tooManyAttemptsPage`)
 */
import type { Pool } from "../../../server/db/pool.ts";

import { getPool } from "../../../server/db/pool.ts";
import { CSRF_FIELD_NAME, csrfMatches } from "../../../server/auth/csrf.ts";
import { SESSION_COOKIE_NAME, loadPrincipal, sessionCookie } from "../../../server/auth/session.ts";
import { CapacityError } from "../../../server/auth/semaphore.ts";
import { parseForm, passwordForm } from "../../../server/http/forms.ts";
import { guardMutation } from "../../../server/http/guard.ts";
import { readCookie } from "../../../server/http/request.ts";
import { problemResponse, seeOther, tooManyAttemptsPage } from "../../../server/http/response.ts";
import { changePassword } from "../../../server/services/auth.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function handlePasswordChange(request: Request, pool: Pool): Promise<Response> {
  const guard = await guardMutation(pool, request);
  if (!guard.ok) {
    return guard.response;
  }

  try {
    const principal = await loadPrincipal(pool, readCookie(request, SESSION_COOKIE_NAME));
    if (principal === null) {
      return problemResponse(401, "unauthenticated");
    }

    if (!csrfMatches(guard.context.form.get(CSRF_FIELD_NAME), principal.csrfToken)) {
      return problemResponse(403, "forbidden");
    }

    const parsed = parseForm(passwordForm, guard.context.form);
    if (!parsed.ok) {
      return parsed.reason === "unknown_key"
        ? problemResponse(400, "invalid_input")
        : seeOther("/me?error=invalid_input");
    }

    const result = await changePassword(pool, {
      principal,
      currentPassword: parsed.value.current_password,
      newPassword: parsed.value.new_password,
      correlationId: guard.context.correlationId,
    });

    switch (result.kind) {
      case "ok":
        return seeOther("/me?status=password_changed", {
          cookies: [sessionCookie(result.token)],
        });
      case "weak_password":
        return seeOther("/me?error=weak_password");
      case "unchanged":
        return seeOther("/me?error=password_unchanged");
      default:
        return seeOther("/me?error=invalid_current_password");
    }
  } catch (error) {
    if (error instanceof CapacityError) {
      return tooManyAttemptsPage(error.retryAfterSeconds, "/me", "Return to your account");
    }
    return problemResponse(503, "db_unavailable");
  }
}

export async function POST(request: Request): Promise<Response> {
  return handlePasswordChange(request, getPool());
}
