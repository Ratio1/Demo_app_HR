import { describe, expect, it } from "vitest";

import {
  CSRF_FIELD_NAME,
  LOGIN_CSRF_COOKIE_NAME,
  LOGIN_CSRF_HEADER,
  LOGIN_CSRF_MAX_AGE_SECONDS,
  NONCE_HEADER,
  SESSION_COOKIE_NAME,
} from "../../src/shared/cookies.js";
import { BLOCKLIST_SIZE, isBlockedPassword } from "../../src/server/auth/blocklist.js";
import {
  ARGON2_OPTIONS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  checkPasswordPolicy,
  dummyVerify,
  hashPassword,
  normalizePassword,
  verifyPassword,
} from "../../src/server/auth/password.js";
import { CapacityError, createSemaphore } from "../../src/server/auth/semaphore.js";
import { newToken, safeEqual, sha256Hex } from "../../src/server/auth/tokens.js";
import {
  clearedLoginCsrfCookie,
  csrfMatches,
  isWellFormedToken,
  loginCsrfCookie,
} from "../../src/server/auth/csrf.js";
import { checkHost, checkOrigin, validatePublicOrigin } from "../../src/server/auth/origin.js";
import { clearedSessionCookie, sessionCookie } from "../../src/server/auth/session.js";
import { MAX_BODY_BYTES, parseCookies, readFormBody } from "../../src/server/http/request.js";
import { loginForm, parseForm, passwordForm } from "../../src/server/http/forms.js";
import {
  NO_STORE_HEADERS,
  SECURITY_HEADERS,
  problemResponse,
  rateLimited,
  seeOther,
} from "../../src/server/http/response.js";

/**
 * Unit coverage for slice 1 part B's pure logic: the S1 password policy and Argon2
 * parameters, the S2/S3 token and cookie shapes, the exact-Origin rule, the strict form
 * parsers and the 64 KiB body cap. Nothing here touches a database or a network.
 *
 * A fictional but realistic password is used throughout; it exists only in this file.
 */
const GOOD_PASSWORD = "orchid-lantern-42-quay";

describe("password policy (S1)", () => {
  it("accepts a 15-128 character password", () => {
    expect(checkPasswordPolicy(GOOD_PASSWORD).ok).toBe(true);
    expect(checkPasswordPolicy("x".repeat(PASSWORD_MIN_LENGTH + 3)).ok).toBe(false); // one repeated character
    expect(checkPasswordPolicy(`${"q7w-".repeat(4)}zephyr`).ok).toBe(true);
  });

  it("refuses anything shorter than 15 or longer than 128 characters", () => {
    expect(checkPasswordPolicy("a".repeat(PASSWORD_MIN_LENGTH - 1)).problem).toBe("too_short");
    expect(checkPasswordPolicy("short").problem).toBe("too_short");
    const long = `${GOOD_PASSWORD}${"z".repeat(PASSWORD_MAX_LENGTH)}`;
    expect(checkPasswordPolicy(long).problem).toBe("too_long");
  });

  it("counts code points, not UTF-16 units, and never truncates", () => {
    const fifteenEmoji = "\u{1F332}".repeat(15);
    expect(fifteenEmoji.length).toBeGreaterThan(15); // 30 UTF-16 units
    expect(checkPasswordPolicy(fifteenEmoji).ok).toBe(false); // a single repeated character
    expect(checkPasswordPolicy(`${"\u{1F332}".repeat(8)}harbour-lamp`).ok).toBe(true);
    expect(normalizePassword(GOOD_PASSWORD)).toBe(GOOD_PASSWORD);
  });

  it("applies NFKC once, consistently", () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL LETTER A normalizes to "A" under NFKC.
    const wide = `Ａ${GOOD_PASSWORD}`;
    expect(normalizePassword(wide)).toBe(`A${GOOD_PASSWORD}`);
  });

  it("refuses control characters", () => {
    expect(checkPasswordPolicy(`${GOOD_PASSWORD}\u0007`).problem).toBe("control_characters");
  });

  it("refuses the bundled blocklist, repeated characters and monotonic runs", () => {
    expect(BLOCKLIST_SIZE).toBeGreaterThan(40);
    expect(isBlockedPassword("passwordpassword")).toBe(true);
    expect(isBlockedPassword("PassWord Password")).toBe(true); // normalized before matching
    expect(isBlockedPassword("aaaaaaaaaaaaaaaa")).toBe(true);
    expect(isBlockedPassword("abcdefghijklmnopq")).toBe(true);
    expect(isBlockedPassword("123456789012345")).toBe(true);
    expect(isBlockedPassword("1234567890123456")).toBe(true);
    expect(isBlockedPassword(GOOD_PASSWORD)).toBe(false);
    expect(checkPasswordPolicy("password12345678").problem).toBe("blocked");
  });

  it("never puts the password in the failure message", () => {
    const secret = "correcthorsebatterystaple";
    const result = checkPasswordPolicy(secret);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});

describe("Argon2id parameters (S1)", () => {
  it("hashes with memoryCost 19456, timeCost 2, parallelism 1 and a fresh salt", async () => {
    expect(ARGON2_OPTIONS.memoryCost).toBe(19456);
    expect(ARGON2_OPTIONS.timeCost).toBe(2);
    expect(ARGON2_OPTIONS.parallelism).toBe(1);

    const first = await hashPassword(GOOD_PASSWORD);
    const second = await hashPassword(GOOD_PASSWORD);
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(first).not.toBe(second); // independent salts
    expect(await verifyPassword(first, GOOD_PASSWORD)).toBe(true);
    expect(await verifyPassword(first, `${GOOD_PASSWORD}!`)).toBe(false);
  });

  it("returns false rather than throwing on a stored value that is not a hash", async () => {
    expect(await verifyPassword("not-a-hash", GOOD_PASSWORD)).toBe(false);
  });

  it("does comparable work for an unknown account", async () => {
    expect(await dummyVerify(GOOD_PASSWORD)).toBe(false);
  });
});

describe("the Argon2 semaphore (S6)", () => {
  it("runs one task at a time and queues the rest", async () => {
    const semaphore = createSemaphore({ maxActive: 1, maxQueued: 8 });
    let concurrent = 0;
    let peak = 0;
    const task = async (): Promise<void> => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 5));
      concurrent -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => semaphore.run(task)));
    expect(peak).toBe(1);
    expect(semaphore.stats.active).toBe(0);
    expect(semaphore.stats.queued).toBe(0);
  });

  it("refuses the tenth caller with a retry hint rather than queueing it", async () => {
    const semaphore = createSemaphore({ maxActive: 1, maxQueued: 8 });
    const slow = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const admitted = Array.from({ length: 9 }, () => semaphore.run(slow));
    await expect(semaphore.run(slow)).rejects.toBeInstanceOf(CapacityError);
    await Promise.all(admitted);
    const error = new CapacityError();
    expect(error.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.message).not.toMatch(/password|account|@/u);
  });
});

describe("tokens and cookies (S2, S3)", () => {
  it("mints 256-bit base64url tokens and stores only their digest", () => {
    const token = newToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Buffer.from(token, "base64url")).toHaveLength(32);
    const digest = sha256Hex(token);
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(digest).not.toContain(token);
    expect(newToken()).not.toBe(token);
  });

  it("compares in constant time and rejects length mismatches and empties", () => {
    const token = newToken();
    expect(safeEqual(token, token)).toBe(true);
    expect(safeEqual(token, `${token}x`)).toBe(false);
    expect(safeEqual("", "")).toBe(false);
    expect(csrfMatches(token, token)).toBe(true);
    expect(csrfMatches(undefined, token)).toBe(false);
    expect(csrfMatches(token, null)).toBe(false);
    expect(isWellFormedToken(token)).toBe(true);
    expect(isWellFormedToken("short")).toBe(false);
  });

  it("sets the __Host- session cookie with Secure, HttpOnly, SameSite=Lax, Path=/ and no Domain", () => {
    const cookie = sessionCookie("t".repeat(43));
    expect(cookie.startsWith(`${SESSION_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).not.toContain("Domain");
    expect(cookie).not.toContain("Max-Age"); // the lifetime lives in the database
    expect(clearedSessionCookie()).toContain("Max-Age=0");
  });

  it("gives the login double-submit cookie a ten-minute lifetime", () => {
    const cookie = loginCsrfCookie("c".repeat(43));
    expect(cookie.startsWith(`${LOGIN_CSRF_COOKIE_NAME}=`)).toBe(true);
    expect(cookie).toContain(`Max-Age=${LOGIN_CSRF_MAX_AGE_SECONDS}`);
    expect(LOGIN_CSRF_MAX_AGE_SECONDS).toBe(600);
    expect(clearedLoginCsrfCookie()).toContain("Max-Age=0");
    expect(LOGIN_CSRF_HEADER).toBe("x-login-csrf");
    expect(NONCE_HEADER).toBe("x-nonce");
    expect(CSRF_FIELD_NAME).toBe("csrf");
  });

  it("parses a Cookie header without guessing", () => {
    const jar = parseCookies("__Host-session=abc; __Host-csrf=def; broken; =nope");
    expect(jar.get("__Host-session")).toBe("abc");
    expect(jar.get("__Host-csrf")).toBe("def");
    expect(jar.size).toBe(2);
    expect(parseCookies(null).size).toBe(0);
  });
});

describe("exact Origin equality (S3)", () => {
  const configured = "https://hr.example.test";

  it("accepts only the configured origin", () => {
    expect(checkOrigin(configured, configured).ok).toBe(true);
    expect(checkOrigin(`${configured}/`, configured).ok).toBe(true);
  });

  it("refuses missing, null and mismatched origins", () => {
    expect(checkOrigin(null, configured)).toEqual({ ok: false, problem: "missing" });
    expect(checkOrigin("", configured)).toEqual({ ok: false, problem: "missing" });
    expect(checkOrigin("null", configured)).toEqual({ ok: false, problem: "null_origin" });
    expect(checkOrigin("https://evil.example.test", configured).problem).toBe("mismatch");
    expect(checkOrigin("http://hr.example.test", configured).problem).toBe("mismatch");
    expect(checkOrigin("https://hr.example.test:8443", configured).problem).toBe("mismatch");
  });

  it("fails closed while the application is unprovisioned", () => {
    expect(checkOrigin(configured, null).problem).toBe("unprovisioned");
    expect(checkOrigin(configured, "").problem).toBe("unprovisioned");
  });

  it("validates what set-origin will store", () => {
    expect(validatePublicOrigin("https://hr.example.test").value).toBe("https://hr.example.test");
    expect(validatePublicOrigin("https://hr.example.test/").value).toBe("https://hr.example.test");
    expect(validatePublicOrigin("http://127.0.0.1:3001").value).toBe("http://127.0.0.1:3001");
    expect(validatePublicOrigin("http://localhost:3001").ok).toBe(true);
    expect(validatePublicOrigin("http://[::1]:3001").ok).toBe(true);
    // D10: plain HTTP ingress — http:// is accepted for any host, port and all, because TLS
    // terminates at Cloudflare. Nothing else relaxes: the value is still an exact origin.
    expect(validatePublicOrigin("http://hr.example.test").value).toBe("http://hr.example.test");
    expect(validatePublicOrigin("http://hr.example.test:8080/").value).toBe(
      "http://hr.example.test:8080",
    );
    expect(validatePublicOrigin("https://hr.example.test/app").ok).toBe(false);
    expect(validatePublicOrigin("http://hr.example.test/app").ok).toBe(false);
    expect(validatePublicOrigin("https://user:pw@hr.example.test").ok).toBe(false);
    expect(validatePublicOrigin("ftp://hr.example.test").ok).toBe(false);
    expect(validatePublicOrigin("hr.example.test").ok).toBe(false);
  });
});

describe("exact Host equality (S5, slice 5 R I-2)", () => {
  const configured = "https://hr.example.test";
  const url = "https://hr.example.test/api/login";

  it("accepts the configured origin's host, in any letter case", () => {
    expect(checkHost("hr.example.test", url, configured)).toEqual({ ok: true });
    expect(checkHost("HR.Example.TEST", url, configured)).toEqual({ ok: true });
    expect(checkHost("127.0.0.1:3101", "http://127.0.0.1:3101/api/login", "http://127.0.0.1:3101")).toEqual({
      ok: true,
    });
    expect(checkHost("[::1]:3001", "http://[::1]:3001/api/login", "http://[::1]:3001")).toEqual({ ok: true });
  });

  it("refuses any other host or port, and does not normalize beyond letter case", () => {
    for (const host of [
      "evil.example.test",
      "hr.example.test:8443",
      "hr.example.test:443",
      "hr.example.test.",
      "127.0.0.1:3000",
      "hr.example.test.evil.example.test",
    ]) {
      expect(checkHost(host, url, configured), host).toEqual({ ok: false, problem: "mismatch" });
    }
    expect(checkHost("127.0.0.1:3000", "http://127.0.0.1:3101/", "http://127.0.0.1:3101").ok).toBe(false);
  });

  it("falls back to the request URL's host only when the header is absent", () => {
    expect(checkHost(null, url, configured).ok).toBe(true);
    expect(checkHost("", url, configured).ok).toBe(true);
    // Next.js builds request.url from its own listener, e.g. http://localhost:3000/…
    expect(checkHost(null, "http://localhost:3000/api/login", configured).problem).toBe("mismatch");
    // A present header is authoritative even when request.url would have matched.
    expect(checkHost("evil.example.test", url, configured).problem).toBe("mismatch");
  });

  it("fails closed while unprovisioned or on a stored value that is not a URL", () => {
    expect(checkHost("hr.example.test", url, null).problem).toBe("unprovisioned");
    expect(checkHost("hr.example.test", url, "").problem).toBe("unprovisioned");
    expect(checkHost("hr.example.test", url, "not a url").problem).toBe("mismatch");
  });
});

describe("strict form parsing and the body cap (S4)", () => {
  it("rejects an unknown key rather than ignoring it", () => {
    const good = new URLSearchParams({ email: "a@example.test", password: "x", csrf: "y" });
    expect(parseForm(loginForm, good).ok).toBe(true);
    const overPosted = new URLSearchParams({
      email: "a@example.test",
      password: "x",
      csrf: "y",
      role: "hr_admin",
    });
    expect(parseForm(loginForm, overPosted)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects a repeated key rather than taking one of the values", () => {
    const polluted = new URLSearchParams();
    polluted.append("email", "a@example.test");
    polluted.append("email", "b@example.test");
    polluted.append("password", "x");
    polluted.append("csrf", "y");
    expect(parseForm(loginForm, polluted)).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("requires every field of the password form and bounds their length", () => {
    expect(
      parseForm(
        passwordForm,
        new URLSearchParams({ current_password: "a", new_password: "b", csrf: "c" }),
      ).ok,
    ).toBe(true);
    expect(
      parseForm(passwordForm, new URLSearchParams({ current_password: "a", csrf: "c" })).ok,
    ).toBe(false);
    expect(
      parseForm(
        passwordForm,
        new URLSearchParams({
          current_password: "a",
          new_password: "z".repeat(5000),
          csrf: "c",
        }),
      ).ok,
    ).toBe(false);
  });

  it("refuses a body over 64 KiB while reading it, with or without Content-Length", async () => {
    const oversized = `email=${"a".repeat(MAX_BODY_BYTES + 10)}`;
    const declared = new Request("https://hr.example.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: oversized,
    });
    expect(await readFormBody(declared)).toEqual({ ok: false, reason: "too_large" });

    const chunked = new Request("https://hr.example.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("a".repeat(40_000)));
          controller.enqueue(new TextEncoder().encode("b".repeat(40_000)));
          controller.close();
        },
      }),
      // @ts-expect-error -- undici requires duplex for a streaming body; not in the DOM types.
      duplex: "half",
    });
    expect(chunked.headers.get("content-length")).toBeNull();
    expect(await readFormBody(chunked)).toEqual({ ok: false, reason: "too_large" });
  });

  it("refuses a media type it does not parse", async () => {
    const json = new Request("https://hr.example.test/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"email":"a@example.test"}',
    });
    expect(await readFormBody(json)).toEqual({ ok: false, reason: "unsupported_media_type" });
  });
});

describe("response helper (S5)", () => {
  it("puts no-store, Vary and the security headers on every response", () => {
    for (const response of [
      problemResponse(403, "forbidden"),
      seeOther("/login"),
      rateLimited(30),
    ]) {
      expect(response.headers.get("Cache-Control")).toBe(NO_STORE_HEADERS["Cache-Control"]);
      expect(response.headers.get("Pragma")).toBe("no-cache");
      expect(response.headers.get("Vary")).toBe("Cookie");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
      // D10: no HSTS — the app serves plain HTTP and Cloudflare owns the transport policy.
      // Absence is the contract, so it is asserted rather than left untested.
      expect(response.headers.get("Strict-Transport-Security")).toBeNull();
      expect(response.headers.get("Permissions-Policy")).toContain("camera=()");
    }
  });

  /**
   * Regression guard for the slice-2 review's critical finding. `no-referrer` looks like the
   * strictest choice and a later "tighten the headers" pass would reach for it, but Fetch's
   * "append a request Origin header", step 3.1, then serializes the `Origin` of every non-CORS
   * non-GET request as the literal `null` — so every native form POST in this application
   * (login, logout, change password) arrives at `checkOrigin` as `null_origin` and is refused
   * with `403`, and nobody can sign in from a browser. Measured in Chromium 149.0.7827.55
   * against a throw-away same-origin form: `no-referrer` → `Origin: null`, `same-origin` → the
   * real origin. Spec §6 S5 requires a "restrictive Referrer-Policy", which `same-origin` is: it
   * sends nothing at all cross-origin.
   */
  it("keeps a Referrer-Policy that still lets a browser send Origin on a form POST", () => {
    expect(SECURITY_HEADERS["Referrer-Policy"]).toBe("same-origin");
    expect(SECURITY_HEADERS["Referrer-Policy"]).not.toBe("no-referrer");
    // The literal `null` a `no-referrer` document would send is still refused, as it must be.
    expect(checkOrigin("null", "https://hr.example.test")).toEqual({
      ok: false,
      problem: "null_origin",
    });
  });

  it("sends Retry-After with a 429 and discloses nothing in the body", async () => {
    const response = rateLimited(42);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(await response.json()).toEqual({ error: "too_many_attempts" });
  });

  it("redirects with 303 so a refresh cannot re-post", () => {
    const response = seeOther("/me?status=password_changed");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/me?status=password_changed");
  });
});
