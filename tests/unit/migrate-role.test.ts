import { describe, expect, it } from "vitest";

import {
  APP_ROLE_PLACEHOLDER,
  EXPECTED_GRANTS,
  MigrationError,
  deriveAppRole,
  listMigrationFiles,
  quoteIdentifier,
} from "../../src/server/db/migrate.js";

describe("runtime role derivation", () => {
  it("turns the maintenance role into the runtime role", () => {
    expect(deriveAppRole("hr_owner")).toBe("hr_app");
    expect(deriveAppRole("hr_test_owner")).toBe("hr_test_app");
  });

  it("refuses to migrate as anything but the maintenance role", () => {
    for (const user of ["hr_app", "postgres", "owner", "_owner", "hr_owner_2"]) {
      expect(() => deriveAppRole(user)).toThrow(MigrationError);
    }
  });

  it("refuses a role name that is not a plain identifier", () => {
    for (const user of ['hr"; DROP TABLE accounts; --_owner', "hr-app_owner", "HR_owner"]) {
      expect(() => deriveAppRole(user)).toThrow(MigrationError);
    }
  });
});

describe("identifier quoting", () => {
  it("quotes a plain identifier", () => {
    expect(quoteIdentifier("hr_app")).toBe('"hr_app"');
  });

  it("refuses anything that could carry SQL", () => {
    for (const name of ['a"b', "a b", "a;b", "a-b", "Ab", "1a", "", "a".repeat(64)]) {
      expect(() => quoteIdentifier(name)).toThrow(MigrationError);
    }
  });
});

/** The executable part of a migration: line comments explain the rules and may name them. */
function statementsOf(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

describe("migration files", () => {
  it("finds 0001_init and nothing unnumbered", () => {
    const files = listMigrationFiles();
    expect(files.map((file) => file.id)).toContain("0001_init");
    expect(files.map((file) => file.id)).toEqual([...files.map((file) => file.id)].sort());
  });

  it("names no role literally and uses the placeholder for every grant", () => {
    for (const file of listMigrationFiles()) {
      const sql = statementsOf(file.sql);
      expect(sql).not.toMatch(/\b(hr|hr_test)_(app|owner)\b/);
      for (const statement of sql.split(";")) {
        if (/^\s*GRANT\b/i.test(statement)) {
          expect(statement).toContain(APP_ROLE_PLACEHOLDER);
        }
      }
    }
  });

  it("uses no vendor-only feature the portability rule forbids", () => {
    for (const file of listMigrationFiles()) {
      const sql = statementsOf(file.sql).toLowerCase();
      for (const banned of [
        "serial",
        "create extension",
        "on conflict",
        "create trigger",
        "pg_advisory",
        "row level security",
        "gen_random_uuid",
      ]) {
        expect(sql).not.toContain(banned);
      }
    }
  });

  it("grants no privilege the runtime role must not have on audit_events", () => {
    expect(EXPECTED_GRANTS["audit_events"]).toEqual(["INSERT", "SELECT"]);
    expect(EXPECTED_GRANTS["schema_migrations"]).toEqual(["SELECT"]);
  });
});
