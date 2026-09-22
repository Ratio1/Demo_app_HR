/**
 * CSRF tokens (spec §6 S3) - "including login".
 *
 * Two shapes, because the two cases have different state:
 *
 *  - **Authenticated forms** use a synchronizer token: `sessions.csrf_token`, 256 bits, minted
 *    with the session and rendered as the hidden `csrf` field. It is *verified, never
 *    consumed*, so two tabs of the same session both work.
 *  - **The login form** has no session yet, so it uses a double-submit pair: `src/proxy.ts`
 *    mints a 256-bit value for `GET /login`, sets it as the `__Host-csrf` cookie with a
 *    ten-minute lifetime, and forwards the same value as the `x-login-csrf` request header so
 *    the page can render the hidden field. `POST /api/login` requires the two to match.
 *
 * Both are checked in addition to - never instead of - exact `Origin` equality.
 */
import {
  CSRF_FIELD_NAME,
  LOGIN_CSRF_COOKIE_NAME,
  LOGIN_CSRF_HEADER,
  LOGIN_CSRF_MAX_AGE_SECONDS,
} from "../../shared/cookies.ts";
import { safeEqual } from "./tokens.ts";

export { CSRF_FIELD_NAME, LOGIN_CSRF_COOKIE_NAME, LOGIN_CSRF_HEADER, LOGIN_CSRF_MAX_AGE_SECONDS };

/** base64url of 32 bytes: 43 characters of `A-Za-z0-9_-`. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/u;

export function isWellFormedToken(value: string | null | undefined): value is string {
  return typeof value === "string" && TOKEN_SHAPE.test(value);
}

/** Constant-time equality of a submitted token against the expected one. */
export function csrfMatches(
  submitted: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (
    submitted === null ||
    submitted === undefined ||
    expected === null ||
    expected === undefined
  ) {
    return false;
  }
  return safeEqual(submitted, expected);
}

/** The `Set-Cookie` value for the login double-submit cookie. */
export function loginCsrfCookie(token: string): string {
  return `${LOGIN_CSRF_COOKIE_NAME}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_CSRF_MAX_AGE_SECONDS}`;
}

/** Cleared once the login has been accepted, so a stale pair cannot be replayed. */
export function clearedLoginCsrfCookie(): string {
  return `${LOGIN_CSRF_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
