/**
 * The one response helper every `/api/**` and `/health/**` handler uses (spec §6 S5).
 *
 * `src/proxy.ts` already adds the security header set to every non-static response, but a
 * Route Handler must not depend on a matcher staying correct: each handler sets the same
 * headers itself, so a future matcher change cannot silently make a private response
 * cacheable. `Cache-Control: no-store` and `Pragma: no-cache` are on every response here, and
 * `Vary: Cookie` keeps any shared cache from mixing two principals' answers.
 *
 * Bodies are deliberately tiny: a machine-readable code and nothing else. No SQL, no stack, no
 * row, no email, no internal detail (S6, §8 "disclose no internals").
 */

/**
 * Applied by both `src/proxy.ts` and this helper; kept in one place so they cannot drift.
 *
 * `Referrer-Policy` is `same-origin`, **not** `no-referrer`, and the difference is load-bearing:
 * Fetch's "append a request `Origin` header", step 3.1, serializes the `Origin` of a non-CORS
 * non-GET request as the literal `null` when the document's referrer policy is `no-referrer`.
 * Every native form POST in this application (login, logout, change password) is such a
 * request, so `no-referrer` made the browser send `Origin: null`, which `checkOrigin` refuses —
 * nobody could sign in from a real browser. `same-origin` sends no referrer cross-origin at all
 * (it is *stricter* than the browser default there) while leaving the real `Origin` on our own
 * form posts, and spec §6 S5 asks for a "restrictive Referrer-Policy", not for one exact value.
 *
 * There is deliberately **no `Strict-Transport-Security`** (operator decision D10): the
 * application serves plain HTTP and TLS terminates at Cloudflare, which owns HSTS for the
 * public name. A header emitted over plain HTTP is ignored by every browser anyway, and one
 * emitted through the proxy would pin a policy the application does not control. Do not
 * re-add it here — `tests/unit/auth-primitives.test.ts` asserts its absence.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

export const NO_STORE_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private",
  Pragma: "no-cache",
  Vary: "Cookie",
};

export interface ResponseOptions {
  /** `Set-Cookie` values; several are appended rather than overwritten. */
  readonly cookies?: readonly string[];
  readonly headers?: Readonly<Record<string, string>>;
}

function baseHeaders(options: ResponseOptions = {}): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headers.set(name, value);
  }
  for (const cookie of options.cookies ?? []) {
    headers.append("Set-Cookie", cookie);
  }
  return headers;
}

/** A JSON body, for the health endpoints and for programmatic callers. */
export function jsonResponse(
  status: number,
  body: unknown,
  options: ResponseOptions = {},
): Response {
  const headers = baseHeaders(options);
  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * A small HTML body, carrying the same security/no-store headers as every other response here.
 * For the rare refusal a plain, script-free `<form>` (ruling R-G) can land on directly — a real
 * browser navigating straight to this status code, never through a `fetch` caller that could
 * parse JSON and render its own banner (slice-4 "App defects found" #5). Used sparingly: a
 * JS-driven client keeps getting `problemResponse`'s JSON, which it already parses.
 */
export function htmlResponse(
  status: number,
  html: string,
  options: ResponseOptions = {},
): Response {
  const headers = baseHeaders(options);
  headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(html, { status, headers });
}

/**
 * A refusal: one machine-readable code, no detail. Used for every 4xx that is not a
 * user-recoverable form error (those redirect back to the form instead).
 */
export function problemResponse(
  status: number,
  code: string,
  options: ResponseOptions = {},
): Response {
  return jsonResponse(status, { error: code }, options);
}

/**
 * `303 See Other` - the POST/redirect/GET answer to a native form submission, so a refresh
 * never re-posts and the browser issues a fresh GET for the target page.
 */
export function seeOther(location: string, options: ResponseOptions = {}): Response {
  const headers = baseHeaders(options);
  headers.set("Location", location);
  return new Response(null, { status: 303, headers });
}

/** `429` with the `Retry-After` S6 requires; the body carries no principal and no counter. */
export function rateLimited(retryAfterSeconds: number, options: ResponseOptions = {}): Response {
  return problemResponse(429, "too_many_attempts", {
    ...options,
    headers: { ...(options.headers ?? {}), "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

/**
 * The `429` a real browser can land on directly, for the one or two routes behind a plain,
 * script-free `<form>` (ruling R-G) — `LoginForm` and `ChangePasswordForm` are both such forms,
 * so a browser submitting either one straight into a hashing-queue refusal or a login lockout
 * navigates to this response's body itself, never through a `fetch` caller that could parse
 * `rateLimited`'s JSON and render its own banner (slice-4 "App defects found" #5, extended to
 * `/api/password` in the fix round). Same status and `Retry-After` contract as `rateLimited`;
 * only the body changes, to the same "Too many attempts. Try again in N seconds." copy
 * `LeaveForm`/`EmployeeForm` already render for this status over `fetch`, so the message is
 * consistent wherever a plain form happens to land on it. `returnHref`/`returnLabel` name the
 * one link back to a page the caller can actually use next — `/login` for the login route,
 * `/me` for the password route, since a locked-out visitor there is already signed in.
 */
export function tooManyAttemptsPage(
  retryAfterSeconds: number,
  returnHref: string,
  returnLabel: string,
): Response {
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
      <p><a href="${returnHref}">${returnLabel}</a></p>
    </main>
  </body>
</html>
`;
  return htmlResponse(429, html, { headers: { "Retry-After": String(seconds) } });
}
