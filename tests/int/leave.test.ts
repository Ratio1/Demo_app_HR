import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, withClient, type Pool } from "../../src/server/db/pool.ts";
import { deriveAppRole, runMigrations } from "../../src/server/db/migrate.ts";
import { APP_ENV_FILE, DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.ts";
import { handleLogin } from "../../src/app/api/login/route.ts";
import { handleEmployeeCreate } from "../../src/app/api/employees/route.ts";
import { handleEmployeeStatus } from "../../src/app/api/employees/[id]/status/route.ts";
import { handleLeaveCreate } from "../../src/app/api/leave/route.ts";
import { handleLeaveCancel } from "../../src/app/api/leave/[id]/cancel/route.ts";
import { handleLeaveDecision } from "../../src/app/api/leave/[id]/decision/route.ts";
import { LOGIN_CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/shared/cookies.ts";
import { loadPrincipal, type Principal } from "../../src/server/auth/session.ts";
import { newToken } from "../../src/server/auth/tokens.ts";
import { bootstrap, createUser } from "../../src/server/services/accounts.ts";
import { linkEmployeeAccount } from "../../src/server/repos/employees.ts";
import { getEmployeeForHr } from "../../src/server/services/employees.ts";
import { loadApprovals, loadOwnLeave } from "../../src/server/services/leave.ts";
import { loadOverview } from "../../src/server/services/overview.ts";
import type { HrEmployeeDTO } from "../../src/server/dto/employees.ts";
import type { ApprovalDTO, OwnLeaveDTO } from "../../src/server/dto/leave.ts";

/**
 * Integration coverage for the slice 3 leave surface against the `hr_test` database (spec §2
 * Leave, §6 S4, S7). The three Route Handlers are driven as plain `(Request, Pool, id)` functions
 * on the **runtime** role's pool, exactly as the server runs them, so anything the grants forbid
 * fails here rather than in production; provisioning runs on the owner pool, as `manage` does.
 *
 * Three principals, because the rules need them: `ada` is an HR administrator with **no** employee
 * record (she can decide but not submit), `bo` is an HR administrator **with** one (so her own
 * request proves the self-approval bar), and `cy` is an ordinary employee.
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

const STAFF_CODE = "E-3001";
const ADMIN_EMPLOYEE_CODE = "E-3002";

/** 2026-10-05 is a Monday and 2026-10-09 the Friday of the same week: five weekdays. */
const RANGE = { start_date: "2026-10-05", end_date: "2026-10-09" } as const;
/** Wed–Mon, overlapping the range above: four weekdays. */
const OVERLAPPING = { start_date: "2026-10-07", end_date: "2026-10-12" } as const;
/** Four weeks later, touching nothing. */
const SEPARATE = { start_date: "2026-11-02", end_date: "2026-11-06" } as const;

let ownerPool: Pool;
let appPool: Pool;
/** A second runtime pool, so two "concurrent" requests really are on two connections. */
let secondPool: Pool;

interface Actor {
  readonly email: string;
  token: string;
  principal: Principal;
}

const ada: Actor = { email: ADMIN_EMAIL, token: "", principal: null as unknown as Principal };
const bo: Actor = { email: SECOND_ADMIN_EMAIL, token: "", principal: null as unknown as Principal };
const cy: Actor = { email: STAFF_EMAIL, token: "", principal: null as unknown as Principal };

let staffEmployee: HrEmployeeDTO;
let adminEmployee: HrEmployeeDTO;

interface RequestOptions {
  readonly origin?: string | null;
  readonly token?: string | null;
  readonly contentType?: string;
  readonly rawBody?: string;
}

/** A JSON POST carrying one actor's session cookie, as the pages' `fetch` sends it. */
function post(
  path: string,
  actor: Actor | null,
  body: Record<string, unknown> | null,
  options: RequestOptions = {},
): Request {
  const headers = new Headers({ "content-type": options.contentType ?? "application/json" });
  const origin = options.origin === undefined ? PUBLIC_ORIGIN : options.origin;
  if (origin !== null) {
    headers.set("origin", origin);
  }
  const token = options.token === undefined ? (actor?.token ?? null) : options.token;
  if (token !== null) {
    headers.set("cookie", `${SESSION_COOKIE_NAME}=${token}`);
  }
  return new Request(`${PUBLIC_ORIGIN}${path}`, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(body ?? {}),
  });
}

function leaveBody(
  actor: Actor,
  range: { start_date: string; end_date: string } = RANGE,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return { kind: "annual", ...range, csrf: actor.principal.csrfToken, ...overrides };
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

async function signIn(actor: Actor, password: string): Promise<void> {
  actor.token = await logIn(actor.email, password);
  const principal = await loadPrincipal(appPool, actor.token);
  if (principal === null) {
    throw new Error(`${actor.email} did not resolve to a principal`);
  }
  actor.principal = principal;
}

async function createEmployeeAs(
  actor: Actor,
  code: string,
  fullName: string,
  workEmail: string,
): Promise<HrEmployeeDTO> {
  const response = await handleEmployeeCreate(
    post("/api/employees", actor, {
      code,
      full_name: fullName,
      work_email: workEmail,
      title: "Coordinator",
      department: "People",
      start_date: "2026-03-02",
      csrf: actor.principal.csrfToken,
    }),
    appPool,
  );
  expect(response.status).toBe(200);
  return ((await response.json()) as { employee: HrEmployeeDTO }).employee;
}

async function reloadEmployee(id: string): Promise<HrEmployeeDTO> {
  const result = await getEmployeeForHr(appPool, ada.principal, id);
  if (result.kind !== "ok" || result.data === null) {
    throw new Error("employee disappeared");
  }
  return result.data;
}

async function submit(
  actor: Actor,
  range: { start_date: string; end_date: string } = RANGE,
  pool: Pool = appPool,
): Promise<Response> {
  return handleLeaveCreate(post("/api/leave", actor, leaveBody(actor, range)), pool);
}

async function submitOk(
  actor: Actor,
  range: { start_date: string; end_date: string } = RANGE,
): Promise<OwnLeaveDTO> {
  const response = await submit(actor, range);
  expect(response.status).toBe(200);
  return ((await response.json()) as { request: OwnLeaveDTO }).request;
}

async function decide(
  actor: Actor,
  id: string,
  action: "approve" | "reject",
  version: number,
  pool: Pool = appPool,
): Promise<Response> {
  return handleLeaveDecision(
    post(`/api/leave/${id}/decision`, actor, {
      action,
      version,
      csrf: actor.principal.csrfToken,
    }),
    pool,
    id,
  );
}

async function cancel(actor: Actor, id: string, version: number): Promise<Response> {
  return handleLeaveCancel(
    post(`/api/leave/${id}/cancel`, actor, { version, csrf: actor.principal.csrfToken }),
    appPool,
    id,
  );
}

async function leaveRow(
  id: string,
): Promise<
  { status: string; version: number; decided_by: string | null; decided_at: Date | null } | undefined
> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{
      status: string;
      version: number;
      decided_by: string | null;
      decided_at: Date | null;
    }>("SELECT status, version, decided_by, decided_at FROM leave_requests WHERE id = $1", [id]);
    return result.rows[0];
  });
}

async function leaveCount(employeeId?: string): Promise<number> {
  return withClient(ownerPool, async (client) => {
    const result =
      employeeId === undefined
        ? await client.query<{ total: string }>("SELECT count(*) AS total FROM leave_requests")
        : await client.query<{ total: string }>(
            "SELECT count(*) AS total FROM leave_requests WHERE employee_id = $1",
            [employeeId],
          );
    return Number(result.rows[0]?.total ?? "0");
  });
}

async function auditRows(): Promise<
  Array<{ action: string; outcome: string; object_id: string | null; correlation_id: string }>
> {
  return withClient(appPool, async (client) => {
    const result = await client.query<{
      action: string;
      outcome: string;
      object_id: string | null;
      correlation_id: string;
    }>(
      `SELECT action, outcome, object_id, correlation_id
         FROM audit_events
        WHERE action LIKE 'leave.%'
        ORDER BY occurred_at, action`,
    );
    return result.rows;
  });
}

beforeAll(async () => {
  const ownerConfig = testConfig(OWNER_ENV_FILE);
  ownerPool = createPool(ownerConfig);
  appPool = createPool(testConfig(APP_ENV_FILE));
  secondPool = createPool(testConfig(APP_ENV_FILE));
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
  await secondPool.end();
});

beforeEach(async () => {
  await withClient(ownerPool, async (client) => {
    await client.query("DELETE FROM leave_requests");
    await client.query("DELETE FROM employees");
    await client.query(
      "DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email = $1)",
      [STAFF_EMAIL],
    );
    await client.query("DELETE FROM accounts WHERE email = $1", [STAFF_EMAIL]);
    await client.query("DELETE FROM audit_events");
    await client.query("UPDATE accounts SET active = true, failed_logins = 0, locked_until = NULL");
  });

  await signIn(ada, ADMIN_PASSWORD);

  staffEmployee = await createEmployeeAs(ada, STAFF_CODE, "Cy Staff", STAFF_EMAIL);
  adminEmployee = await createEmployeeAs(ada, ADMIN_EMPLOYEE_CODE, "Bo Second", SECOND_ADMIN_EMAIL);

  // `cy` gets a login through the same path the operator uses.
  await createUser(ownerPool, {
    email: STAFF_EMAIL,
    password: OTHER_PASSWORD,
    role: "employee",
    employeeCode: STAFF_CODE,
    correlationId: randomUUID(),
  });
  // `bo`'s account already exists from beforeAll, so her record is linked with the same
  // repository function `manage create-user --employee` calls.
  await withClient(ownerPool, async (client) => {
    const account = await client.query<{ id: string }>(
      "SELECT id FROM accounts WHERE email = $1",
      [SECOND_ADMIN_EMAIL],
    );
    const outcome = await linkEmployeeAccount(
      client,
      ADMIN_EMPLOYEE_CODE,
      account.rows[0]?.id as string,
    );
    expect(outcome).toBe("linked");
  });

  staffEmployee = await reloadEmployee(staffEmployee.id);
  adminEmployee = await reloadEmployee(adminEmployee.id);

  await signIn(bo, OTHER_PASSWORD);
  await signIn(cy, OTHER_PASSWORD);
  // Sanity: the fixture really is what the rules are about.
  expect(staffEmployee.link).toEqual({ linked: true, email: STAFF_EMAIL });
  expect(adminEmployee.link).toEqual({ linked: true, email: SECOND_ADMIN_EMAIL });
});

describe("POST /api/leave — submit", () => {
  it("writes the row and its audit event in one transaction, with the derived weekday count", async () => {
    const request = await submitOk(cy);
    expect(request.status).toBe("pending");
    expect(request.version).toBe(1);
    expect(request.weekdays).toBe(5);
    expect(request.start_date).toBe(RANGE.start_date);
    expect(typeof request.start_date).toBe("string");
    expect(request.decided_at).toBeNull();
    expect(Object.keys(request)).not.toContain("decided_by");
    expect(Object.keys(request)).not.toContain("employee_id");

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("leave.submit");
    expect(rows[0]?.outcome).toBe("ok");
    expect(rows[0]?.object_id).toBe(request.id);

    const stored = await leaveRow(request.id);
    expect(stored?.status).toBe("pending");
    expect(stored?.decided_by).toBeNull();
    expect(stored?.decided_at).toBeNull();
  });

  it("lets a linked HR admin submit for themselves", async () => {
    const request = await submitOk(bo, SEPARATE);
    expect(request.status).toBe("pending");
    expect(await leaveCount(adminEmployee.id)).toBe(1);
  });

  it("refuses an unlinked HR admin with 403 and writes nothing", async () => {
    const response = await submit(ada);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "forbidden" });
    expect(await leaveCount()).toBe(0);
    expect(await auditRows()).toHaveLength(0);
  });

  it("refuses an anonymous caller with 401, a bad Origin and a bad CSRF token with 403", async () => {
    const anonymous = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy), { token: null }),
      appPool,
    );
    expect(anonymous.status).toBe(401);

    const foreign = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy), { origin: "https://evil.example.test" }),
      appPool,
    );
    expect(foreign.status).toBe(403);

    const missingOrigin = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy), { origin: null }),
      appPool,
    );
    expect(missingOrigin.status).toBe(403);

    const badToken = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy, RANGE, { csrf: newToken() })),
      appPool,
    );
    expect(badToken.status).toBe(403);

    expect(await leaveCount()).toBe(0);
  });

  it("refuses a weekend-only range with a per-field message and no row", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy, { start_date: "2026-10-10", end_date: "2026-10-11" })),
      appPool,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fields?: Record<string, string> };
    expect(body.error).toBe("invalid_input");
    expect(body.fields?.end_date).toContain("weekday");
    expect(await leaveCount()).toBe(0);
  });

  it("refuses an inverted range and an impossible date", async () => {
    const inverted = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy, { start_date: "2026-10-09", end_date: "2026-10-05" })),
      appPool,
    );
    expect(inverted.status).toBe(400);

    const impossible = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy, { start_date: "2026-02-30", end_date: "2026-03-02" })),
      appPool,
    );
    expect(impossible.status).toBe(400);
    expect(await leaveCount()).toBe(0);
  });

  for (const key of ["employee_id", "status", "decided_by", "weekdays", "reason", "version"]) {
    it(`refuses an over-posted ${key} with a detail-free 400`, async () => {
      const response = await handleLeaveCreate(
        post("/api/leave", cy, leaveBody(cy, RANGE, { [key]: key === "weekdays" ? 99 : "x" })),
        appPool,
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string; fields?: unknown };
      expect(body.error).toBe("invalid_input");
      expect(body.fields).toBeUndefined();
      expect(await leaveCount()).toBe(0);
    });
  }

  it("refuses a kind outside annual|personal (spec §2: no medical category)", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, leaveBody(cy, RANGE, { kind: "sick" })),
      appPool,
    );
    expect(response.status).toBe(400);
    expect(await leaveCount()).toBe(0);
  });

  it("accepts the same body form-encoded", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, null, {
        contentType: "application/x-www-form-urlencoded",
        rawBody: new URLSearchParams({
          kind: "personal",
          ...RANGE,
          csrf: cy.principal.csrfToken,
        }).toString(),
      }),
      appPool,
    );
    expect(response.status).toBe(200);
    expect(await leaveCount(staffEmployee.id)).toBe(1);
  });
});

describe("the overlap rule", () => {
  it("refuses a range overlapping a pending request with 409 and writes no row", async () => {
    const first = await submitOk(cy);
    const response = await submit(cy, OVERLAPPING);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "conflict_overlap" });
    expect(await leaveCount(staffEmployee.id)).toBe(1);
    expect((await auditRows()).filter((row) => row.action === "leave.submit")).toHaveLength(1);
    expect((await leaveRow(first.id))?.status).toBe("pending");
  });

  it("refuses a range overlapping an approved request", async () => {
    const first = await submitOk(cy);
    expect((await decide(ada, first.id, "approve", first.version)).status).toBe(200);

    const response = await submit(cy, OVERLAPPING);
    expect(response.status).toBe(409);
    expect(await leaveCount(staffEmployee.id)).toBe(1);
  });

  it("allows a range overlapping a cancelled or rejected request", async () => {
    const cancelled = await submitOk(cy);
    expect((await cancel(cy, cancelled.id, cancelled.version)).status).toBe(200);
    const afterCancel = await submitOk(cy, OVERLAPPING);
    expect(afterCancel.status).toBe("pending");

    expect((await decide(ada, afterCancel.id, "reject", afterCancel.version)).status).toBe(200);
    const afterReject = await submitOk(cy, RANGE);
    expect(afterReject.status).toBe("pending");
    expect(await leaveCount(staffEmployee.id)).toBe(3);
  });

  it("does not see a colleague's range as an overlap", async () => {
    await submitOk(cy);
    const other = await submitOk(bo);
    expect(other.status).toBe("pending");
    expect(await leaveCount()).toBe(2);
  });

  it("lets exactly one of two concurrent overlapping submissions through", async () => {
    const [a, b] = await Promise.all([
      submit(cy, RANGE, appPool),
      submit(cy, OVERLAPPING, secondPool),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    expect(await loser.json()).toEqual({ error: "conflict_overlap" });
    expect(await leaveCount(staffEmployee.id)).toBe(1);
    expect((await auditRows()).filter((row) => row.action === "leave.submit")).toHaveLength(1);
  });
});

describe("POST /api/leave/<id>/decision", () => {
  it("approves a pending request, recording who decided and when", async () => {
    const request = await submitOk(cy);
    const response = await decide(ada, request.id, "approve", request.version);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: string; request: ApprovalDTO };
    expect(body.request.status).toBe("approved");
    expect(body.request.version).toBe(2);
    expect(body.request.own).toBe(false);
    expect(body.request.employee).toEqual({
      code: STAFF_CODE,
      full_name: "Cy Staff",
      department: "People",
    });
    expect(body.location).toBe(`/approvals?id=${request.id}&saved=approved`);

    const stored = await leaveRow(request.id);
    expect(stored?.status).toBe("approved");
    expect(stored?.decided_by).toBe(ada.principal.accountId);
    expect(stored?.decided_at).not.toBeNull();

    const rows = await auditRows();
    expect(rows.map((row) => `${row.action}:${row.outcome}`)).toEqual([
      "leave.submit:ok",
      "leave.approve:ok",
    ]);
  });

  it("rejects a pending request", async () => {
    const request = await submitOk(cy);
    expect((await decide(ada, request.id, "reject", request.version)).status).toBe(200);
    expect((await leaveRow(request.id))?.status).toBe("rejected");
    expect((await auditRows()).some((row) => row.action === "leave.reject")).toBe(true);
  });

  it("bars self-approval with 403, writes a denied audit row and leaves the request pending", async () => {
    const own = await submitOk(bo, SEPARATE);
    for (const action of ["approve", "reject"] as const) {
      const response = await decide(bo, own.id, action, own.version);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "forbidden" });
    }

    expect((await leaveRow(own.id))?.status).toBe("pending");
    expect((await leaveRow(own.id))?.version).toBe(1);
    const denied = (await auditRows()).filter((row) => row.outcome === "denied");
    expect(denied.map((row) => row.action).sort()).toEqual(["leave.approve", "leave.reject"]);

    // A different administrator may decide the very same request (spec §2).
    const allowed = await decide(ada, own.id, "approve", own.version);
    expect(allowed.status).toBe(200);
    expect((await leaveRow(own.id))?.status).toBe("approved");
  });

  it("refuses an employee with 403 and changes nothing", async () => {
    const request = await submitOk(cy);
    const response = await decide(cy, request.id, "approve", request.version);
    expect(response.status).toBe(403);
    expect((await leaveRow(request.id))?.status).toBe("pending");
    expect((await auditRows()).filter((row) => row.action === "leave.approve")).toHaveLength(0);
  });

  it("answers 404 for an unknown or malformed id", async () => {
    expect((await decide(ada, randomUUID(), "approve", 1)).status).toBe(404);
    expect((await decide(ada, "not-a-uuid", "approve", 1)).status).toBe(404);
  });

  it("answers 409 conflict_not_pending for a cancelled request", async () => {
    const request = await submitOk(cy);
    expect((await cancel(cy, request.id, request.version)).status).toBe(200);

    const response = await decide(ada, request.id, "approve", 2);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; current: ApprovalDTO };
    expect(body.error).toBe("conflict_not_pending");
    expect(body.current.status).toBe("cancelled");
    expect((await leaveRow(request.id))?.status).toBe("cancelled");
  });

  it("answers 409 conflict_not_pending for an already decided request", async () => {
    const request = await submitOk(cy);
    expect((await decide(ada, request.id, "approve", request.version)).status).toBe(200);

    const again = await decide(bo, request.id, "reject", 2);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe("conflict_not_pending");
    expect((await leaveRow(request.id))?.status).toBe("approved");
    expect((await leaveRow(request.id))?.version).toBe(2);
  });

  it("answers 409 conflict_stale when the version has moved", async () => {
    const request = await submitOk(cy);
    const response = await decide(ada, request.id, "approve", request.version + 5);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; current: ApprovalDTO };
    expect(body.error).toBe("conflict_stale");
    expect(body.current.version).toBe(1);
    expect((await leaveRow(request.id))?.status).toBe("pending");
  });

  it("lets exactly one of two concurrent decisions win, with one audit row and version 2", async () => {
    const request = await submitOk(cy);
    const [a, b] = await Promise.all([
      decide(ada, request.id, "approve", request.version, appPool),
      decide(bo, request.id, "reject", request.version, secondPool),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const loser = a.status === 409 ? a : b;
    expect(((await loser.json()) as { error: string }).error).toBe("conflict_not_pending");

    const stored = await leaveRow(request.id);
    expect(stored?.version).toBe(2);
    expect(["approved", "rejected"]).toContain(stored?.status);

    const decisions = (await auditRows()).filter(
      (row) => row.action === "leave.approve" || row.action === "leave.reject",
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.outcome).toBe("ok");
  });
});

describe("POST /api/leave/<id>/cancel", () => {
  it("lets the owner cancel their own pending request", async () => {
    const request = await submitOk(cy);
    const response = await cancel(cy, request.id, request.version);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { location: string; request: OwnLeaveDTO };
    expect(body.request.status).toBe("cancelled");
    expect(body.request.version).toBe(2);
    expect(body.request.decided_at).toBeNull();
    expect(body.location).toBe(`/leave?id=${request.id}&saved=cancelled`);

    const stored = await leaveRow(request.id);
    expect(stored?.status).toBe("cancelled");
    expect(stored?.decided_by).toBeNull();
    expect((await auditRows()).map((row) => row.action)).toEqual([
      "leave.submit",
      "leave.cancel",
    ]);
  });

  it("answers 404 when another employee tries to cancel it", async () => {
    const request = await submitOk(cy);
    const response = await cancel(bo, request.id, request.version);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
    expect((await leaveRow(request.id))?.status).toBe("pending");
  });

  it("answers 404 for an HR admin — existence is not theirs to confirm here", async () => {
    const request = await submitOk(cy);
    expect((await cancel(ada, request.id, request.version)).status).toBe(404);
    expect((await leaveRow(request.id))?.status).toBe("pending");
    expect((await auditRows()).filter((row) => row.action === "leave.cancel")).toHaveLength(0);
  });

  it("answers 409 conflict_not_pending for an already decided request", async () => {
    const request = await submitOk(cy);
    expect((await decide(ada, request.id, "approve", request.version)).status).toBe(200);

    const response = await cancel(cy, request.id, 2);
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string; current: OwnLeaveDTO };
    expect(body.error).toBe("conflict_not_pending");
    expect(body.current.status).toBe("approved");
    expect(Object.keys(body.current)).not.toContain("employee");
  });

  it("answers 409 conflict_stale when the version has moved", async () => {
    const request = await submitOk(cy);
    const response = await cancel(cy, request.id, request.version + 1);
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("conflict_stale");
    expect((await leaveRow(request.id))?.status).toBe("pending");
  });

  it("answers 404 for an unknown id", async () => {
    expect((await cancel(cy, randomUUID(), 1)).status).toBe(404);
  });
});

describe("the reads", () => {
  it("gives an employee their own history and nothing else", async () => {
    const mine = await submitOk(cy);
    await submitOk(bo, SEPARATE);

    const result = await loadOwnLeave(appPool, cy.principal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok" && result.data.linked) {
      expect(result.data.requests).toHaveLength(1);
      expect(result.data.requests[0]?.id).toBe(mine.id);
      expect(JSON.stringify(result.data)).not.toContain("Bo Second");
    } else {
      throw new Error("the employee's own leave did not load");
    }
  });

  it("tells an unlinked HR admin that no employee record is linked", async () => {
    const result = await loadOwnLeave(appPool, ada.principal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(result.data).toEqual({ linked: false });
    }
  });

  it("refuses the approval queue to an employee", async () => {
    await submitOk(cy);
    const result = await loadApprovals(appPool, cy.principal);
    expect(result.kind).toBe("forbidden");
  });

  it("gives HR the queue with the own flag set only for their own request", async () => {
    const staffRequest = await submitOk(cy);
    const ownRequest = await submitOk(bo, SEPARATE);

    const asBo = await loadApprovals(appPool, bo.principal);
    if (asBo.kind !== "ok") {
      throw new Error("the queue did not load");
    }
    const byId = new Map(asBo.data.pending.map((row) => [row.id, row]));
    expect(byId.get(staffRequest.id)?.own).toBe(false);
    expect(byId.get(ownRequest.id)?.own).toBe(true);
    expect(asBo.data.decided).toHaveLength(0);

    const asAda = await loadApprovals(appPool, ada.principal);
    if (asAda.kind !== "ok") {
      throw new Error("the queue did not load");
    }
    expect(asAda.data.pending.every((row) => !row.own)).toBe(true);
    expect(JSON.stringify(asAda.data)).not.toContain("decided_by");
  });

  it("moves a decided request into the decided section", async () => {
    const request = await submitOk(cy);
    expect((await decide(ada, request.id, "approve", request.version)).status).toBe(200);

    const result = await loadApprovals(appPool, ada.principal);
    if (result.kind !== "ok") {
      throw new Error("the queue did not load");
    }
    expect(result.data.pending).toHaveLength(0);
    expect(result.data.decided.map((row) => row.id)).toEqual([request.id]);
    expect(result.data.decided[0]?.status).toBe("approved");
  });
});

describe("the dashboards", () => {
  it("counts headcount, departments and the pending queue for HR", async () => {
    await submitOk(cy);
    await submitOk(bo, SEPARATE);

    const result = await loadOverview(appPool, ada.principal);
    if (result.kind !== "ok" || result.data.role !== "hr_admin") {
      throw new Error("the HR overview did not load");
    }
    expect(result.data.headcount).toBe(2);
    expect(result.data.departments).toEqual([{ department: "People", count: 2 }]);
    expect(result.data.pendingApprovals).toBe(2);

    const decided = await loadOwnLeave(appPool, cy.principal);
    if (decided.kind !== "ok" || !decided.data.linked) {
      throw new Error("the employee's leave did not load");
    }
    const mine = decided.data.requests[0] as OwnLeaveDTO;
    expect((await decide(ada, mine.id, "approve", mine.version)).status).toBe(200);

    const after = await loadOverview(appPool, ada.principal);
    if (after.kind !== "ok" || after.data.role !== "hr_admin") {
      throw new Error("the HR overview did not load");
    }
    expect(after.data.pendingApprovals).toBe(1);
  });

  it("gives an employee their own status and no HR total or colleague row", async () => {
    const mine = await submitOk(cy);
    await submitOk(bo, SEPARATE);
    expect((await decide(ada, mine.id, "approve", mine.version)).status).toBe(200);

    const result = await loadOverview(appPool, cy.principal);
    if (result.kind !== "ok" || result.data.role !== "employee") {
      throw new Error("the employee overview did not load");
    }
    expect(result.data.fullName).toBe("Cy Staff");
    expect(result.data.leaveRequests).toBe(1);
    expect(result.data.latest_status).toBe("approved");
    expect(result.data.own_requests.map((row) => row.id)).toEqual([mine.id]);

    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("headcount");
    expect(serialized).not.toContain("pendingApprovals");
    expect(serialized).not.toContain("Bo Second");
    expect(serialized).not.toContain(ADMIN_EMPLOYEE_CODE);
    expect(serialized).not.toContain("decided_by");
    expect(Object.keys(result.data).sort()).toEqual([
      "fullName",
      "latest_status",
      "leaveRequests",
      "own_requests",
      "role",
    ]);
  });
});

describe("the slice-2 deactivation cascade still cancels pending leave", () => {
  it("cancels the employee's pending request and leaves approved history alone", async () => {
    const approved = await submitOk(cy, SEPARATE);
    expect((await decide(ada, approved.id, "approve", approved.version)).status).toBe(200);
    const pending = await submitOk(cy, RANGE);

    const employee = await reloadEmployee(staffEmployee.id);
    const response = await handleEmployeeStatus(
      post(`/api/employees/${employee.id}/status`, ada, {
        action: "deactivate",
        version: employee.version,
        csrf: ada.principal.csrfToken,
      }),
      appPool,
      employee.id,
    );
    expect(response.status).toBe(200);

    expect((await leaveRow(pending.id))?.status).toBe("cancelled");
    expect((await leaveRow(approved.id))?.status).toBe("approved");

    const cancelled = (await auditRows()).filter((row) => row.action === "leave.cancel");
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.object_id).toBe(pending.id);

    // The cascade revoked the session, so the employee cannot submit again.
    const afterwards = await submit(cy, { start_date: "2026-12-07", end_date: "2026-12-11" });
    expect(afterwards.status).toBe(401);
  });
});
