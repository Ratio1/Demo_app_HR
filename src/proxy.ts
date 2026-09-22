/**
 * Response headers and the login CSRF cookie (spec §6 S3, S5; spike S4).
 *
 * The CSP block is spike S4's proven shape, unchanged: a fresh nonce per request, the inbound
 * `Content-Security-Policy` and `x-nonce` request headers stripped before ours are set (so a
 * forged header can never become the nonce Next.js renders), `style-src 'self'` with no style
 * nonce (ruling R-H), and the same policy on the request and the response.
 *
 * Added here:
 *  - the rest of the S5 header set on every non-static response, plus `no-store`;
 *  - the `__Host-csrf` double-submit cookie for `GET /login`, because a Server Component cannot
 *    set a cookie: the value is handed to the page as the `x-login-csrf` request header and
 *    `POST /api/login` requires the two to match;
 *  - a flat refusal of mutating methods outside `/api/**`, since every mutation in this
 *    application is a Node-runtime Route Handler (spec §3).
 *
 * This file is **not** the authorization boundary (spec §3): it authenticates nothing and
 * authorizes nothing. Every route re-resolves its own principal from the database.
 */
import { NextResponse, type NextRequest } from "next/server";

import {
  LOGIN_CSRF_COOKIE_NAME,
  LOGIN_CSRF_HEADER,
  LOGIN_CSRF_MAX_AGE_SECONDS,
  NONCE_HEADER,
} from "./shared/cookies";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** base64url of 32 random bytes: the same 43-character shape the session tokens use. */
function randomToken(bytes: number): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

const WELL_FORMED_CSRF = /^[A-Za-z0-9_-]{43}$/;

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64");

  const cspHeader = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  // Strip any inbound values before setting ours — CVE-2026-44581 class defence:
  // never let a forged request header reach the value Next.js parses the nonce from.
  requestHeaders.delete("content-security-policy");
  requestHeaders.delete(NONCE_HEADER);
  requestHeaders.delete(LOGIN_CSRF_HEADER);
  requestHeaders.set(NONCE_HEADER, nonce);
  requestHeaders.set("Content-Security-Policy", cspHeader);

  const pathname = request.nextUrl.pathname;

  // Every mutation is a Route Handler under /api/**; nothing else may be posted to.
  if (MUTATING_METHODS.has(request.method) && !pathname.startsWith("/api/")) {
    const refused = new NextResponse(null, { status: 405 });
    refused.headers.set("Allow", "GET, HEAD");
    applyResponseHeaders(refused, cspHeader);
    return refused;
  }

  // The login form's double-submit token. A well-formed cookie is reused so a second tab does
  // not invalidate the first; otherwise a fresh one is minted and set on the way out.
  let loginCsrf: string | undefined;
  if (request.method === "GET" && pathname === "/login") {
    const existing = request.cookies.get(LOGIN_CSRF_COOKIE_NAME)?.value;
    loginCsrf =
      existing !== undefined && WELL_FORMED_CSRF.test(existing) ? existing : randomToken(32);
    requestHeaders.set(LOGIN_CSRF_HEADER, loginCsrf);
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  applyResponseHeaders(response, cspHeader);

  if (loginCsrf !== undefined) {
    response.headers.append(
      "Set-Cookie",
      `${LOGIN_CSRF_COOKIE_NAME}=${loginCsrf}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${LOGIN_CSRF_MAX_AGE_SECONDS}`,
    );
  }

  return response;
}

/** The S5 header set. Kept identical to `SECURITY_HEADERS` in `src/server/http/response.ts`. */
function applyResponseHeaders(response: NextResponse, cspHeader: string): void {
  response.headers.set("Content-Security-Policy", cspHeader);
  response.headers.set("X-Content-Type-Options", "nosniff");
  // `same-origin`, not `no-referrer`: see the SECURITY_HEADERS comment in
  // `src/server/http/response.ts` — `no-referrer` makes a browser serialize the `Origin` of a
  // native form POST as `null` (Fetch, "append a request Origin header", step 3.1), which the
  // mutation guard refuses, so no form in this application could be submitted.
  response.headers.set("Referrer-Policy", "same-origin");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  // No `Strict-Transport-Security` (operator decision D10): plain HTTP ingress, HSTS is
  // Cloudflare's. See the SECURITY_HEADERS comment in `src/server/http/response.ts`.
  response.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  response.headers.set("Pragma", "no-cache");
  // Appended, not set: the App Router adds its own Vary values and they must survive.
  response.headers.append("Vary", "Cookie");
}

export const config = {
  matcher: ["/((?!_next/static|favicon\\.ico).*)"],
};
