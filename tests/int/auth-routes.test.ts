import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, withClient, withTransaction, type Pool } from "../../src/server/db/pool.ts";
import { runMigrations, deriveAppRole } from "../../src/server/db/migrate.ts";
import { APP_ENV_FILE, DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.ts";
import { handleLogin } from "../../src/app/api/login/route.ts";
import { handleLogout } from "../../src/app/api/logout/route.ts";
import { handlePasswordChange } from "../../src/app/api/password/route.ts";
import { readiness } from "../../src/app/health/ready/route.ts";
import { GET as healthLive } from "../../src/app/health/live/route.ts";
import { LOGIN_CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/shared/cookies.ts";
import { loadPrincipal } from "../../src/server/auth/session.ts";
import { newToken, sha256Hex } from "../../src/server/auth/tokens.ts";
import { bootstrap } from "../../src/server/services/accounts.ts";
import { MAX_FAILED_LOGINS } from "../../src/server/repos/accounts.ts";

/**
 * Integration coverage for the three authentication routes, driven as plain
 * `(Request, Pool)` functions against the `hr_test` database (spec §6 S1-S3, S5-S7).
 *
 * The routes run on the **runtime** role's pool, exactly as the server does, so anything the
 * grants forbid fails here rather than in production. Provisioning runs on the owner pool,
 * exactly as `manage` does.
 *
 * All data is fictional and every address is `example.test`. The two passwords below exist
 * only in this file and in the `hr_test` database.
 */
const ADMIN_EMAIL = "ada.first@example.test";
const ADMIN_PASSWORD = "quartz-harbour-19-lane";
const NEW_PASSWORD = "velvet-meridian-7-brook";
const PUBLIC_ORIGIN = "https://hr.example.test";

let ownerPool: Pool;
let appPool: Pool;

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

interface RequestOptions {
  readonly origin?: string | null;
  readonly cookies?: Record<string, string>;
  readonly contentType?: string;
}

function post(path: string, body: string, options: RequestOptions = {}): Request {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
  });
  const origin = options.origin === undefined ? PUBLIC_ORIGIN : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const cookies = Object.entries(options.cookies ?? {});
  if (cookies.length > 0) {
    headers.set("cookie", cookies.map(([name, value]) => `${name}=${value}`).join("; "));
  }
  return new Request(`${PUBLIC_ORIGIN}${path}`, { method: "POST", headers, body });
}

/** The `__Host-session` value a response set, or undefined. */
function sessionCookieValue(response: Response): string | undefined {
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      const value = header.slice(SESSION_COOKIE_NAME.length + 1).split(";", 1)[0];
      return value === "" ? undefined : value;
    }
  }
  return undefined;
}

/** A successful login, returning the session token the browser would now hold. */
async function logIn(password = ADMIN_PASSWORD): Promise<string> {
  const csrf = newToken();
  const response = await handleLogin(
    post("/api/login", form({ email: ADMIN_EMAIL, password, csrf }), {
      cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
    }),
    appPool,
  );
  expect(response.status).toBe(303);
  const token = sessionCookieValue(response);
  expect(token).toBeDefined();
  return token as string;
}

async function auditRows(
  action: string,
): Promise<Array<{ outcome: string; correlation_id: string; actor_account_id: string | null }>> {
  return withClient(appPool, async (client) => {
    const result = await client.query<{
      outcome: string;
      correlation_id: string;
      actor_account_id: string | null;
    }>(
      "SELECT outcome, correlation_id, actor_account_id FROM audit_events WHERE action = $1 ORDER BY occurred_at",
      [action],
    );
    return result.rows;
  });
}

beforeAll(async () => {
  ownerPool = createPool(testConfig(OWNER_ENV_FILE));
  appPool = createPool(testConfig(APP_ENV_FILE));
  const ownerConfig = testConfig(OWNER_ENV_FILE);
  await withClient(ownerPool, async (client) => {
    await client.query(DROP_ALL_TABLES);
  });
  await runMigrations(ownerPool, { appRole: deriveAppRole(ownerConfig.user) });
}, 60_000);

afterAll(async () => {
  await ownerPool.end();
  await appPool.end();
});

beforeEach(async () => {
  await withClient(ownerPool, async (client) => {
    await client.query("DELETE FROM audit_events");
    await client.query("DELETE FROM sessions");
    await client.query("DELETE FROM accounts");
    await client.query("DELETE FROM settings");
  });
  await bootstrap(ownerPool, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    publicOrigin: PUBLIC_ORIGIN,
    correlationId: crypto.randomUUID(),
  });
}, 30_000);

describe("POST /api/login", () => {
  it("issues a __Host- session cookie and stores only its digest (S2)", async () => {
    const csrf = newToken();
    const response = await handleLogin(
      post("/api/login", form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf }), {
        cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
      }),
      appPool,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
    expect(response.headers.get("Cache-Control")).toContain("no-store");

    const setCookies = response.headers.getSetCookie();
    const session = setCookies.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`)) as string;
    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(session).toContain("Path=/");
    expect(session).not.toContain("Domain");
    // The login double-submit cookie is cleared once it has been used.
    expect(setCookies.some((c) => c.startsWith(`${LOGIN_CSRF_COOKIE_NAME}=;`))).toBe(true);

    const token = sessionCookieValue(response) as string;
    const stored = await withClient(appPool, async (client) =>
      client.query<{ token_sha256: string }>("SELECT token_sha256 FROM sessions"),
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.token_sha256).toBe(sha256Hex(token));
    expect(stored.rows[0]?.token_sha256).not.toBe(token);

    const principal = await loadPrincipal(appPool, token);
    expect(principal?.email).toBe(ADMIN_EMAIL);
    expect(principal?.role).toBe("hr_admin");
  });

  it("writes a login/ok audit row with the actor and a correlation id (S7)", async () => {
    await logIn();
    const rows = await auditRows("login");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.actor_account_id).not.toBeNull();
    expect(rows[0]?.correlation_id).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("answers a wrong password and an unknown email identically (S1)", async () => {
    const csrf = newToken();
    const wrongPassword = await handleLogin(
      post("/api/login", form({ email: ADMIN_EMAIL, password: "not-the-password-x", csrf }), {
        cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
      }),
      appPool,
    );
    const unknownEmail = await handleLogin(
      post("/api/login", form({ email: "nobody@example.test", password: ADMIN_PASSWORD, csrf }), {
        cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
      }),
      appPool,
    );

    expect(wrongPassword.status).toBe(303);
    expect(wrongPassword.headers.get("Location")).toBe("/login?error=invalid_credentials");
    expect(unknownEmail.status).toBe(wrongPassword.status);
    expect(unknownEmail.headers.get("Location")).toBe(wrongPassword.headers.get("Location"));
    expect(sessionCookieValue(wrongPassword)).toBeUndefined();
    expect(sessionCookieValue(unknownEmail)).toBeUndefined();
  });

  it("rotates: a second login leaves the first session unusable", async () => {
    const first = await logIn();
    const csrf = newToken();
    const response = await handleLogin(
      post("/api/login", form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf }), {
        cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf, [SESSION_COOKIE_NAME]: first },
      }),
      appPool,
    );
    const second = sessionCookieValue(response) as string;

    expect(second).not.toBe(first);
    expect(await loadPrincipal(appPool, first)).toBeNull();
    expect(await loadPrincipal(appPool, second)).not.toBeNull();
  });

  it("locks the account after five failures and then refuses the correct password (S6)", async () => {
    for (let attempt = 1; attempt <= MAX_FAILED_LOGINS; attempt += 1) {
      const csrf = newToken();
      const response = await handleLogin(
        post("/api/login", form({ email: ADMIN_EMAIL, password: `wrong-attempt-${attempt}`, csrf }), {
          cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
        }),
        appPool,
      );
      if (attempt < MAX_FAILED_LOGINS) {
        expect(response.headers.get("Location")).toBe("/login?error=invalid_credentials");
      } else {
        expect(response.status).toBe(429);
        expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
      }
    }

    // The oracle-free proof: the right password is refused while the lock holds.
    const csrf = newToken();
    const correct = await handleLogin(
      post("/api/login", form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf }), {
        cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
      }),
      appPool,
    );
    expect(correct.status).toBe(429);
    expect(sessionCookieValue(correct)).toBeUndefined();
    expect(await auditRows("login")).toHaveLength(MAX_FAILED_LOGINS + 1);
    expect((await auditRows("login")).every((row) => row.outcome === "denied")).toBe(true);

    const locked = await withClient(appPool, async (client) =>
      client.query<{ failed_logins: number; locked_until: Date | null }>(
        "SELECT failed_logins, locked_until FROM accounts WHERE email = $1",
        [ADMIN_EMAIL],
      ),
    );
    expect(locked.rows[0]?.failed_logins).toBe(MAX_FAILED_LOGINS);
    expect((locked.rows[0]?.locked_until as Date).getTime()).toBeGreaterThan(Date.now());

    // Once the lock expires the account works again, with the counter reset.
    await withClient(ownerPool, async (client) => {
      await client.query(
        "UPDATE accounts SET locked_until = now() - interval '1 minute' WHERE email = $1",
        [ADMIN_EMAIL],
      );
    });
    const token = await logIn();
    expect(token).toBeTruthy();
    const cleared = await withClient(appPool, async (client) =>
      client.query<{ failed_logins: number }>(
        "SELECT failed_logins FROM accounts WHERE email = $1",
        [ADMIN_EMAIL],
      ),
    );
    expect(cleared.rows[0]?.failed_logins).toBe(0);
  }, 60_000);

  it("refuses a missing, null or mismatched Origin with 403 (S3)", async () => {
    for (const origin of [null, "null", "https://evil.example.test", "http://hr.example.test"]) {
      const csrf = newToken();
      const response = await handleLogin(
        post("/api/login", form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf }), {
          origin,
          cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
        }),
        appPool,
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
      expect(sessionCookieValue(response)).toBeUndefined();
    }
  });

  it("refuses a missing, mismatched or malformed CSRF pair with 403 (S3)", async () => {
    const csrf = newToken();
    const cases: Array<{ cookies: Record<string, string>; field: string }> = [
      { cookies: {}, field: csrf }, // no cookie
      { cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf }, field: newToken() }, // different value
      { cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf }, field: "" }, // empty field
      { cookies: { [LOGIN_CSRF_COOKIE_NAME]: "short" }, field: "short" }, // malformed pair
    ];
    for (const testCase of cases) {
      const response = await handleLogin(
        post(
          "/api/login",
          form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf: testCase.field }),
          { cookies: testCase.cookies },
        ),
        appPool,
      );
      expect(response.status).toBe(403);
      expect(sessionCookieValue(response)).toBeUndefined();
    }
    expect(await auditRows("login")).toHaveLength(0);
  });

  it("rejects an over-posted field rather than ignoring it (S4)", async () => {
    const csrf = newToken();
    const response = await handleLogin(
      post(
        "/api/login",
        form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf, role: "hr_admin" }),
        { cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf } },
      ),
      appPool,
    );
    expect(response.headers.get("Location")).toBe("/login?error=invalid_input");
    expect(sessionCookieValue(response)).toBeUndefined();
  });

  it("refuses a body over 64 KiB with 413 before parsing it (S4)", async () => {
    const csrf = newToken();
    const response = await handleLogin(
      post(
        "/api/login",
        form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf, padding: "x".repeat(70_000) }),
        { cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf } },
      ),
      appPool,
    );
    expect(response.status).toBe(413);
  });

  it("fails closed with 503 while the application is unprovisioned (spec §4)", async () => {
    await withClient(ownerPool, async (client) => {
      await client.query("DELETE FROM settings");
    });
    const csrf = newToken();
    const response = await handleLogin(
      post("/api/login", form({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD, csrf }), {
        cookies: { [LOGIN_CSRF_COOKIE_NAME]: csrf },
      }),
      appPool,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "db_unavailable" });
  });
});

describe("sessions (S2)", () => {
  it("expires after 30 idle minutes", async () => {
    const token = await logIn();
    await withClient(ownerPool, async (client) => {
      await client.query("UPDATE sessions SET last_seen_at = now() - interval '31 minutes'");
    });
    expect(await loadPrincipal(appPool, token)).toBeNull();
  });

  it("expires 8 hours after it was issued, however active", async () => {
    const token = await logIn();
    await withClient(ownerPool, async (client) => {
      await client.query(
        "UPDATE sessions SET last_seen_at = now(), absolute_expires_at = now() - interval '1 second'",
      );
    });
    expect(await loadPrincipal(appPool, token)).toBeNull();
  });

  it("dies the moment the account is deactivated, with no grace window", async () => {
    const token = await logIn();
    expect(await loadPrincipal(appPool, token)).not.toBeNull();
    await withClient(ownerPool, async (client) => {
      await client.query("UPDATE accounts SET active = false WHERE email = $1", [ADMIN_EMAIL]);
    });
    expect(await loadPrincipal(appPool, token)).toBeNull();
  });

  it("refreshes the idle clock at most once a minute", async () => {
    const token = await logIn();
    const before = await withClient(appPool, async (client) =>
      client.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM sessions"),
    );
    await loadPrincipal(appPool, token);
    const unchanged = await withClient(appPool, async (client) =>
      client.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM sessions"),
    );
    expect(unchanged.rows[0]?.last_seen_at.getTime()).toBe(
      before.rows[0]?.last_seen_at.getTime(),
    );

    await withClient(ownerPool, async (client) => {
      await client.query("UPDATE sessions SET last_seen_at = now() - interval '5 minutes'");
    });
    await loadPrincipal(appPool, token);
    const touched = await withClient(appPool, async (client) =>
      client.query<{ last_seen_at: Date }>("SELECT last_seen_at FROM sessions"),
    );
    expect(touched.rows[0]?.last_seen_at.getTime()).toBeGreaterThan(
      (before.rows[0]?.last_seen_at as Date).getTime() - 60_000,
    );
  });
});

describe("POST /api/logout", () => {
  it("revokes the session server-side and clears the cookie", async () => {
    const token = await logIn();
    const principal = await loadPrincipal(appPool, token);
    const response = await handleLogout(
      post("/api/logout", form({ csrf: principal?.csrfToken ?? "" }), {
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
      appPool,
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");
    expect(response.headers.get("Clear-Site-Data")).toBe('"cache", "cookies"');
    expect(response.headers.getSetCookie().some((c) => c.includes("Max-Age=0"))).toBe(true);
    expect(await loadPrincipal(appPool, token)).toBeNull();

    const rows = await auditRows("logout");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
  });

  it("refuses a wrong CSRF token with 403 and leaves the session alive", async () => {
    const token = await logIn();
    const response = await handleLogout(
      post("/api/logout", form({ csrf: newToken() }), {
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
      appPool,
    );
    expect(response.status).toBe(403);
    expect(await loadPrincipal(appPool, token)).not.toBeNull();
  });

  it("is idempotent without a session", async () => {
    const response = await handleLogout(post("/api/logout", form({ csrf: newToken() })), appPool);
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/login");
  });
});

describe("POST /api/password", () => {
  async function changePasswordRequest(
    token: string,
    csrf: string,
    fields: Record<string, string>,
  ): Promise<Response> {
    return handlePasswordChange(
      post("/api/password", form({ ...fields, csrf }), {
        cookies: { [SESSION_COOKIE_NAME]: token },
      }),
      appPool,
    );
  }

  it("replaces the password, rotates this session and revokes the others", async () => {
    const first = await logIn();
    const second = await logIn(); // a second browser
    const principal = await loadPrincipal(appPool, second);

    const response = await changePasswordRequest(second, principal?.csrfToken ?? "", {
      current_password: ADMIN_PASSWORD,
      new_password: NEW_PASSWORD,
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/me?status=password_changed");
    const rotated = sessionCookieValue(response) as string;
    expect(rotated).toBeDefined();
    expect(rotated).not.toBe(second);
    expect(await loadPrincipal(appPool, first)).toBeNull();
    expect(await loadPrincipal(appPool, second)).toBeNull();
    expect(await loadPrincipal(appPool, rotated)).not.toBeNull();

    const audit = await auditRows("password.change");
    expect(audit).toHaveLength(1);
    expect(audit[0]?.outcome).toBe("ok");

    // The new password works and the old one does not.
    await handleLogout(
      post("/api/logout", form({ csrf: (await loadPrincipal(appPool, rotated))?.csrfToken ?? "" }), {
        cookies: { [SESSION_COOKIE_NAME]: rotated },
      }),
      appPool,
    );
    await expect(logIn(NEW_PASSWORD)).resolves.toBeTruthy();
  }, 60_000);

  it("refuses without a session, with a bad CSRF token, and on a wrong current password", async () => {
    const token = await logIn();
    const principal = await loadPrincipal(appPool, token);

    const anonymous = await handlePasswordChange(
      post(
        "/api/password",
        form({ current_password: ADMIN_PASSWORD, new_password: NEW_PASSWORD, csrf: newToken() }),
      ),
      appPool,
    );
    expect(anonymous.status).toBe(401);

    const badCsrf = await changePasswordRequest(token, newToken(), {
      current_password: ADMIN_PASSWORD,
      new_password: NEW_PASSWORD,
    });
    expect(badCsrf.status).toBe(403);

    const wrongCurrent = await changePasswordRequest(token, principal?.csrfToken ?? "", {
      current_password: "definitely-not-it-1",
      new_password: NEW_PASSWORD,
    });
    expect(wrongCurrent.headers.get("Location")).toBe("/me?error=invalid_current_password");
    expect(await loadPrincipal(appPool, token)).not.toBeNull();

    const denied = await auditRows("password.change");
    expect(denied).toHaveLength(1);
    expect(denied[0]?.outcome).toBe("denied");
  }, 60_000);

  it("applies the S1 policy to the new password", async () => {
    const token = await logIn();
    const principal = await loadPrincipal(appPool, token);

    const tooShort = await changePasswordRequest(token, principal?.csrfToken ?? "", {
      current_password: ADMIN_PASSWORD,
      new_password: "short-one",
    });
    expect(tooShort.headers.get("Location")).toBe("/me?error=weak_password");

    const blocked = await changePasswordRequest(token, principal?.csrfToken ?? "", {
      current_password: ADMIN_PASSWORD,
      new_password: "password12345678",
    });
    expect(blocked.headers.get("Location")).toBe("/me?error=weak_password");

    const unchanged = await changePasswordRequest(token, principal?.csrfToken ?? "", {
      current_password: ADMIN_PASSWORD,
      new_password: ADMIN_PASSWORD,
    });
    expect(unchanged.headers.get("Location")).toBe("/me?error=password_unchanged");

    expect(await loadPrincipal(appPool, token)).not.toBeNull();
  }, 60_000);
});

describe("health endpoints (spec §8)", () => {
  it("/health/live answers 200 without touching the database", async () => {
    const response = healthLive();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("/health/ready is ready once migrated and provisioned, and not before", async () => {
    expect(await readiness(appPool)).toEqual({ ready: true });

    await withClient(ownerPool, async (client) => {
      await client.query("DELETE FROM settings");
    });
    expect(await readiness(appPool)).toEqual({ ready: false });
  });

  it("/health/ready discloses nothing when the database is unreachable", async () => {
    const unreachable = createPool({
      ...testConfig(APP_ENV_FILE),
      host: "127.0.0.1",
      port: 1,
    });
    try {
      expect(await readiness(unreachable)).toEqual({ ready: false });
    } finally {
      await unreachable.end();
    }
  });
});

describe("audit rows are append-only for the runtime role (S7)", () => {
  it("can be inserted and read but never updated or deleted", async () => {
    await logIn();
    await expect(
      withTransaction(appPool, async (client) => {
        await client.query("UPDATE audit_events SET outcome = 'ok'");
      }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      withTransaction(appPool, async (client) => {
        await client.query("DELETE FROM audit_events");
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect((await auditRows("login")).length).toBeGreaterThan(0);
  });
});
