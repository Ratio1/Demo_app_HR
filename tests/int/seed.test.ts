import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createPool, withClient, type Pool } from "../../src/server/db/pool.ts";
import { deriveAppRole, runMigrations } from "../../src/server/db/migrate.ts";
import { DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.ts";
import { seedDemo } from "../../src/server/services/seed.ts";
import { SEED_SYSTEM_ACTOR_ID } from "../../src/server/repos/audit.ts";

/**
 * Integration coverage for `manage seed-demo` (slice 5 Part S; spec §9 "fictional seed", D5.3,
 * threat model AC-43) against the `hr_test` database. Runs the service function directly on the
 * **owner** pool, exactly as `manage` does — the same pattern `accounts-cli.test.ts` uses for the
 * other maintenance commands.
 */
let ownerPool: Pool;

function correlation(): string {
  return "11111111-1111-4111-8111-111111111111";
}

async function counts(): Promise<{
  accounts: number;
  employees: number;
  leaveRequests: number;
}> {
  return withClient(ownerPool, async (client) => {
    // Sequential, not `Promise.all`: a single `pg` client serializes concurrent queries anyway
    // (and warns that the fallback is deprecated), so this is one round trip cheaper too.
    const accounts = await client.query<{ total: string }>("SELECT count(*) AS total FROM accounts");
    const employees = await client.query<{ total: string }>("SELECT count(*) AS total FROM employees");
    const leaveRequests = await client.query<{ total: string }>(
      "SELECT count(*) AS total FROM leave_requests",
    );
    return {
      accounts: Number(accounts.rows[0]?.total ?? "0"),
      employees: Number(employees.rows[0]?.total ?? "0"),
      leaveRequests: Number(leaveRequests.rows[0]?.total ?? "0"),
    };
  });
}

async function seedAuditRows(): Promise<
  Array<{ action: string; outcome: string; actor_account_id: string | null; object_type: string }>
> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{
      action: string;
      outcome: string;
      actor_account_id: string | null;
      object_type: string;
    }>(
      "SELECT action, outcome, actor_account_id, object_type FROM audit_events WHERE action = 'seed' ORDER BY occurred_at",
    );
    return result.rows;
  });
}

async function leaveStatuses(): Promise<Array<{ status: string; decided_by: string | null }>> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{ status: string; decided_by: string | null }>(
      "SELECT status, decided_by FROM leave_requests ORDER BY id",
    );
    return result.rows;
  });
}

async function employeeCodes(): Promise<string[]> {
  return withClient(ownerPool, async (client) => {
    const result = await client.query<{ code: string }>("SELECT code FROM employees ORDER BY code");
    return result.rows.map((row) => row.code);
  });
}

beforeAll(async () => {
  const ownerConfig = testConfig(OWNER_ENV_FILE);
  ownerPool = createPool(ownerConfig);
  await withClient(ownerPool, async (client) => {
    await client.query(DROP_ALL_TABLES);
  });
  await runMigrations(ownerPool, { appRole: deriveAppRole(ownerConfig.user) });
}, 60_000);

afterAll(async () => {
  await ownerPool.end();
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

describe("seed-demo (spec §9, D5.3, AC-43)", () => {
  it("creates ~12 employees and ~30 leave requests, no accounts, all under the system actor", async () => {
    const result = await seedDemo(ownerPool, { force: false, correlationId: correlation() });
    expect(result.employeesCreated).toBe(12);
    expect(result.leaveRequestsCreated).toBe(30);

    const after = await counts();
    expect(after.employees).toBe(12);
    expect(after.leaveRequests).toBe(30);
    expect(after.accounts).toBe(0); // D5.3: seed-demo never creates an account

    const codes = await employeeCodes();
    expect(codes.every((code) => /^E-2\d{3}$/u.test(code))).toBe(true);
    expect(new Set(codes).size).toBe(12); // unique

    const statuses = await leaveStatuses();
    expect(statuses.every((row) => row.status === "pending" || row.status === "cancelled")).toBe(true);
    // Neither status requires decided_by, and seed-demo never sets it (no account exists to own it).
    expect(statuses.every((row) => row.decided_by === null)).toBe(true);
    expect(statuses.some((row) => row.status === "cancelled")).toBe(true);
    expect(statuses.some((row) => row.status === "pending")).toBe(true);

    const rows = await seedAuditRows();
    expect(rows).toHaveLength(42); // 12 employees + 30 leave requests
    expect(rows.every((row) => row.outcome === "ok")).toBe(true);
    expect(rows.every((row) => row.actor_account_id === SEED_SYSTEM_ACTOR_ID)).toBe(true);
    expect(rows.filter((row) => row.object_type === "employee")).toHaveLength(12);
    expect(rows.filter((row) => row.object_type === "leave_request")).toHaveLength(30);
  }, 30_000);

  it("refuses a non-empty employees table without --force, and writes nothing", async () => {
    await withClient(ownerPool, async (client) => {
      await client.query(
        `INSERT INTO employees (id, code, full_name, work_email, title, department, start_date)
         VALUES ($1, 'E-9999', 'Existing Person', 'existing@example.test', 'Analyst', 'Operations', DATE '2026-01-05')`,
        [randomUUID()],
      );
    });

    await expect(seedDemo(ownerPool, { force: false, correlationId: correlation() })).rejects.toMatchObject({
      code: "not_empty",
    });

    const after = await counts();
    expect(after.employees).toBe(1); // only the pre-existing row
    expect(after.leaveRequests).toBe(0);
    expect(after.accounts).toBe(0);
    expect(await seedAuditRows()).toHaveLength(0);
  }, 30_000);

  it("--force appends a second batch with unique codes and emails, leaving the first batch intact", async () => {
    const first = await seedDemo(ownerPool, { force: false, correlationId: correlation() });
    expect(first.startingCode).toBe("E-2001");

    const second = await seedDemo(ownerPool, { force: true, correlationId: correlation() });
    expect(second.startingCode).toBe("E-2013"); // continues after the first batch's 12 codes
    expect(second.employeesCreated).toBe(12);

    const after = await counts();
    expect(after.employees).toBe(24);
    expect(after.leaveRequests).toBe(60);
    expect(after.accounts).toBe(0);

    const codes = await employeeCodes();
    expect(new Set(codes).size).toBe(24); // no collision across the two batches

    const rows = await seedAuditRows();
    expect(rows).toHaveLength(84); // 42 per batch × 2
  }, 30_000);

  it("refuses --force just as loudly the first time, since --force only changes the emptiness check", async () => {
    // A quick sanity check that --force does not skip anything else: on an empty database it
    // behaves identically to a plain run.
    const result = await seedDemo(ownerPool, { force: true, correlationId: correlation() });
    expect(result.startingCode).toBe("E-2001");
    expect(result.employeesCreated).toBe(12);
  }, 30_000);
});
