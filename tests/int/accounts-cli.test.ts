import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, withClient, type Pool } from "../../src/server/db/pool.ts";
import { deriveAppRole, runMigrations } from "../../src/server/db/migrate.ts";
import { APP_ENV_FILE, DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.ts";
import {
  ProvisioningError,
  bootstrap,
  createUser,
  currentOrigin,
  disableUser,
  resetPassword,
  setOrigin,
} from "../../src/server/services/accounts.ts";
import { login } from "../../src/server/services/auth.ts";
import { loadPrincipal } from "../../src/server/auth/session.ts";
import { countActiveAdmins } from "../../src/server/repos/accounts.ts";

/**
 * Integration coverage for the operations `manage` exposes (spec §4, §2's last-admin rule,
 * S7's audit atomicity). The services run on the **owner** pool, as the CLI does; the
 * resulting sessions are checked on the runtime pool, as the server does.
 *
 * Every address is fictional and ends in `example.test`. The passwords below exist only in
 * this file and in the `hr_test` database.
 */
const ADMIN_EMAIL = "ada.first@example.test";
const SECOND_ADMIN_EMAIL = "bo.second@example.test";
const STAFF_EMAIL = "cy.staff@example.test";
const ADMIN_PASSWORD = "quartz-harbour-19-lane";
const OTHER_PASSWORD = "velvet-meridian-7-brook";
const PUBLIC_ORIGIN = "https://hr.example.test";
const EMPLOYEE_CODE = "E-1001";

let ownerPool: Pool;
let appPool: Pool;

function correlation(): string {
  return randomUUID();
}

async function auditFor(action: string): Promise<Array<{ outcome: string }>> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{ outcome: string }>(
      "SELECT outcome FROM audit_events WHERE action = $1 ORDER BY occurred_at",
      [action],
    );
    return result.rows;
  });
}

async function insertEmployee(code: string): Promise<string> {
  const id = randomUUID();
  await withClient(ownerPool, async (client) => {
    await client.query(
      `INSERT INTO employees (id, code, full_name, work_email, title, department, start_date)
       VALUES ($1, $2, 'Cy Staff', $3, 'Analyst', 'Operations', DATE '2026-01-05')`,
      [id, code, `${code.toLowerCase()}@example.test`],
    );
  });
  return id;
}

beforeAll(async () => {
  const ownerConfig = testConfig(OWNER_ENV_FILE);
  ownerPool = createPool(ownerConfig);
  appPool = createPool(testConfig(APP_ENV_FILE));
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
    await client.query("DELETE FROM leave_requests");
    await client.query("DELETE FROM employees");
    await client.query("DELETE FROM accounts");
    await client.query("DELETE FROM settings");
  });
});

describe("bootstrap (spec §4)", () => {
  it("provisions the first administrator and the origin atomically", async () => {
    const result = await bootstrap(ownerPool, {
      email: ADMIN_EMAIL.toUpperCase(),
      password: ADMIN_PASSWORD,
      publicOrigin: `${PUBLIC_ORIGIN}/`,
      correlationId: correlation(),
    });

    expect(result.email).toBe(ADMIN_EMAIL); // stored lowercase
    expect(result.publicOrigin).toBe(PUBLIC_ORIGIN); // trailing slash removed
    expect(await currentOrigin(ownerPool)).toBe(PUBLIC_ORIGIN);
    expect(await withClient(ownerPool, async (client) => countActiveAdmins(client))).toBe(1);

    const rows = await withClient(ownerPool, async (client) =>
      client.query<{ role: string; active: boolean; password_hash: string }>(
        "SELECT role, active, password_hash FROM accounts",
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.role).toBe("hr_admin");
    expect(rows.rows[0]?.active).toBe(true);
    expect(rows.rows[0]?.password_hash).toMatch(/^\$argon2id\$/u);
    expect(rows.rows[0]?.password_hash).not.toContain(ADMIN_PASSWORD);

    expect(await auditFor("account.bootstrap")).toEqual([{ outcome: "ok" }]);
    expect(await auditFor("settings.set_origin")).toEqual([{ outcome: "ok" }]);
  }, 30_000);

  it("refuses once any account exists, and writes nothing", async () => {
    await bootstrap(ownerPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      publicOrigin: PUBLIC_ORIGIN,
      correlationId: correlation(),
    });
    await expect(
      bootstrap(ownerPool, {
        email: SECOND_ADMIN_EMAIL,
        password: OTHER_PASSWORD,
        publicOrigin: PUBLIC_ORIGIN,
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "already_provisioned" });

    const count = await withClient(ownerPool, async (client) =>
      client.query<{ total: string }>("SELECT count(*) AS total FROM accounts"),
    );
    expect(count.rows[0]?.total).toBe("1");
  }, 30_000);

  it("refuses a weak password or a malformed origin before writing anything", async () => {
    await expect(
      bootstrap(ownerPool, {
        email: ADMIN_EMAIL,
        password: "too-short",
        publicOrigin: PUBLIC_ORIGIN,
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "weak_password" });

    await expect(
      bootstrap(ownerPool, {
        email: ADMIN_EMAIL,
        password: ADMIN_PASSWORD,
        // D10 accepts http:// for any host, so the refused shape here is a malformed one:
        // an origin carrying a path is still not an origin.
        publicOrigin: "http://hr.example.test/app",
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "invalid_origin" });

    await expect(
      bootstrap(ownerPool, {
        email: "not-an-email",
        password: ADMIN_PASSWORD,
        publicOrigin: PUBLIC_ORIGIN,
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "invalid_email" });

    const count = await withClient(ownerPool, async (client) =>
      client.query<{ total: string }>("SELECT count(*) AS total FROM accounts"),
    );
    expect(count.rows[0]?.total).toBe("0");
  }, 30_000);

  it("never puts the password in the refusal message", async () => {
    try {
      await bootstrap(ownerPool, {
        email: ADMIN_EMAIL,
        password: "password12345678",
        publicOrigin: PUBLIC_ORIGIN,
        correlationId: correlation(),
      });
      expect.unreachable("bootstrap should have refused");
    } catch (error) {
      expect((error as ProvisioningError).message).not.toContain("password12345678");
    }
  });
});

describe("set-origin", () => {
  beforeEach(async () => {
    await bootstrap(ownerPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      publicOrigin: PUBLIC_ORIGIN,
      correlationId: correlation(),
    });
  }, 30_000);

  it("stores http and https for any host, and refuses anything that is not an origin", async () => {
    expect(await setOrigin(ownerPool, { origin: "http://127.0.0.1:3001", correlationId: correlation() })).toBe(
      "http://127.0.0.1:3001",
    );
    expect(await currentOrigin(ownerPool)).toBe("http://127.0.0.1:3001");

    // D10: plain HTTP ingress — a non-loopback http:// origin is a supported deployment.
    expect(
      await setOrigin(ownerPool, { origin: "http://hr.example.test", correlationId: correlation() }),
    ).toBe("http://hr.example.test");
    expect(await currentOrigin(ownerPool)).toBe("http://hr.example.test");

    await expect(
      setOrigin(ownerPool, { origin: "https://hr.example.test/app", correlationId: correlation() }),
    ).rejects.toMatchObject({ code: "invalid_origin" });
    await expect(
      setOrigin(ownerPool, { origin: "ftp://hr.example.test", correlationId: correlation() }),
    ).rejects.toMatchObject({ code: "invalid_origin" });

    expect(await currentOrigin(ownerPool)).toBe("http://hr.example.test");
    expect(await auditFor("settings.set_origin")).toHaveLength(3); // bootstrap + the two changes
  });
});

describe("create-user", () => {
  beforeEach(async () => {
    await bootstrap(ownerPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      publicOrigin: PUBLIC_ORIGIN,
      correlationId: correlation(),
    });
  }, 30_000);

  it("creates a second HR administrator that can log in", async () => {
    const created = await createUser(ownerPool, {
      email: SECOND_ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      role: "hr_admin",
      correlationId: correlation(),
    });
    expect(created.role).toBe("hr_admin");
    expect(created.employeeCode).toBeNull();
    expect(await auditFor("account.create")).toEqual([{ outcome: "ok" }]);

    const result = await login(appPool, {
      email: SECOND_ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      correlationId: correlation(),
    });
    expect(result.kind).toBe("ok");
  }, 30_000);

  it("requires an employee link for the employee role and links exactly one account", async () => {
    await expect(
      createUser(ownerPool, {
        email: STAFF_EMAIL,
        password: OTHER_PASSWORD,
        role: "employee",
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "employee_link_required" });

    await expect(
      createUser(ownerPool, {
        email: STAFF_EMAIL,
        password: OTHER_PASSWORD,
        role: "employee",
        employeeCode: "E-9999",
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "employee_not_found" });

    const employeeId = await insertEmployee(EMPLOYEE_CODE);
    const linked = await createUser(ownerPool, {
      email: STAFF_EMAIL,
      password: OTHER_PASSWORD,
      role: "employee",
      employeeCode: EMPLOYEE_CODE,
      correlationId: correlation(),
    });
    expect(linked.employeeCode).toBe(EMPLOYEE_CODE);

    const row = await withClient(ownerPool, async (client) =>
      client.query<{ account_id: string | null }>("SELECT account_id FROM employees WHERE id = $1", [
        employeeId,
      ]),
    );
    expect(row.rows[0]?.account_id).toBe(linked.accountId);

    // A second login for the same employee record is refused, and leaves no account behind.
    await expect(
      createUser(ownerPool, {
        email: "dee.other@example.test",
        password: OTHER_PASSWORD,
        role: "employee",
        employeeCode: EMPLOYEE_CODE,
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "employee_already_linked" });

    const accounts = await withClient(ownerPool, async (client) =>
      client.query<{ email: string }>("SELECT email FROM accounts ORDER BY email"),
    );
    expect(accounts.rows.map((r) => r.email)).toEqual([ADMIN_EMAIL, STAFF_EMAIL]);
  }, 60_000);

  it("refuses a duplicate email, whatever its case", async () => {
    await expect(
      createUser(ownerPool, {
        email: ADMIN_EMAIL.toUpperCase(),
        password: OTHER_PASSWORD,
        role: "hr_admin",
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "email_taken" });
  }, 30_000);
});

describe("reset-password", () => {
  beforeEach(async () => {
    await bootstrap(ownerPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      publicOrigin: PUBLIC_ORIGIN,
      correlationId: correlation(),
    });
  }, 30_000);

  it("replaces the password, revokes every session and audits the change", async () => {
    const first = await login(appPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      correlationId: correlation(),
    });
    expect(first.kind).toBe("ok");
    const token = first.kind === "ok" ? first.token : "";
    expect(await loadPrincipal(appPool, token)).not.toBeNull();

    const result = await resetPassword(ownerPool, {
      email: ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      correlationId: correlation(),
    });
    expect(result.revokedSessions).toBe(1);
    expect(await loadPrincipal(appPool, token)).toBeNull();
    expect(await auditFor("account.reset_password")).toEqual([{ outcome: "ok" }]);

    const withOld = await login(appPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      correlationId: correlation(),
    });
    expect(withOld.kind).toBe("invalid_credentials");
    const withNew = await login(appPool, {
      email: ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      correlationId: correlation(),
    });
    expect(withNew.kind).toBe("ok");
  }, 60_000);

  it("refuses an unknown account and a weak password", async () => {
    await expect(
      resetPassword(ownerPool, {
        email: "nobody@example.test",
        password: OTHER_PASSWORD,
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "account_not_found" });
    await expect(
      resetPassword(ownerPool, {
        email: ADMIN_EMAIL,
        password: "short",
        correlationId: correlation(),
      }),
    ).rejects.toMatchObject({ code: "weak_password" });
  }, 30_000);
});

describe("disable-user and the last-admin protection (spec §2)", () => {
  beforeEach(async () => {
    await bootstrap(ownerPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      publicOrigin: PUBLIC_ORIGIN,
      correlationId: correlation(),
    });
  }, 30_000);

  it("refuses to disable the last active HR administrator and writes nothing", async () => {
    const before = await login(appPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      correlationId: correlation(),
    });
    const token = before.kind === "ok" ? before.token : "";

    await expect(
      disableUser(ownerPool, { email: ADMIN_EMAIL, correlationId: correlation() }),
    ).rejects.toMatchObject({ code: "last_admin" });

    const account = await withClient(ownerPool, async (client) =>
      client.query<{ active: boolean; version: number }>(
        "SELECT active, version FROM accounts WHERE email = $1",
        [ADMIN_EMAIL],
      ),
    );
    expect(account.rows[0]?.active).toBe(true);
    expect(account.rows[0]?.version).toBe(1); // the refused UPDATE rolled back
    expect(await loadPrincipal(appPool, token)).not.toBeNull();

    // The refusal itself is audited, in a transaction of its own.
    expect(await auditFor("account.disable")).toEqual([{ outcome: "denied" }]);
  }, 60_000);

  it("disables an administrator once a second one exists, revoking their sessions", async () => {
    await createUser(ownerPool, {
      email: SECOND_ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      role: "hr_admin",
      correlationId: correlation(),
    });
    const session = await login(appPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      correlationId: correlation(),
    });
    const token = session.kind === "ok" ? session.token : "";

    const result = await disableUser(ownerPool, {
      email: ADMIN_EMAIL,
      correlationId: correlation(),
    });
    expect(result.revokedSessions).toBe(1);
    expect(await loadPrincipal(appPool, token)).toBeNull();
    expect(await auditFor("account.disable")).toEqual([{ outcome: "ok" }]);

    // A disabled account cannot log back in, and the generic failure says nothing about why.
    const retry = await login(appPool, {
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      correlationId: correlation(),
    });
    expect(retry.kind).toBe("invalid_credentials");

    // And the protection now applies to the remaining administrator.
    await expect(
      disableUser(ownerPool, { email: SECOND_ADMIN_EMAIL, correlationId: correlation() }),
    ).rejects.toMatchObject({ code: "last_admin" });
  }, 60_000);

  it("lets only one of two concurrent disable attempts through", async () => {
    await createUser(ownerPool, {
      email: SECOND_ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      role: "hr_admin",
      correlationId: correlation(),
    });

    const [first, second] = await Promise.allSettled([
      disableUser(ownerPool, { email: ADMIN_EMAIL, correlationId: correlation() }),
      disableUser(ownerPool, { email: SECOND_ADMIN_EMAIL, correlationId: correlation() }),
    ]);

    const outcomes = [first.status, second.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    const rejected = (first.status === "rejected" ? first.reason : (second as PromiseRejectedResult).reason) as ProvisioningError;
    expect(rejected.code).toBe("last_admin");

    const remaining = await withClient(ownerPool, async (client) =>
      client.query<{ total: string }>(
        "SELECT count(*) AS total FROM accounts WHERE role = 'hr_admin' AND active = true",
      ),
    );
    expect(remaining.rows[0]?.total).toBe("1");
  }, 60_000);

  it("refuses an unknown or already disabled account", async () => {
    await expect(
      disableUser(ownerPool, { email: "nobody@example.test", correlationId: correlation() }),
    ).rejects.toMatchObject({ code: "account_not_found" });

    await createUser(ownerPool, {
      email: SECOND_ADMIN_EMAIL,
      password: OTHER_PASSWORD,
      role: "hr_admin",
      correlationId: correlation(),
    });
    await disableUser(ownerPool, { email: SECOND_ADMIN_EMAIL, correlationId: correlation() });
    await expect(
      disableUser(ownerPool, { email: SECOND_ADMIN_EMAIL, correlationId: correlation() }),
    ).rejects.toMatchObject({ code: "already_disabled" });
  }, 30_000);
});
