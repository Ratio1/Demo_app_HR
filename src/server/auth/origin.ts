/**
 * Origin checking (spec §6 S3, S5).
 *
 * Every mutation must arrive from the exact origin the operator configured with
 * `manage set-origin`, stored in the `settings` singleton - not from an environment variable,
 * not from the `Host` header, and not from any forwarded header a proxy might have invented.
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

/**
 * The rule `manage set-origin` enforces: HTTPS everywhere, with plain HTTP allowed only for
 * the three loopback authorities, so a local demo works without inventing a certificate while
 * a deployed instance cannot be pointed at an http:// origin by accident.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

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
    if (!LOOPBACK_HOSTS.has(url.hostname)) {
      return {
        ok: false,
        message: "http:// is allowed only for 127.0.0.1, localhost or [::1]; use https:// otherwise",
      };
    }
    return { ok: true, value: `http://${authority}` };
  }
  return { ok: false, message: "the origin must use https:// (or http:// on loopback)" };
}
