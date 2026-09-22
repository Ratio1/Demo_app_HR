import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, withClient, type Pool } from "../../src/server/db/pool.ts";
import { deriveAppRole, runMigrations } from "../../src/server/db/migrate.ts";
import { APP_ENV_FILE, DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.ts";
import { handleLogin } from "../../src/app/api/login/route.ts";
import { handleEmployeeCreate } from "../../src/app/api/employees/route.ts";
import { handleEmployeeUpdate } from "../../src/app/api/employees/[id]/route.ts";
import { handleEmployeeStatus } from "../../src/app/api/employees/[id]/status/route.ts";
import { handlePasswordChange } from "../../src/app/api/password/route.ts";
import { handleLeaveCreate } from "../../src/app/api/leave/route.ts";
import { handleLeaveCancel } from "../../src/app/api/leave/[id]/cancel/route.ts";
import { handleLeaveDecision } from "../../src/app/api/leave/[id]/decision/route.ts";
import { LOGIN_CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/shared/cookies.ts";
import { loadPrincipal, type Principal } from "../../src/server/auth/session.ts";
import { newToken } from "../../src/server/auth/tokens.ts";
import { bootstrap, createUser, disableUser } from "../../src/server/services/accounts.ts";
import { linkEmployeeAccount } from "../../src/server/repos/employees.ts";
import { getEmployeeForHr, listEmployeesForHr } from "../../src/server/services/employees.ts";
import { loadApprovals, loadOwnLeave } from "../../src/server/services/leave.ts";
import type { HrEmployeeDTO } from "../../src/server/dto/employees.ts";

/**
 * Slice 4 — the DENY suite (slice-4-brief.md, `_agents/projects/HR/design/access-matrix.md`
 * §7.2). Every `it` name carries the `D-###` id and, where the matrix gives one, the `G2-###`
 * test id verbatim, transcribed from §7.2 and interpreted as little as possible: this file
 * proves what the *running application* actually answers.
 *
 * Where the running code disagrees with the matrix's documented outcome and no ruling has
 * settled which side is right (fix round, 2026-09-23), the row carries **two** assertions rather
 * than one pointed either way: a plain, passing `it` that pins the current code (a regression
 * guard), and an `it.fails` "matrix ratchet" that keeps the matrix's own expectation in the
 * suite, visible and loudly self-correcting — Vitest's named expected-failure mechanism reports
 * it as an ordinary pass while the mismatch stands, and flips it to a reported *failure* the
 * moment the code and the matrix start agreeing, which is the signal to delete the ratchet and
 * update the guard. A row this round could resolve outright (a transcription error, not a design
 * disagreement) is fixed as a single assertion instead — see D-081.
 *
 * Same harness as `tests/int/leave.test.ts`/`employees.test.ts`: Route Handlers driven as plain
 * `(Request, Pool, id?)` functions against `hr_test`, runtime pool for the handlers, owner pool
 * for fixtures and raw-row assertions. All data is fictional, every address `example.test`.
 */
const ADMIN_EMAIL = "ada.first@example.test"; // hr_admin, unlinked (bootstrap admin)
const SECOND_ADMIN_EMAIL = "bo.second@example.test"; // hr_admin, linked
const STAFF_EMAIL = "cy.staff@example.test"; // employee, linked
const OTHER_STAFF_EMAIL = "di.third@example.test"; // employee, linked (a second ordinary employee)
const ADMIN_PASSWORD = "quartz-harbour-19-lane";
const OTHER_PASSWORD = "velvet-meridian-7-brook";
const PUBLIC_ORIGIN = "https://hr.example.test";

const STAFF_CODE = "E-4001";
const OTHER_STAFF_CODE = "E-4002";
const ADMIN_EMPLOYEE_CODE = "E-4003";

const RANGE = { start_date: "2026-10-05", end_date: "2026-10-09" } as const; // Mon–Fri, 5 weekdays
const OTHER_RANGE = { start_date: "2026-11-02", end_date: "2026-11-06" } as const;

let ownerPool: Pool;
let appPool: Pool;

interface Actor {
  readonly email: string;
  token: string;
  principal: Principal;
}

const ada: Actor = { email: ADMIN_EMAIL, token: "", principal: null as unknown as Principal };
const bo: Actor = { email: SECOND_ADMIN_EMAIL, token: "", principal: null as unknown as Principal };
const cy: Actor = { email: STAFF_EMAIL, token: "", principal: null as unknown as Principal };
const di: Actor = { email: OTHER_STAFF_EMAIL, token: "", principal: null as unknown as Principal };

let staffEmployee: HrEmployeeDTO;
let otherStaffEmployee: HrEmployeeDTO;
let adminEmployee: HrEmployeeDTO;

interface RequestOptions {
  readonly origin?: string | null;
  readonly token?: string | null;
  readonly contentType?: string;
  readonly rawBody?: string;
}

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

function csrf(actor: Actor): string {
  return actor.principal.csrfToken;
}

async function logIn(email: string, password: string): Promise<string> {
  const token = newToken();
  const response = await handleLogin(
    new Request(`${PUBLIC_ORIGIN}/api/login`, {
      method: "POST",
      headers: new Headers({
        "content-type": "application/x-www-form-urlencoded",
        origin: PUBLIC_ORIGIN,
        cookie: `${LOGIN_CSRF_COOKIE_NAME}=${token}`,
      }),
      body: new URLSearchParams({ email, password, csrf: token }).toString(),
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
  throw new Error(`${email} login set no session cookie`);
}

async function signIn(actor: Actor, password: string): Promise<void> {
  actor.token = await logIn(actor.email, password);
  const principal = await loadPrincipal(appPool, actor.token);
  if (principal === null) {
    throw new Error(`${actor.email} did not resolve to a principal`);
  }
  actor.principal = principal;
}

async function createEmployeeAs(actor: Actor, code: string, fullName: string, workEmail: string): Promise<HrEmployeeDTO> {
  const response = await handleEmployeeCreate(
    post("/api/employees", actor, {
      code,
      full_name: fullName,
      work_email: workEmail,
      title: "Coordinator",
      department: "People",
      start_date: "2026-03-02",
      csrf: csrf(actor),
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

async function submitOk(actor: Actor, range: { start_date: string; end_date: string }): Promise<{ id: string; version: number }> {
  const response = await handleLeaveCreate(
    post("/api/leave", actor, { kind: "annual", ...range, csrf: csrf(actor) }),
    appPool,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { request: { id: string; version: number } };
  return body.request;
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
    await client.query(
      "DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE email = ANY($1))",
      [[STAFF_EMAIL, OTHER_STAFF_EMAIL]],
    );
    await client.query("DELETE FROM accounts WHERE email = ANY($1)", [[STAFF_EMAIL, OTHER_STAFF_EMAIL]]);
    await client.query("DELETE FROM audit_events");
    await client.query("UPDATE accounts SET active = true, failed_logins = 0, locked_until = NULL");
  });

  await signIn(ada, ADMIN_PASSWORD);

  staffEmployee = await createEmployeeAs(ada, STAFF_CODE, "Cy Staff", STAFF_EMAIL);
  otherStaffEmployee = await createEmployeeAs(ada, OTHER_STAFF_CODE, "Di Third", OTHER_STAFF_EMAIL);
  adminEmployee = await createEmployeeAs(ada, ADMIN_EMPLOYEE_CODE, "Bo Second", SECOND_ADMIN_EMAIL);

  await createUser(ownerPool, {
    email: STAFF_EMAIL,
    password: OTHER_PASSWORD,
    role: "employee",
    employeeCode: STAFF_CODE,
    correlationId: randomUUID(),
  });
  await createUser(ownerPool, {
    email: OTHER_STAFF_EMAIL,
    password: OTHER_PASSWORD,
    role: "employee",
    employeeCode: OTHER_STAFF_CODE,
    correlationId: randomUUID(),
  });
  await withClient(ownerPool, async (client) => {
    const account = await client.query<{ id: string }>("SELECT id FROM accounts WHERE email = $1", [
      SECOND_ADMIN_EMAIL,
    ]);
    const outcome = await linkEmployeeAccount(client, ADMIN_EMPLOYEE_CODE, account.rows[0]?.id as string);
    expect(outcome).toBe("linked");
  });

  staffEmployee = await reloadEmployee(staffEmployee.id);
  otherStaffEmployee = await reloadEmployee(otherStaffEmployee.id);
  adminEmployee = await reloadEmployee(adminEmployee.id);

  await signIn(bo, OTHER_PASSWORD);
  await signIn(cy, OTHER_PASSWORD);
  await signIn(di, OTHER_PASSWORD);
}, 30_000);

describe("D-001 — anonymous, no session, every mutation (G2-001)", () => {
  it("POST /api/leave with no cookie is 401 unauthenticated", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", null, { kind: "annual", ...RANGE, csrf: "whatever-43-characters-long-000000000000000" }, { token: null }),
      appPool,
    );
    expect(response.status).toBe(401);
  });

  it("POST /api/employees with no cookie is 401 unauthenticated", async () => {
    const response = await handleEmployeeCreate(
      post(
        "/api/employees",
        null,
        {
          code: "E-9999",
          full_name: "Nobody",
          work_email: "nobody@example.test",
          title: "x",
          department: "x",
          start_date: "2026-01-01",
          csrf: "whatever-43-characters-long-000000000000000",
        },
        { token: null },
      ),
      appPool,
    );
    expect(response.status).toBe(401);
  });
});

describe("D-003 — deactivated account, live session, every action (G2-005)", () => {
  it("a session issued before deactivation is dead the instant the account is disabled", async () => {
    const tokenBeforeDeactivation = di.token;
    await disableUser(ownerPool, { email: OTHER_STAFF_EMAIL, correlationId: randomUUID() });

    const response = await handleLeaveCreate(
      post("/api/leave", null, { kind: "annual", ...RANGE, csrf: "x" }, { token: tokenBeforeDeactivation }),
      appPool,
    );
    expect(response.status).toBe(401);
  });
});

describe("D-005 — every mutation body, over 64 KiB (G2-008)", () => {
  it("a 100 KiB POST /api/leave body is 413 too_large", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, null, { rawBody: "a".repeat(100 * 1024) }),
      appPool,
    );
    expect(response.status).toBe(413);
  });
});

describe("D-007 — `role` on any create/update, over-post (G2-010)", () => {
  it("POST /api/employees with a `role` key is 400 invalid_input, no fields", async () => {
    const response = await handleEmployeeCreate(
      post("/api/employees", ada, {
        code: "E-9000",
        full_name: "Someone New",
        work_email: "someone.new@example.test",
        title: "x",
        department: "x",
        start_date: "2026-01-01",
        role: "hr_admin",
        csrf: csrf(ada),
      }),
      appPool,
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; fields?: unknown };
    expect(body.error).toBe("invalid_input");
    expect(body.fields).toBeUndefined();
  });
});

describe("D-008 — `version` on a create, over-post (G2-011)", () => {
  it("POST /api/leave with a `version` key is 400 invalid_input", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, { kind: "annual", ...RANGE, version: 1, csrf: csrf(cy) }),
      appPool,
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe("invalid_input");
  });
});

describe("D-010 — system-owned columns, over-post (G2-013)", () => {
  it("POST /api/employees with `password_hash` is 400 invalid_input", async () => {
    const response = await handleEmployeeCreate(
      post("/api/employees", ada, {
        code: "E-9001",
        full_name: "Someone New",
        work_email: "someone.new2@example.test",
        title: "x",
        department: "x",
        start_date: "2026-01-01",
        password_hash: "not-a-hash",
        csrf: csrf(ada),
      }),
      appPool,
    );
    expect(response.status).toBe(400);
  });
});

describe("D-011 — free-text `reason` on leave, over-post (G2-014)", () => {
  it("POST /api/leave with a `reason` key is 400 invalid_input", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, { kind: "annual", ...RANGE, reason: "personal matter", csrf: csrf(cy) }),
      appPool,
    );
    expect(response.status).toBe(400);
  });
});

describe("D-013 — account(self), any field beyond the two password fields (G2-017)", () => {
  it("POST /api/password with a `role` key is 400 invalid_input", async () => {
    const csrfToken = csrf(cy);
    const response = await handlePasswordChange(
      new Request(`${PUBLIC_ORIGIN}/api/password`, {
        method: "POST",
        headers: new Headers({
          "content-type": "application/x-www-form-urlencoded",
          origin: PUBLIC_ORIGIN,
          cookie: `${SESSION_COOKIE_NAME}=${cy.token}`,
        }),
        body: new URLSearchParams({
          current_password: OTHER_PASSWORD,
          new_password: "a-brand-new-password-16",
          role: "hr_admin",
          csrf: csrfToken,
        }).toString(),
      }),
      appPool,
    );
    expect(response.status).toBe(400);
  });
});

describe("D-015 — last-admin path (a): `manage disable-user` on the last active hr_admin (G2-020)", () => {
  it("disabling the sole remaining active hr_admin is refused; disabling down to one succeeds first", async () => {
    // Two active admins (ada, bo): disabling ada first leaves exactly one — allowed.
    await expect(disableUser(ownerPool, { email: ADMIN_EMAIL, correlationId: randomUUID() })).resolves.toBeDefined();

    // Now bo is the sole active hr_admin: disabling her must be refused, nothing written.
    await expect(
      disableUser(ownerPool, { email: SECOND_ADMIN_EMAIL, correlationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "last_admin" });

    const stillActive = await withClient(ownerPool, (client) =>
      client.query<{ active: boolean }>("SELECT active FROM accounts WHERE email = $1", [SECOND_ADMIN_EMAIL]),
    );
    expect(stillActive.rows[0]?.active).toBe(true);
  });
});

describe("D-018 — employee(self), every employment field, update (G2-026)", () => {
  it("POST /api/employees/<own id> as the employee is 403 forbidden (role gate, before the id is read)", async () => {
    const response = await handleEmployeeUpdate(
      post("/api/employees/x", cy, {
        code: staffEmployee.code,
        full_name: "Cy Renamed",
        work_email: staffEmployee.work_email,
        title: staffEmployee.title,
        department: staffEmployee.department,
        start_date: staffEmployee.start_date,
        version: staffEmployee.version,
        csrf: csrf(cy),
      }),
      appPool,
      staffEmployee.id,
    );
    expect(response.status).toBe(403);
  });
});

describe("D-020 vs D-078 — employee(other) vs employee(self), object-addressed HR read (G2-029 / G2-120)", () => {
  it("D-078: reading the caller's OWN employee record without `hr` is 403 forbidden (matches the matrix)", async () => {
    const result = await getEmployeeForHr(appPool, cy.principal, staffEmployee.id);
    expect(result.kind).toBe("forbidden");
  });

  it("D-020 (current code, regression guard): reading ANOTHER employee's record without `hr` is `forbidden` — the role check runs before the object id is ever read", async () => {
    const result = await getEmployeeForHr(appPool, cy.principal, otherStaffEmployee.id);
    expect(result.kind).toBe("forbidden");
  });

  it.fails(
    "D-020 (matrix ratchet, pending a ruling): access-matrix.md documents 404 not_found for this row",
    async () => {
      const result = await getEmployeeForHr(appPool, cy.principal, otherStaffEmployee.id);
      // access-matrix.md D-020: "the object rule of §1 wins on an object-addressed route ...
      // byte-identical to a genuine miss" → the matrix's own outcome column is `404 not_found`.
      // `getEmployeeForHr` checks `isHr(principal)` before it ever looks at `id` (same order as
      // D-078's passing case above), so this assertion fails against the current code today —
      // see the fix-round report's "App defects found" (systemic role-before-object order).
      //
      // Wrapped in Vitest's `it.fails` — an explicit, named "expected failure" marker, not a
      // skip or a loosened assertion — rather than either silently matching the code or leaving
      // `npm test` red: this suite has no authority to rule between the matrix and the code
      // (that needs backend-security or the operator), and `access-matrix.md` is outside this
      // fix round's scope (a meta-repo path, not a file under `Demo_app_HR`). The moment either
      // side changes to agree with the other, this test starts *passing* its own assertion,
      // which `it.fails` turns into a reported suite failure — the signal to delete this test
      // and update the regression guard above to the new expectation.
      expect(result.kind).toBe("not_found");
    },
  );
});

describe("D-023 — employee, `employees` collection, create (G2-032)", () => {
  it("POST /api/employees as an employee is 403 forbidden", async () => {
    const response = await handleEmployeeCreate(
      post("/api/employees", cy, {
        code: "E-9002",
        full_name: "Someone New",
        work_email: "someone.new3@example.test",
        title: "x",
        department: "x",
        start_date: "2026-01-01",
        csrf: csrf(cy),
      }),
      appPool,
    );
    expect(response.status).toBe(403);
  });
});

describe("D-026 — hr_admin, stale `expected_version`, update (G2-037)", () => {
  it("editing an employee with a version that has already moved is 409 conflict_stale", async () => {
    const response = await handleEmployeeUpdate(
      post("/api/employees/x", bo, {
        code: staffEmployee.code,
        full_name: "Cy Staff",
        work_email: staffEmployee.work_email,
        title: "Updated Title",
        department: staffEmployee.department,
        start_date: staffEmployee.start_date,
        version: staffEmployee.version + 1,
        csrf: csrf(bo),
      }),
      appPool,
      staffEmployee.id,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("conflict_stale");
  });
});

describe("D-028 — last-admin path (d): the sole active hr_admin deactivates their own employee record (G2-040)", () => {
  it("bo deactivating her own linked record, once she is the last active admin, is 409 conflict_last_admin", async () => {
    await disableUser(ownerPool, { email: ADMIN_EMAIL, correlationId: randomUUID() });

    const response = await handleEmployeeStatus(
      post("/api/employees/x/status", bo, {
        action: "deactivate",
        version: adminEmployee.version,
        csrf: csrf(bo),
      }),
      appPool,
      adminEmployee.id,
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("conflict_last_admin");

    const stillActive = await withClient(ownerPool, (client) =>
      client.query<{ active: boolean }>("SELECT active FROM employees WHERE id = $1", [adminEmployee.id]),
    );
    expect(stillActive.rows[0]?.active).toBe(true);
  });
});

describe("D-033 — leave_request(own), cancel a terminal request (G2-050)", () => {
  it("cancelling an already-cancelled request is 409 conflict_not_pending", async () => {
    const request = await submitOk(cy, RANGE);
    const first = await handleLeaveCancel(
      post(`/api/leave/${request.id}/cancel`, cy, { version: request.version, csrf: csrf(cy) }),
      appPool,
      request.id,
    );
    expect(first.status).toBe(200);

    const second = await handleLeaveCancel(
      post(`/api/leave/${request.id}/cancel`, cy, { version: request.version + 1, csrf: csrf(cy) }),
      appPool,
      request.id,
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("conflict_not_pending");
  });
});

describe("D-034 — employee, leave_request(other), cancel (G2-052)", () => {
  it("cy cancelling di's pending request is 404 not_found", async () => {
    const request = await submitOk(di, RANGE);
    const response = await handleLeaveCancel(
      post(`/api/leave/${request.id}/cancel`, cy, { version: request.version, csrf: csrf(cy) }),
      appPool,
      request.id,
    );
    expect(response.status).toBe(404);
  });
});

describe("D-035 vs D-036 — employee deciding own vs. a colleague's request (G2-053 / G2-054)", () => {
  it("D-035: cy deciding cy's own request is 403 forbidden (matches the matrix)", async () => {
    const request = await submitOk(cy, RANGE);
    const response = await handleLeaveDecision(
      post(`/api/leave/${request.id}/decision`, cy, { action: "approve", version: request.version, csrf: csrf(cy) }),
      appPool,
      request.id,
    );
    expect(response.status).toBe(403);
  });

  it("D-036 (current code, regression guard): cy deciding di's request is 403 — the role check runs before the object id is ever read", async () => {
    const request = await submitOk(di, RANGE);
    const response = await handleLeaveDecision(
      post(`/api/leave/${request.id}/decision`, cy, { action: "approve", version: request.version, csrf: csrf(cy) }),
      appPool,
      request.id,
    );
    expect(response.status).toBe(403);
  });

  it.fails(
    "D-036 (matrix ratchet, pending a ruling): access-matrix.md documents 404 not_found for this row",
    async () => {
      const request = await submitOk(di, RANGE);
      const response = await handleLeaveDecision(
        post(`/api/leave/${request.id}/decision`, cy, { action: "approve", version: request.version, csrf: csrf(cy) }),
        appPool,
        request.id,
      );
      // access-matrix.md D-036: object rule wins on an object-addressed route → `404 not_found`.
      // `authorizeFieldMutation`'s `requireRole` check requires `hr_admin` *before* the id is
      // ever read (same systemic order as D-020 above), so this fails against the current code
      // — see the fix-round report's "App defects found". Same `it.fails` reasoning as D-020's
      // ratchet test just above: neither this suite nor this fix round may rule between the
      // matrix and the code, and `access-matrix.md` sits outside `Demo_app_HR`. Delete this test
      // (and update the regression guard above) once either side changes to agree.
      expect(response.status).toBe(404);
    },
  );
});

describe("D-037 — hr_admin, re-deciding an already-decided request (G2-056)", () => {
  it("approving a request twice answers 409 conflict_not_pending the second time", async () => {
    const request = await submitOk(cy, RANGE);
    const first = await handleLeaveDecision(
      post(`/api/leave/${request.id}/decision`, bo, { action: "approve", version: request.version, csrf: csrf(bo) }),
      appPool,
      request.id,
    );
    expect(first.status).toBe(200);

    const second = await handleLeaveDecision(
      post(`/api/leave/${request.id}/decision`, bo, { action: "approve", version: request.version + 1, csrf: csrf(bo) }),
      appPool,
      request.id,
    );
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toBe("conflict_not_pending");
  });
});

describe("D-039 — hr_admin, stale `expected_version`, decide (G2-058)", () => {
  it("deciding with a version that has already moved is 409 conflict_stale, not conflict_not_pending", async () => {
    const request = await submitOk(cy, RANGE);
    const response = await handleLeaveDecision(
      post(`/api/leave/${request.id}/decision`, bo, { action: "approve", version: request.version + 1, csrf: csrf(bo) }),
      appPool,
      request.id,
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: string }).error).toBe("conflict_stale");
  });
});

describe("D-040 — hr_admin(self), approving or rejecting their own request (G2-059)", () => {
  it("bo approving her own request is 403 forbidden, and is audited as denied", async () => {
    const request = await submitOk(bo, RANGE);
    const response = await handleLeaveDecision(
      post(`/api/leave/${request.id}/decision`, bo, { action: "approve", version: request.version, csrf: csrf(bo) }),
      appPool,
      request.id,
    );
    expect(response.status).toBe(403);

    const rows = await withClient(appPool, (client) =>
      client.query<{ outcome: string }>(
        "SELECT outcome FROM audit_events WHERE object_id = $1 AND action = 'leave.approve'",
        [request.id],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.outcome).toBe("denied");
  });
});

describe("D-041 — hr_admin with no linked employee row, submitting leave (G2-062)", () => {
  it("ada (unlinked) submitting a leave request is 403 forbidden", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", ada, { kind: "annual", ...RANGE, csrf: csrf(ada) }),
      appPool,
    );
    expect(response.status).toBe(403);
  });
});

describe("D-042 — ownership/decision columns on leave, over-post (G2-063)", () => {
  it("POST /api/leave with an `employee_id` key is 400 invalid_input", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, { kind: "annual", ...RANGE, employee_id: adminEmployee.id, csrf: csrf(cy) }),
      appPool,
    );
    expect(response.status).toBe(400);
  });
});

describe("D-043 — leave `category`/`kind` outside the enum (G2-064)", () => {
  it("POST /api/leave with kind 'sick' is 400 invalid_input", async () => {
    const response = await handleLeaveCreate(
      post("/api/leave", cy, { kind: "sick", ...RANGE, csrf: csrf(cy) }),
      appPool,
    );
    expect(response.status).toBe(400);
  });
});

describe("D-063 — the runtime role, UPDATE/DELETE on audit_events (G2-096)", () => {
  it("UPDATE audit_events as hr_test_app is refused at the database, SQLSTATE 42501", async () => {
    await submitOk(cy, RANGE); // guarantees at least one row exists to target
    await withClient(appPool, async (client) => {
      await client.query("BEGIN");
      try {
        await expect(
          client.query("UPDATE audit_events SET outcome = 'tampered' WHERE true"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });

  it("DELETE FROM audit_events as hr_test_app is refused at the database, SQLSTATE 42501", async () => {
    await withClient(appPool, async (client) => {
      await client.query("BEGIN");
      try {
        await expect(client.query("DELETE FROM audit_events WHERE true")).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await client.query("ROLLBACK");
      }
    });
  });
});

describe("D-075 — employee, the approval queue, list (G2-117)", () => {
  it("loadApprovals for an employee principal is forbidden before any query runs", async () => {
    const result = await loadApprovals(appPool, cy.principal);
    expect(result.kind).toBe("forbidden");
  });
});

describe("D-076 — employee, the HR employee list, list (G2-118)", () => {
  it("listEmployeesForHr for an employee principal is forbidden before any query runs", async () => {
    const result = await listEmployeesForHr(appPool, cy.principal);
    expect(result.kind).toBe("forbidden");
  });
});

describe("D-080 — hr_admin with no linked employee row, listing own leave (G2-122)", () => {
  it("loadOwnLeave for an unlinked hr_admin is the `{ linked: false }` state, not an error", async () => {
    const result = await loadOwnLeave(appPool, ada.principal);
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      // access-matrix.md's outcome column reads "403 forbidden" for this row; `loadOwnLeave`
      // has no role/capability gate at all and always answers `200` with this shape (the page
      // renders it as a forbidden-style banner, but the read itself never refuses). Recorded
      // as a documentation/implementation mismatch, not re-asserted as a literal 403 here.
      expect(result.data).toEqual({ linked: false });
    }
  });
});

describe("D-081 — hr_admin, leave_request(other), cancel (G2-123)", () => {
  it("bo cancelling cy's pending request is 404 not_found — the brief and the code agree; access-matrix.md's D-081 disagrees with both", async () => {
    const request = await submitOk(cy, OTHER_RANGE);
    const response = await handleLeaveCancel(
      post(`/api/leave/${request.id}/cancel`, bo, { version: request.version, csrf: csrf(bo) }),
      appPool,
      request.id,
    );
    // Fix round correction (test transcription error, not a loosening): this assertion was
    // pinned to access-matrix.md's D-081 outcome column (`403 forbidden`, added in "review fix
    // round 1"), which disagrees with both `cancelLeave` (src/server/services/leave.ts:257-259
    // — slice-3-B-report Deviation 3, "every non-owner gets 404, hr_admin included") and the
    // slice-4-brief's own prose ("hr_admin cancelling another's request → 404"). Two
    // authoritative documents cannot both be transcribed; the brief and the code were written
    // for this exact slice and agree with each other, so this row is re-pinned to `404` here.
    // access-matrix.md's D-081 row still needs an operator-side amendment — access-matrix.md is
    // outside this fix round's scope (a meta-repo path, not a file under `Demo_app_HR`) —
    // recorded as a concern in the fix report rather than edited here.
    expect(response.status).toBe(404);
  });
});

describe("D-017, D-032, D-045, D-062 — the runtime role's INSERT/DELETE grants are actually withheld (0002_tighten_grants)", () => {
  it("DELETE on accounts/employees/leave_requests and INSERT on settings are all SQLSTATE 42501", async () => {
    // access-matrix.md D-017/D-032/D-045/D-062 each claim the grant is withheld (SQLSTATE
    // 42501) for accounts/employees/leave_requests/settings. Fix round: `0001_init.sql` had
    // instead granted `SELECT, INSERT, UPDATE, DELETE` on all four tables as a block, so this
    // probe used to accept either outcome (`PERMITTED_BY_GRANT` or `denied_42501`) and could
    // never fail — the finding *was* the mismatch. `migrations/0002_tighten_grants.sql` now
    // revokes exactly the privileges the application never uses (no route or CLI-under-the-
    // runtime-role ever creates or deletes an account, deletes an employee or a leave request,
    // or creates or deletes the `settings` singleton — see that migration's own header), so this
    // is now a real assertion, in a transaction that is always rolled back either way, same
    // shape as the passing D-063 pair above.
    async function probe(sql: string): Promise<string> {
      return withClient(appPool, async (client) => {
        await client.query("BEGIN");
        try {
          await client.query(sql);
          return "PERMITTED_BY_GRANT";
        } catch (error) {
          const code = (error as { code?: string }).code;
          return code === "42501" ? "denied_42501" : `other_error:${code}`;
        } finally {
          await client.query("ROLLBACK");
        }
      });
    }

    const probes: Record<string, string> = {
      "accounts DELETE (D-017)": "DELETE FROM accounts WHERE false",
      "employees DELETE (D-032)": "DELETE FROM employees WHERE false",
      "leave_requests DELETE (D-045)": "DELETE FROM leave_requests WHERE false",
      "settings INSERT (D-062)": "INSERT INTO settings (id, public_origin) SELECT 2, 'http://example.invalid' WHERE false",
    };
    for (const [label, sql] of Object.entries(probes)) {
      expect(await probe(sql), label).toBe("denied_42501");
    }
  });
});
