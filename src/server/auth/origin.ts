/**
 * Origin checking (spec §6 S3, S5).
 *
 * Every mutation must arrive from the exact origin the operator configured with
 * `manage set-origin`, stored in the `settings` singleton - not from an environment variable,
 * not from the `Host` header, and not from any forwarded header a proxy might have invented.
 * The reference is never *derived* from `Host`; `Host` is *compared* against it (`checkHost`,
 * below), so a request addressed to any other name - a rebound DNS name, a raw IP, the
 * container's own port - is refused as well (S5 "approved Host only").
 *
 * A missing `Origin`, the literal string `null` (a sandboxed iframe or a redirected form
 * post), and any mismatch are all refused. There is no "same-site is close enough" branch.
 *
 * That strictness constrains the response headers: a browser serializes the `Origin` of a
 * non-CORS non-GET request as the literal `null` when the *sending document* was served with
 * `Referrer-Policy: no-referrer` (Fetch, "append a request Origin header", step 3.1). Our own
 * pages therefore must not carry that value, or every native form POST to this application
 * arrives as `null_origin` and is refused — which is exactly what happened until the header was
 * changed to `same-origin` (`SECURITY_HEADERS`, `src/server/http/response.ts`). Do not relax the
 * refusal below to compensate; keep the header correct instead.
 */

export type OriginProblem = "missing" | "null_origin" | "mismatch" | "unprovisioned";

export interface OriginCheck {
  readonly ok: boolean;
  readonly problem?: OriginProblem;
}

/**
 * `settings.public_origin` as stored, compared byte for byte against the `Origin` header.
 * Both sides are trimmed of a trailing slash first, because a browser never sends one and an
 * operator might have typed one.
 */
export function normalizeOrigin(value: string): string {
  return value.trim().replace(/\/+$/u, "");
}

export function checkOrigin(
  originHeader: string | null | undefined,
  publicOrigin: string | null | undefined,
): OriginCheck {
  if (publicOrigin === null || publicOrigin === undefined || publicOrigin.trim() === "") {
    // Unprovisioned: there is no reference origin, so the guard fails closed (spec §4).
    return { ok: false, problem: "unprovisioned" };
  }
  if (originHeader === null || originHeader === undefined || originHeader === "") {
    return { ok: false, problem: "missing" };
  }
  if (originHeader === "null") {
    return { ok: false, problem: "null_origin" };
  }
  if (normalizeOrigin(originHeader) !== normalizeOrigin(publicOrigin)) {
    return { ok: false, problem: "mismatch" };
  }
  return { ok: true };
}

export type HostProblem = "mismatch" | "unprovisioned";

export interface HostCheck {
  readonly ok: boolean;
  readonly problem?: HostProblem;
}

/**
 * The `Host` a mutation was addressed to must be exactly the host (and port, if any) of the
 * configured public origin (spec §6 S5; slice 5 R, I-2).
 *
 * - The header is lowercased; the reference is `new URL(publicOrigin).host`, which the URL
 *   parser has already lowercased and stripped of a default port - which is what a browser sends.
 *   Nothing else is normalized: `hr.example.test:443` for an `https://hr.example.test` origin is
 *   a mismatch, as is a trailing dot.
 * - An absent header happens only with a `Request` built in-process (tests); a real HTTP/1.1
 *   client always sends one. Then the host of `request.url` is used. Next.js builds that URL
 *   from its own listener address, never from a request header, so the fallback cannot be
 *   steered by a client.
 * - `X-Forwarded-Host` and every other forwarded header are never consulted.
 */
export function checkHost(
  hostHeader: string | null | undefined,
  requestUrl: string,
  publicOrigin: string | null | undefined,
): HostCheck {
  if (publicOrigin === null || publicOrigin === undefined || publicOrigin.trim() === "") {
    return { ok: false, problem: "unprovisioned" };
  }
  let expected: string;
  try {
    expected = new URL(normalizeOrigin(publicOrigin)).host;
  } catch {
    // A stored value `set-origin` would never have accepted: fail closed, never throw.
    return { ok: false, problem: "mismatch" };
  }
  let presented: string;
  if (hostHeader === null || hostHeader === undefined || hostHeader === "") {
    try {
      presented = new URL(requestUrl).host;
    } catch {
      return { ok: false, problem: "mismatch" };
    }
  } else {
    presented = hostHeader.toLowerCase();
  }
  if (expected === "" || presented !== expected) {
    return { ok: false, problem: "mismatch" };
  }
  return { ok: true };
}

/**
 * The rule `manage set-origin` enforces: an absolute `scheme://host[:port]`, `http://` or
 * `https://`, for any host (operator decision D10 — the application speaks plain HTTP and TLS
 * terminates at Cloudflare, so a non-loopback `http://` origin is a normal deployment, not a
 * mistake). Nothing else changes: the stored value is still compared byte for byte by
 * `checkOrigin`, so it must be the origin the *browser* sends — behind a TLS-terminating proxy
 * that is the proxy's `https://…`, never the container's own scheme.
 */
export interface OriginValidation {
  readonly ok: boolean;
  readonly value?: string;
  readonly message?: string;
}

export function validatePublicOrigin(raw: string): OriginValidation {
  const candidate = normalizeOrigin(raw);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, message: "the origin must be an absolute URL, for example https://hr.example.test" };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    return {
      ok: false,
      message: "the origin must be scheme://host[:port] with no path, query, fragment or credentials",
    };
  }
  const authority = url.port === "" ? url.hostname : `${url.hostname}:${url.port}`;
  if (url.protocol === "https:") {
    return { ok: true, value: `https://${authority}` };
  }
  if (url.protocol === "http:") {
    return { ok: true, value: `http://${authority}` };
  }
  return { ok: false, message: "the origin must use http:// or https://" };
}
