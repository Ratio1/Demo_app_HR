import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { deriveAppRole, runMigrations, verifySchema } from "../../src/server/db/migrate.js";
import { createPool, withClient } from "../../src/server/db/pool.js";
import { APP_ENV_FILE, DROP_ALL_TABLES, OWNER_ENV_FILE, testConfig } from "./helpers.js";

const INSUFFICIENT_PRIVILEGE = "42501";

const ownerConfig = testConfig(OWNER_ENV_FILE);
const appConfig = testConfig(APP_ENV_FILE);
const appRole = deriveAppRole(ownerConfig.user);

let ownerPool: ReturnType<typeof createPool>;
let appPool: ReturnType<typeof createPool>;

async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

beforeAll(async () => {
  ownerPool = createPool(ownerConfig);
  appPool = createPool(appConfig);
  // Start from an empty database so "applies from empty" means what it says.
  await withClient(ownerPool, async (client) => {
    await client.query(DROP_ALL_TABLES);
  });
});

afterAll(async () => {
  await appPool.end();
  await ownerPool.end();
});

describe("manage migrate", () => {
  it("applies 0001_init and 0002_tighten_grants to an empty database", async () => {
    const result = await runMigrations(ownerPool, { appRole });
    expect(result.applied).toEqual(["0001_init", "0002_tighten_grants"]);
    expect(result.alreadyApplied).toEqual([]);
    expect(result.appRole).toBe("hr_test_app");

    const rows = await withClient(ownerPool, async (client) =>
      (await client.query<{ id: string }>("SELECT id FROM schema_migrations ORDER BY id")).rows,
    );
    expect(rows.map((row) => row.id)).toEqual(["0001_init", "0002_tighten_grants"]);
  });

  it("verifies its postconditions: seven tables and exact grants", async () => {
    const report = await verifySchema(ownerPool, appRole);
    expect(report.missingTables).toEqual([]);
    expect(report.missingGrants).toEqual([]);
    expect(report.unexpectedGrants).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("is a no-op when run again", async () => {
    const before = await withClient(ownerPool, async (client) =>
      (await client.query<{ id: string; applied_at: Date }>("SELECT id, applied_at FROM schema_migrations ORDER BY id")).rows,
    );
    const result = await runMigrations(ownerPool, { appRole });
    expect(result.applied).toEqual([]);
    expect(result.alreadyApplied).toEqual(["0001_init", "0002_tighten_grants"]);

    const after = await withClient(ownerPool, async (client) =>
      (await client.query<{ id: string; applied_at: Date }>("SELECT id, applied_at FROM schema_migrations ORDER BY id")).rows,
    );
    expect(after).toHaveLength(2);
    expect(after[0]?.applied_at.getTime()).toBe(before[0]?.applied_at.getTime());
    expect(after[1]?.applied_at.getTime()).toBe(before[1]?.applied_at.getTime());
  });

  it("grants the runtime role exactly the tightened privilege set, table by table (0002_tighten_grants)", async () => {
    const rows = await withClient(ownerPool, async (client) =>
      (
        await client.query<{ table_name: string; privilege_type: string }>(
          `SELECT table_name, privilege_type FROM information_schema.role_table_grants
            WHERE grantee = $1 AND table_schema = current_schema()
            ORDER BY table_name, privilege_type`,
          [appRole],
        )
      ).rows,
    );
    const held = (table: string) =>
      rows.filter((row) => row.table_name === table).map((row) => row.privilege_type);

    expect(held("audit_events")).toEqual(["INSERT", "SELECT"]);
    expect(held("schema_migrations")).toEqual(["SELECT"]);
    expect(held("accounts")).toEqual(["SELECT", "UPDATE"]);
    expect(held("settings")).toEqual(["SELECT", "UPDATE"]);
    for (const table of ["employees", "leave_requests"]) {
      expect(held(table)).toEqual(["INSERT", "SELECT", "UPDATE"]);
    }
    expect(held("sessions")).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);
  });
});

describe("the runtime role in practice", () => {
  const auditId = randomUUID();

  it("can append an audit row and read it back", async () => {
    await withClient(appPool, async (client) => {
      await client.query(
        `INSERT INTO audit_events (id, actor_account_id, object_type, object_id, action, outcome, correlation_id)
         VALUES ($1, NULL, 'account', NULL, 'test.append', 'ok', $2)`,
        [auditId, randomUUID()],
      );
      const found = await client.query<{ id: string }>("SELECT id FROM audit_events WHERE id = $1", [
        auditId,
      ]);
      expect(found.rowCount).toBe(1);
    });
  });

  it("cannot change or remove an audit row (S7)", async () => {
    await withClient(appPool, async (client) => {
      expect(
        await sqlstateOf(() =>
          client.query("UPDATE audit_events SET outcome = 'tampered' WHERE id = $1", [auditId]),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlstateOf(() => client.query("DELETE FROM audit_events WHERE id = $1", [auditId])),
      ).toBe(INSUFFICIENT_PRIVILEGE);
    });

    // The row is still there, unchanged: the refusals above were the only effect.
    const rows = await withClient(ownerPool, async (client) =>
      (
        await client.query<{ outcome: string }>("SELECT outcome FROM audit_events WHERE id = $1", [
          auditId,
        ])
      ).rows,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe("ok");
  });

  it("cannot write the migration journal but can read it", async () => {
    await withClient(appPool, async (client) => {
      expect(
        await sqlstateOf(() =>
          client.query("INSERT INTO schema_migrations (id) VALUES ('9999_forged')"),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(
        await sqlstateOf(() => client.query("DELETE FROM schema_migrations WHERE id = '0001_init'")),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      const journal = await client.query<{ id: string }>(
        "SELECT id FROM schema_migrations ORDER BY id",
      );
      expect(journal.rows.map((row) => row.id)).toEqual(["0001_init", "0002_tighten_grants"]);
    });
  });

  it("can read and update accounts, the business table it actually writes at runtime (the control for the refusals above)", async () => {
    // `0002_tighten_grants` (fix round) revoked INSERT/DELETE on `accounts` from the runtime
    // role — see that migration's own header — so this control now provisions and cleans up
    // through the owner pool and only exercises the runtime role's own SELECT/UPDATE, which is
    // everything a live request ever does to this table (a session's own account is read and
    // its failed-login counters, lockout, password hash and `active` flag are updated; the
    // account row itself is CLI-provisioned).
    const accountId = randomUUID();
    await withClient(ownerPool, async (client) => {
      await client.query(
        `INSERT INTO accounts (id, email, password_hash, role)
         VALUES ($1, $2, 'not-a-real-hash', 'hr_admin')`,
        [accountId, `control.${accountId}@example.test`],
      );
    });
    try {
      await withClient(appPool, async (client) => {
        const updated = await client.query("UPDATE accounts SET active = false WHERE id = $1", [
          accountId,
        ]);
        expect(updated.rowCount).toBe(1);
        const read = await client.query<{ active: boolean }>(
          "SELECT active FROM accounts WHERE id = $1",
          [accountId],
        );
        expect(read.rows[0]?.active).toBe(false);
      });
    } finally {
      await withClient(ownerPool, async (client) => {
        await client.query("DELETE FROM accounts WHERE id = $1", [accountId]);
      });
    }
  });

  it("cannot create or delete an account, delete an employee or a leave request, or create or delete the settings row (0002_tighten_grants; access-matrix.md D-017/D-032/D-045/D-062)", async () => {
    const accountId = randomUUID();
    await withClient(appPool, async (client) => {
      expect(
        await sqlstateOf(() =>
          client.query(
            `INSERT INTO accounts (id, email, password_hash, role)
             VALUES ($1, $2, 'not-a-real-hash', 'employee')`,
            [accountId, `blocked.${accountId}@example.test`],
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);

      expect(await sqlstateOf(() => client.query("DELETE FROM accounts WHERE false"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlstateOf(() => client.query("DELETE FROM employees WHERE false"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(await sqlstateOf(() => client.query("DELETE FROM leave_requests WHERE false"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
      expect(
        await sqlstateOf(() =>
          client.query(
            "INSERT INTO settings (id, public_origin) SELECT 2, 'http://example.invalid' WHERE false",
          ),
        ),
      ).toBe(INSUFFICIENT_PRIVILEGE);
      expect(await sqlstateOf(() => client.query("DELETE FROM settings WHERE false"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });

  it("cannot create tables of its own", async () => {
    await withClient(appPool, async (client) => {
      expect(await sqlstateOf(() => client.query("CREATE TABLE app_made (id uuid PRIMARY KEY)"))).toBe(
        INSUFFICIENT_PRIVILEGE,
      );
    });
  });
});

describe("the schema keeps the contract the services rely on", () => {
  it("refuses an account email that is not lowercased", async () => {
    await withClient(ownerPool, async (client) => {
      const code = await sqlstateOf(() =>
        client.query(
          "INSERT INTO accounts (id, email, password_hash, role) VALUES ($1, 'Mixed.Case@example.test', 'h', 'hr_admin')",
          [randomUUID()],
        ),
      );
      expect(code).toBe("23514");
    });
  });

  it("refuses an unknown role, an unknown leave kind and an inverted date range", async () => {
    await withClient(ownerPool, async (client) => {
      expect(
        await sqlstateOf(() =>
          client.query(
            "INSERT INTO accounts (id, email, password_hash, role) VALUES ($1, $2, 'h', 'root')",
            [randomUUID(), `role.${randomUUID()}@example.test`],
          ),
        ),
      ).toBe("23514");

      const employeeId = randomUUID();
      await client.query(
        `INSERT INTO employees (id, code, full_name, work_email, title, department, start_date)
         VALUES ($1, $2, 'Fictional Person', $3, 'Tester', 'People', DATE '2026-01-05')`,
        [employeeId, `E-${employeeId.slice(0, 8)}`, `emp.${employeeId}@example.test`],
      );

      expect(
        await sqlstateOf(() =>
          client.query(
            `INSERT INTO leave_requests (id, employee_id, kind, start_date, end_date)
             VALUES ($1, $2, 'sabbatical', DATE '2026-04-01', DATE '2026-04-03')`,
            [randomUUID(), employeeId],
          ),
        ),
      ).toBe("23514");

      expect(
        await sqlstateOf(() =>
          client.query(
            `INSERT INTO leave_requests (id, employee_id, kind, start_date, end_date)
             VALUES ($1, $2, 'annual', DATE '2026-04-05', DATE '2026-04-01')`,
            [randomUUID(), employeeId],
          ),
        ),
      ).toBe("23514");

      await client.query("DELETE FROM employees WHERE id = $1", [employeeId]);
    });
  });

  it("keeps settings a singleton and employee-account links unique", async () => {
    await withClient(ownerPool, async (client) => {
      expect(
        await sqlstateOf(() =>
          client.query("INSERT INTO settings (id, public_origin) VALUES (2, 'https://example.test')"),
        ),
      ).toBe("23514");

      const accountId = randomUUID();
      await client.query(
        "INSERT INTO accounts (id, email, password_hash, role) VALUES ($1, $2, 'h', 'employee')",
        [accountId, `link.${accountId}@example.test`],
      );
      const first = randomUUID();
      const second = randomUUID();
      for (const id of [first, second]) {
        const code = await sqlstateOf(() =>
          client.query(
            `INSERT INTO employees (id, code, full_name, work_email, title, department, start_date, account_id)
             VALUES ($1, $2, 'Fictional Person', $3, 'Tester', 'People', DATE '2026-01-05', $4)`,
            [id, `L-${id.slice(0, 8)}`, `link.${id}@example.test`, accountId],
          ),
        );
        if (id === first) {
          expect(code).toBeUndefined();
        } else {
          expect(code).toBe("23505");
        }
      }

      await client.query("DELETE FROM employees WHERE account_id = $1", [accountId]);
      await client.query("DELETE FROM accounts WHERE id = $1", [accountId]);
    });
  });
});
