import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, withClient, type Pool } from "../../src/server/db/pool.ts";
import { deriveAppRole, runMigrations } from "../../src/server/db/migrate.ts";
import { APP_ENV_FILE, DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.ts";
import { handleLogin } from "../../src/app/api/login/route.ts";
import { handleEmployeeCreate } from "../../src/app/api/employees/route.ts";
import { handleEmployeeUpdate } from "../../src/app/api/employees/[id]/route.ts";
import { handleEmployeeStatus } from "../../src/app/api/employees/[id]/status/route.ts";
import { LOGIN_CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/shared/cookies.ts";
import { loadPrincipal, type Principal } from "../../src/server/auth/session.ts";
import { newToken } from "../../src/server/auth/tokens.ts";
import { ProvisioningError, bootstrap, createUser } from "../../src/server/services/accounts.ts";
import {
  getEmployeeForHr,
  listEmployeesForHr,
  loadDirectory,
  loadOwnProfile,
} from "../../src/server/services/employees.ts";
import { loadOverview } from "../../src/server/services/overview.ts";
import type { HrEmployeeDTO } from "../../src/server/dto/employees.ts";

/**
 * Integration coverage for the slice 2 employee surface against the `hr_test` database
 * (spec §2, §6 S4, S7). The three Route Handlers are driven as plain `(Request, Pool, id)`
 * functions on the **runtime** role's pool, exactly as the server runs them, so anything the
 * grants forbid fails here rather than in production; provisioning runs on the owner pool,
 * exactly as `manage` does.
 *
 * All data is fictional and every address is `example.test`. The passwords below exist only in
 * this file and in the `hr_test` database.
 */
const ADMIN_EMAIL = "ada.first@example.test";
const SECOND_ADMIN_EMAIL = "bo.second@example.test";
const STAFF_EMAIL = "cy.staff@example.test";
const ADMIN_PASSWORD = "quartz-harbour-19-lane";
const OTHER_PASSWORD = "velvet-meridian-7-brook";
const PUBLIC_ORIGIN = "https://hr.example.test";

let ownerPool: Pool;
let appPool: Pool;
let adminToken: string;
let adminPrincipal: Principal;

interface RequestOptions {
  readonly origin?: string | null;
  readonly token?: string | null;
  readonly contentType?: string;
  readonly rawBody?: string;
}

/** A JSON POST carrying the session cookie, as the editor's `fetch` sends it. */
function post(path: string, body: unknown, options: RequestOptions = {}): Request {
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
  });
  const origin = options.origin === undefined ? PUBLIC_ORIGIN : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const token = options.token === undefined ? adminToken : options.token;
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return new Request(`${PUBLIC_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body),
  });
}

async function logIn(email: string, password: string): Promise<string> {
  const csrf = newToken();
  const response = await handleLogin(
    new Request(`${PUBLIC_ORIGIN}/api/login`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/x-www-form-urlencoded",
        origin: PUBLIC_ORIGIN,
        cookie: `${LOGIN_CSRF_COOKIE_NAME}=${csrf}`,
      }),
      body: new URLSearchParams({ email, password, csrf }).toString(),
    }),
    appPool,
  );
  expect(response.status).toBe(303);
  for (const header of response.headers.getSetCookie()) {
    if (header.startsWith(`${SESSION_COOKIE_NAME}=`)) {
      const value = header.slice(SESSION_COOKIE_NAME.length + 1).split(";", 1)[0] as string;
      if (value !== "") {
        return value;
      }
    }
  }
  throw new Error("login set no session cookie");
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: "E-2001",
    full_name: "Eli Fixture",
    work_email: "eli.fixture@example.test",
    title: "Coordinator",
    department: "People",
    start_date: "2026-03-02",
    csrf: adminPrincipal.csrfToken,
    ...overrides,
  };
}

async function createEmployee(overrides: Record<string, unknown> = {}): Promise<HrEmployeeDTO> {
  const response = await handleEmployeeCreate(post("/api/employees", validBody(overrides)), appPool);
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { employee: HrEmployeeDTO };
  return payload.employee;
}

async function auditRows(): Promise<
  Array<{ action: string; outcome: string; correlation_id: string; object_type: string }>
> {
  return withClient(appPool, async (client) => {
    const result = await client.query<{
      action: string;
      outcome: string;
      correlation_id: string;
      object_type: string;
    }>(
      "SELECT action, outcome, correlation_id, object_type FROM audit_events ORDER BY occurred_at, action",
    );
    return result.rows;
  });
}

async function employeeRow(
  id: string,
): Promise<{ active: boolean; version: number; account_id: string | null } | undefined> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{
      active: boolean;
      version: number;
      account_id: string | null;
    }>("SELECT active, version, account_id FROM employees WHERE id = $1", [id]);
    return result.rows[0];
  });
}

/** An employee record with a login, as the operator's `create-user --employee` produces. */
async function linkedStaff(code: string): Promise<{ employee: HrEmployeeDTO; token: string }> {
  const employee = await createEmployee({
    code,
    work_email: STAFF_EMAIL,
    full_name: "Cy Staff",
  });
  await createUser(ownerPool, {
    email: STAFF_EMAIL,
    password: OTHER_PASSWORD,
    role: "employee",
    employeeCode: code,
    correlationId: randomUUID(),
  });
  const token = await logIn(STAFF_EMAIL, OTHER_PASSWORD);
  const reloaded = await getEmployeeForHr(appPool, adminPrincipal, employee.id);
  if (reloaded.kind !== "ok" || reloaded.data === null) {
    throw new Error("linked employee disappeared");
  }
  return { employee: reloaded.data, token };
}

async function insertLeave(employeeId: string, status: "pending" | "approved"): Promise<string> {
  const id = randomUUID();
  await withClient(ownerPool, async (client) => {
    await client.query(
      status === "pending"
        ? `INSERT INTO leave_requests (id, employee_id, kind, start_date, end_date, status)
             VALUES ($1, $2, 'annual', DATE '2026-04-06', DATE '2026-04-08', 'pending')`
        : `INSERT INTO leave_requests (id, employee_id, kind, start_date, end_date, status, decided_by, decided_at)
             VALUES ($1, $2, 'annual', DATE '2026-02-02', DATE '2026-02-03', 'approved',
                     (SELECT id FROM accounts WHERE email = $3), now())`,
      status === "pending" ? [id, employeeId] : [id, employeeId, ADMIN_EMAIL],
    );
  });
  return id;
}

async function leaveStatus(id: string): Promise<string | undefined> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{ status: string }>(
      "SELECT status FROM leave_requests WHERE id = $1",
      [id],
    );
    return result.rows[0]?.status;
  });
}

async function accountActive(email: string): Promise<boolean | undefined> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{ active: boolean }>(
      "SELECT active FROM accounts WHERE email = $1",
      [email],
    );
    return result.rows[0]?.active;
  });
}

beforeAll(async () => {
  const ownerConfig = testConfig(OWNER_ENV_FILE);
  ownerPool = createPool(ownerConfig);
  appPool = createPool(testConfig(APP_ENV_FILE));
  await withClient(ownerPool, async (client) => {
    await client.query(DROP_ALL_TABLES);
  });
  await runMigrations(ownerPool, { appRole: deriveAppRole(ownerConfig.user) });
  await bootstrap(ownerPool, {
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
    publicOrigin: PUBLIC_ORIGIN,
    correlationId: randomUUID(),
  });
  await createUser(ownerPool, {
    email: SECOND_ADMIN_EMAIL,
    password: OTHER_PASSWORD,
    role: "hr_admin",
    correlationId: randomUUID(),
  });
}, 90_000);

afterAll(async () => {
  await ownerPool.end();
  await appPool.end();
});

beforeEach(async () => {
  await withClient(ownerPool, async (client) => {
    await client.query("DELETE FROM leave_requests");
    await client.query("DELETE FROM employees");
    await client.query("DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email = $1)", [STAFF_EMAIL]);
    await client.query("DELETE FROM accounts WHERE email = $1", [STAFF_EMAIL]);
    await client.query("DELETE FROM audit_events");
    await client.query("UPDATE accounts SET active = true, failed_logins = 0, locked_until = NULL");
  });
  adminToken = await logIn(ADMIN_EMAIL, ADMIN_PASSWORD);
  const principal = await loadPrincipal(appPool, adminToken);
  if (principal === null) {
    throw new Error("the administrator's session did not resolve");
  }
  adminPrincipal = principal;
});

describe("POST /api/employees", () => {
  it("creates the row and its audit event in one transaction", async () => {
    const employee = await createEmployee();
    expect(employee.active).toBe(true);
    expect(employee.version).toBe(1);
    expect(employee.link).toEqual({ linked: false });
    expect(employee.start_date).toBe("2026-03-02");
    expect(typeof employee.start_date).toBe("string");

    const rows = await auditRows();
    const created = rows.filter((row) => row.action === "employee.create");
    expect(created).toHaveLength(1);
    expect(created[0]?.outcome).toBe("ok");
    expect(created[0]?.object_type).toBe("employee");
  });

  it("refuses a duplicate code with a per-field message", async () => {
    await createEmployee();
    const response = await handleEmployeeCreate(
      post("/api/employees", validBody({ work_email: "other.person@example.test" })),
      appPool,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fields?: Record<string, string> };
    expect(body.error).toBe("invalid_input");
    expect(body.fields?.code).toBeTruthy();
  });

  it("refuses a duplicate work email regardless of case", async () => {
    await createEmployee();
    const response = await handleEmployeeCreate(
      post("/api/employees", validBody({ code: "E-2002", work_email: "ELI.Fixture@Example.Test" })),
      appPool,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { fields?: Record<string, string> };
    expect(body.fields?.work_email).toBeTruthy();
  });

  it("refuses values past the spec's bounds", async () => {
    const response = await handleEmployeeCreate(
      post(
        "/api/employees",
        validBody({ code: "C".repeat(33), full_name: "N".repeat(161) }),
      ),
      appPool,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { fields?: Record<string, string> };
    expect(Object.keys(body.fields ?? {}).sort()).toEqual(["code", "full_name"]);
    expect(await withClient(appPool, async (c) => (await c.query("SELECT 1 FROM employees")).rowCount)).toBe(0);
  });

  for (const key of ["account_id", "role", "id", "created_at", "active", "version"]) {
    it(`refuses an over-posted ${key} with a detail-free 400`, async () => {
      const response = await handleEmployeeCreate(
        post("/api/employees", validBody({ [key]: randomUUID() })),
        appPool,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; fields?: unknown };
      expect(body.error).toBe("invalid_input");
      expect(body.fields).toBeUndefined();
    });
  }

  it("accepts the same body form-encoded, and refuses a repeated form field", async () => {
    const ok = await handleEmployeeCreate(
      post("/api/employees", null, {
        contentType: "application/x-www-form-urlencoded",
        rawBody: new URLSearchParams(validBody() as Record<string, string>).toString(),
      }),
      appPool,
    );
    expect(ok.status).toBe(200);

    const polluted = await handleEmployeeCreate(
      post("/api/employees", null, {
        contentType: "application/x-www-form-urlencoded",
        rawBody: `${new URLSearchParams(validBody({ code: "E-2003" }) as Record<string, string>).toString()}&code=E-2004`,
      }),
      appPool,
    );
    expect(polluted.status).toBe(400);
    expect((await polluted.json()) as unknown).toEqual({ error: "invalid_input" });
  });

  it("refuses a JSON body that is not a flat object of scalars", async () => {
    const response = await handleEmployeeCreate(
      post("/api/employees", { ...validBody(), department: { name: "People" } }),
      appPool,
    );
    expect(response.status).toBe(400);
  });

  it("refuses a missing, null or mismatched Origin and a wrong CSRF token", async () => {
    for (const origin of [null, "null", "https://evil.example.test"]) {
      const response = await handleEmployeeCreate(
        post("/api/employees", validBody(), { origin }),
        appPool,
      );
      expect(response.status, String(origin)).toBe(403);
    }
    const badCsrf = await handleEmployeeCreate(
      post("/api/employees", validBody({ csrf: newToken() })),
      appPool,
    );
    expect(badCsrf.status).toBe(403);
  });

  it("answers an anonymous caller with 401 and never a redirect", async () => {
    const response = await handleEmployeeCreate(
      post("/api/employees", validBody(), { token: null }),
      appPool,
    );
    expect(response.status).toBe(401);
  });
});

describe("POST /api/employees/<id>", () => {
  it("applies an edit, bumps the version and audits it", async () => {
    const employee = await createEmployee();
    const response = await handleEmployeeUpdate(
      post(`/api/employees/${employee.id}`, validBody({ title: "Senior Coordinator", version: 1 })),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: string; employee: HrEmployeeDTO };
    expect(body.employee.title).toBe("Senior Coordinator");
    expect(body.employee.version).toBe(2);
    expect(body.location).toBe(`/employees?id=${employee.id}&saved=updated`);
    expect((await auditRows()).some((row) => row.action === "employee.update")).toBe(true);
  });

  it("answers a stale version with 409 and the current record, carrying no hidden field", async () => {
    const employee = await createEmployee();
    await handleEmployeeUpdate(
      post(`/api/employees/${employee.id}`, validBody({ title: "First", version: 1 })),
      appPool,
      employee.id,
    );
    const response = await handleEmployeeUpdate(
      post(`/api/employees/${employee.id}`, validBody({ title: "Second", version: 1 })),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; current: HrEmployeeDTO };
    expect(body.error).toBe("conflict_stale");
    expect(Object.keys(body.current).sort()).toEqual([
      "active",
      "code",
      "department",
      "full_name",
      "id",
      "link",
      "start_date",
      "title",
      "version",
      "work_email",
    ]);
    expect(body.current.title).toBe("First");
    expect(JSON.stringify(body)).not.toContain("account_id");
    expect(JSON.stringify(body)).not.toContain("created_at");
  });

  it("answers an unknown or malformed id with 404", async () => {
    for (const id of [randomUUID(), "not-a-uuid"]) {
      const response = await handleEmployeeUpdate(
        post(`/api/employees/${id}`, validBody({ version: 1 })),
        appPool,
        id,
      );
      expect(response.status, id).toBe(404);
    }
  });

  it("refuses an edit that would duplicate another record's code", async () => {
    const first = await createEmployee();
    const second = await createEmployee({ code: "E-2002", work_email: "two@example.test" });
    const response = await handleEmployeeUpdate(
      post(`/api/employees/${second.id}`, validBody({ code: first.code, work_email: "two@example.test", version: second.version })),
      appPool,
      second.id,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { fields: Record<string, string> }).fields.code).toBeTruthy();
  });
});

describe("the deactivation cascade", () => {
  it("hides the record, disables the login, revokes the sessions and cancels pending leave", async () => {
    const { employee, token } = await linkedStaff("E-3001");
    const pending = await insertLeave(employee.id, "pending");
    const approved = await insertLeave(employee.id, "approved");
    expect(await loadPrincipal(appPool, token)).not.toBeNull();

    const response = await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "deactivate",
        version: employee.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(200);

    expect((await employeeRow(employee.id))?.active).toBe(false);
    expect(await accountActive(STAFF_EMAIL)).toBe(false);
    expect(await loadPrincipal(appPool, token)).toBeNull();
    expect(await leaveStatus(pending)).toBe("cancelled");
    expect(await leaveStatus(approved)).toBe("approved");

    const rows = await auditRows();
    const actions = rows.map((row) => row.action);
    expect(actions).toContain("employee.deactivate");
    expect(actions).toContain("account.disable");
    expect(actions.filter((action) => action === "leave.cancel")).toHaveLength(1);
    const correlations = new Set(
      rows
        .filter((row) =>
          ["employee.deactivate", "account.disable", "leave.cancel"].includes(row.action),
        )
        .map((row) => row.correlation_id),
    );
    expect(correlations.size).toBe(1);

    const directory = await loadDirectory(appPool, adminPrincipal);
    expect(directory.kind).toBe("ok");
    if (directory.kind === "ok") {
      expect(directory.data.entries.some((entry) => entry.full_name === "Cy Staff")).toBe(false);
    }
  });

  it("answers the deactivated employee's old cookie with 401", async () => {
    const { employee, token } = await linkedStaff("E-3002");
    await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "deactivate",
        version: employee.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    const response = await handleEmployeeCreate(
      post("/api/employees", validBody({ code: "E-9999" }), { token }),
      appPool,
    );
    expect(response.status).toBe(401);
  });

  it("writes nothing at all when it would remove the last active HR administrator", async () => {
    // The administrator running this request is the only active one, and the record about to be
    // deactivated is linked to their own account.
    await withClient(ownerPool, async (client) => {
      await client.query("UPDATE accounts SET active = false WHERE email = $1", [
        SECOND_ADMIN_EMAIL,
      ]);
    });
    const employee = await createEmployee({ code: "E-4001", work_email: ADMIN_EMAIL });
    await withClient(ownerPool, async (client) => {
      await client.query(
        "UPDATE employees SET account_id = (SELECT id FROM accounts WHERE email = $2) WHERE id = $1",
        [employee.id, ADMIN_EMAIL],
      );
    });
    const before = await employeeRow(employee.id);

    const response = await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "deactivate",
        version: before?.version ?? 1,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as unknown).toEqual({ error: "conflict_last_admin" });

    const after = await employeeRow(employee.id);
    expect(after?.active).toBe(true);
    expect(after?.version).toBe(before?.version);
    expect(await accountActive(ADMIN_EMAIL)).toBe(true);
    expect(await loadPrincipal(appPool, adminToken)).not.toBeNull();
    const denied = (await auditRows()).filter(
      (row) => row.action === "employee.deactivate" && row.outcome === "denied",
    );
    expect(denied).toHaveLength(1);
  });

  it("refuses a stale version without touching the row", async () => {
    const employee = await createEmployee();
    const response = await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "deactivate",
        version: employee.version + 5,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("conflict_stale");
    expect((await employeeRow(employee.id))?.active).toBe(true);
  });

  it("activates the record again without re-enabling the account", async () => {
    const { employee } = await linkedStaff("E-3003");
    await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "deactivate",
        version: employee.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    const current = await employeeRow(employee.id);
    const response = await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "activate",
        version: current?.version ?? 1,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(200);
    expect((await employeeRow(employee.id))?.active).toBe(true);
    expect(await accountActive(STAFF_EMAIL)).toBe(false);
  });
});

describe("what an employee may see and do", () => {
  async function staffPrincipal(code: string): Promise<Principal> {
    const { token } = await linkedStaff(code);
    const principal = await loadPrincipal(appPool, token);
    if (principal === null) {
      throw new Error("the staff session did not resolve");
    }
    return principal;
  }

  it("returns only the four directory fields and no inactive colleague", async () => {
    const staff = await staffPrincipal("E-5001");
    const visible = await createEmployee({ code: "E-5002", work_email: "dee@example.test", full_name: "Dee Visible" });
    const hidden = await createEmployee({ code: "E-5003", work_email: "eve@example.test", full_name: "Eve Hidden" });
    await handleEmployeeStatus(
      post(`/api/employees/${hidden.id}/status`, {
        action: "deactivate",
        version: hidden.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      hidden.id,
    );

    const directory = await loadDirectory(appPool, staff);
    expect(directory.kind).toBe("ok");
    if (directory.kind !== "ok" || directory.data.role !== "employee") {
      throw new Error("expected the employee projection");
    }
    const names = directory.data.entries.map((entry) => entry.full_name);
    expect(names).toContain("Dee Visible");
    expect(names).not.toContain("Eve Hidden");
    for (const entry of directory.data.entries) {
      expect(Object.keys(entry).sort()).toEqual([
        "department",
        "full_name",
        "title",
        "work_email",
      ]);
    }
    expect(JSON.stringify(directory.data)).not.toContain(visible.code);
  });

  it("is refused by every employee mutation and by the HR list", async () => {
    const staff = await staffPrincipal("E-5004");
    const target = await createEmployee({ code: "E-5005", work_email: "target@example.test" });
    const token = await logIn(STAFF_EMAIL, OTHER_PASSWORD);

    const create = await handleEmployeeCreate(
      post("/api/employees", validBody({ code: "E-5006", work_email: "x@example.test", csrf: staff.csrfToken }), { token }),
      appPool,
    );
    expect(create.status).toBe(403);

    const update = await handleEmployeeUpdate(
      post(`/api/employees/${target.id}`, validBody({ version: 1, csrf: staff.csrfToken }), { token }),
      appPool,
      target.id,
    );
    expect(update.status).toBe(403);

    const status = await handleEmployeeStatus(
      post(`/api/employees/${target.id}/status`, { action: "deactivate", version: 1, csrf: staff.csrfToken }, { token }),
      appPool,
      target.id,
    );
    expect(status.status).toBe(403);

    expect((await listEmployeesForHr(appPool, staff)).kind).toBe("forbidden");
    expect((await getEmployeeForHr(appPool, staff, target.id)).kind).toBe("forbidden");
  });

  it("sees its own profile without a version or a link, and an unlinked admin sees nothing", async () => {
    const staff = await staffPrincipal("E-5007");
    const own = await loadOwnProfile(appPool, staff);
    expect(own.kind).toBe("ok");
    if (own.kind === "ok") {
      expect(own.data).not.toBeNull();
      expect(Object.keys(own.data ?? {}).sort()).toEqual([
        "active",
        "code",
        "department",
        "full_name",
        "start_date",
        "title",
        "work_email",
      ]);
    }
    const unlinked = await loadOwnProfile(appPool, adminPrincipal);
    expect(unlinked).toEqual({ kind: "ok", data: null });
  });
});

describe("the overview figures", () => {
  it("gives HR a headcount and per-department counts of active employees only", async () => {
    await createEmployee({ code: "O-1", work_email: "o1@example.test", department: "People" });
    await createEmployee({ code: "O-2", work_email: "o2@example.test", department: "People" });
    const gone = await createEmployee({ code: "O-3", work_email: "o3@example.test", department: "Finance" });
    await handleEmployeeStatus(
      post(`/api/employees/${gone.id}/status`, {
        action: "deactivate",
        version: gone.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      gone.id,
    );

    const overview = await loadOverview(appPool, adminPrincipal);
    expect(overview.kind).toBe("ok");
    if (overview.kind !== "ok" || overview.data.role !== "hr_admin") {
      throw new Error("expected the HR overview");
    }
    expect(overview.data.headcount).toBe(2);
    expect(overview.data.departments).toEqual([{ department: "People", count: 2 }]);
    expect(overview.data.pendingApprovals).toBe(0);
  });

  it("gives an employee their own name and no organization-wide total", async () => {
    const { token } = await linkedStaff("O-4");
    const staff = await loadPrincipal(appPool, token);
    const overview = await loadOverview(appPool, staff as Principal);
    expect(overview).toEqual({
      kind: "ok",
      data: { role: "employee", fullName: "Cy Staff", leaveRequests: 0 },
    });
    expect(JSON.stringify(overview)).not.toContain("headcount");
  });
});

describe("manage create-user --employee", () => {
  it("refuses a code that does not exist, one already linked, and a deactivated record", async () => {
    const employee = await createEmployee({ code: "L-1", work_email: "l1@example.test" });

    await expect(
      createUser(ownerPool, {
        email: "nobody@example.test",
        password: OTHER_PASSWORD,
        role: "employee",
        employeeCode: "L-404",
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "employee_not_found" });

    await createUser(ownerPool, {
      email: STAFF_EMAIL,
      password: OTHER_PASSWORD,
      role: "employee",
      employeeCode: "L-1",
      correlationId: randomUUID(),
    });
    await expect(
      createUser(ownerPool, {
        email: "second.login@example.test",
        password: OTHER_PASSWORD,
        role: "employee",
        employeeCode: "L-1",
        correlationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "employee_already_linked" });

    const current = await employeeRow(employee.id);
    await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, {
        action: "deactivate",
        version: current?.version ?? 1,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    const inactive = await createEmployee({ code: "L-2", work_email: "l2@example.test" });
    await handleEmployeeStatus(
      post(`/api/employees/${inactive.id}/status`, {
        action: "deactivate",
        version: inactive.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      inactive.id,
    );
    const refusal = createUser(ownerPool, {
      email: "third.login@example.test",
      password: OTHER_PASSWORD,
      role: "employee",
      employeeCode: "L-2",
      correlationId: randomUUID(),
    });
    await expect(refusal).rejects.toBeInstanceOf(ProvisioningError);
    await expect(refusal).rejects.toMatchObject({ code: "employee_inactive" });

    // The refused account was not created either: the link and the insert share one transaction.
    const orphan = await withClient(ownerPool, async (client) =>
      client.query("SELECT 1 FROM accounts WHERE email = $1", ["third.login@example.test"]),
    );
    expect(orphan.rowCount).toBe(0);
  });
});

describe("the HR list", () => {
  it("shows active and inactive records, with the link projected as a flag", async () => {
    const { employee } = await linkedStaff("H-1");
    const other = await createEmployee({ code: "H-2", work_email: "h2@example.test" });
    await handleEmployeeStatus(
      post(`/api/employees/${other.id}/status`, {
        action: "deactivate",
        version: other.version,
        csrf: adminPrincipal.csrfToken,
      }),
      appPool,
      other.id,
    );

    const list = await listEmployeesForHr(appPool, adminPrincipal);
    expect(list.kind).toBe("ok");
    if (list.kind !== "ok") {
      throw new Error("expected the HR list");
    }
    expect(list.data).toHaveLength(2);
    expect(list.data.find((row) => row.id === employee.id)?.link).toEqual({
      linked: true,
      email: STAFF_EMAIL,
    });
    expect(list.data.find((row) => row.id === other.id)?.active).toBe(false);
    expect(JSON.stringify(list.data)).not.toContain("account_id");
  });
});
