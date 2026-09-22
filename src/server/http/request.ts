/**
 * Request reading for Route Handlers (spec §6 S4).
 *
 * Two jobs, both done before anything is parsed:
 *
 *  - **cookies** are read from the raw `Cookie` header rather than from `next/headers`, so the
 *    handlers stay plain `(Request) => Response` functions that the integration tests can call
 *    directly, with no Next.js request context;
 *  - **bodies are capped at 64 KiB while they are being read**, not by trusting
 *    `Content-Length`: a chunked request carries no length header, so the cap is enforced on
 *    the stream and the read is abandoned the moment it is exceeded.
 *
 * Only `application/x-www-form-urlencoded` is accepted. The application posts native HTML
 * forms; nothing needs multipart, and a narrower parser is a smaller surface.
 */

/** Spec §6 S4 / access matrix §2.1: 64 KiB, a code constant. */
export const MAX_BODY_BYTES = 64 * 1024;

export const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export type BodyResult =
  | { readonly ok: true; readonly form: URLSearchParams }
  | { readonly ok: false; readonly reason: "too_large" | "unsupported_media_type" | "unreadable" };

/** Parses a `Cookie` header. Unknown, duplicate or malformed pairs are ignored, not guessed. */
export function parseCookies(header: string | null | undefined): Map<string, string> {
  const jar = new Map<string, string>();
  if (header === null || header === undefined || header === "") {
    return jar;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) {
      continue;
    }
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name !== "" && !jar.has(name)) {
      jar.set(name, value);
    }
  }
  return jar;
}

export function readCookie(request: Request, name: string): string | undefined {
  return parseCookies(request.headers.get("cookie")).get(name);
}

function isFormContentType(header: string | null): boolean {
  if (header === null) {
    return false;
  }
  const type = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type === FORM_CONTENT_TYPE;
}

/**
 * Reads the body with the cap enforced on the stream, then parses it as a form. A declared
 * `Content-Length` over the cap is refused without reading anything at all.
 */
export async function readFormBody(
  request: Request,
  maxBytes: number = MAX_BODY_BYTES,
): Promise<BodyResult> {
  if (!isFormContentType(request.headers.get("content-type"))) {
    return { ok: false, reason: "unsupported_media_type" };
  }

  const declared = request.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/u.test(declared) && Number(declared) > maxBytes) {
    return { ok: false, reason: "too_large" };
  }

  const body = request.body;
  let text: string;
  if (body === null) {
    text = "";
  } else {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel();
            return { ok: false, reason: "too_large" };
          }
          chunks.push(value);
        }
      }
    } catch {
      return { ok: false, reason: "unreadable" };
    }
    text = Buffer.concat(chunks).toString("utf8");
  }

  try {
    return { ok: true, form: new URLSearchParams(text) };
  } catch {
    return { ok: false, reason: "unreadable" };
  }
}

/** A single form field as a trimmed string, or `""` when absent or repeated with no value. */
export function field(form: URLSearchParams, name: string): string {
  return form.get(name) ?? "";
}
