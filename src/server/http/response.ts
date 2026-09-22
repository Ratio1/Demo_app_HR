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

/** Applied by both `src/proxy.ts` and this helper; kept in one place so they cannot drift. */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=63072000",
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
