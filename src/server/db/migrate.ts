/**
 * The migration runner behind `manage migrate`.
 *
 * Numbered `.sql` files under `migrations/` are applied in order, each inside one
 * transaction, and journalled in `schema_migrations`. A second run applies nothing. The
 * runner is the only place that knows the runtime role name: it derives it from DB_USER
 * (…_owner → …_app) and substitutes it into the grant statements, so no migration file
 * carries a literal role name and the same file works for `hr` and `hr_test`.
 *
 * There is no lock table and no advisory lock: migrations are a single-operator step run
 * once outside serving (spec §4).
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";

import { withClient } from "./pool.js";

export const MIGRATIONS_DIR = "migrations";
export const APP_ROLE_PLACEHOLDER = "{{APP_ROLE}}";

const MIGRATION_FILE_PATTERN = /^([0-9]{4})_[a-z0-9_]+\.sql$/;
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

const OWNER_SUFFIX = "_owner";
const APP_SUFFIX = "_app";

/** Tables 0001 creates; the postcondition of a complete migration run. */
export const EXPECTED_TABLES = [
  "accounts",
  "audit_events",
  "employees",
  "leave_requests",
  "schema_migrations",
  "sessions",
  "settings",
] as const;

/** What the runtime role must hold once every migration has been applied. */
export const EXPECTED_GRANTS: Readonly<Record<string, readonly string[]>> = {
  accounts: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  audit_events: ["INSERT", "SELECT"],
  employees: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  leave_requests: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  schema_migrations: ["SELECT"],
  sessions: ["DELETE", "INSERT", "SELECT", "UPDATE"],
  settings: ["DELETE", "INSERT", "SELECT", "UPDATE"],
};

export interface MigrationFile {
  readonly id: string;
  readonly fileName: string;
  readonly sql: string;
}

export interface MigrationRunResult {
  readonly appRole: string;
  readonly applied: readonly string[];
  readonly alreadyApplied: readonly string[];
}

export interface SchemaReport {
  readonly ok: boolean;
  readonly missingTables: readonly string[];
  readonly missingGrants: readonly string[];
  readonly unexpectedGrants: readonly string[];
}

export class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MigrationError";
  }
}

/** Double-quoted identifier, after proving it cannot carry SQL of its own. */
export function quoteIdentifier(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) {
    throw new MigrationError(
      "refusing to build SQL with an unsafe identifier: expected lowercase letters, digits and underscores",
    );
  }
  return `"${name}"`;
}

/**
 * The runtime role that serves the application, derived from the maintenance role that runs
 * migrations. Refuses anything else so a migration cannot be run with the runtime role and
 * silently grant that role to itself.
 */
export function deriveAppRole(dbUser: string): string {
  if (!dbUser.endsWith(OWNER_SUFFIX) || dbUser.length === OWNER_SUFFIX.length) {
    throw new MigrationError(
      "migrations must run as the maintenance role: DB_USER has to end in '_owner' so the runtime '_app' role can be derived from it",
    );
  }
  const appRole = `${dbUser.slice(0, -OWNER_SUFFIX.length)}${APP_SUFFIX}`;
  if (!SAFE_IDENTIFIER.test(appRole)) {
    throw new MigrationError(
      "the runtime role derived from DB_USER is not a plain identifier (lowercase letters, digits and underscores)",
    );
  }
  return appRole;
}

export function listMigrationFiles(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  const absolute = resolve(process.cwd(), dir);
  let entries: string[];
  try {
    entries = readdirSync(absolute);
  } catch {
    throw new MigrationError(`no migrations directory at ${absolute}`);
  }

  const files = entries
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  const seen = new Set<string>();
  return files.map((fileName) => {
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (match === null) {
      throw new MigrationError(
        `migration file name '${fileName}' is not of the form 0001_snake_case.sql`,
      );
    }
    const number = match[1] as string;
    if (seen.has(number)) {
      throw new MigrationError(`two migrations share the number ${number}`);
    }
    seen.add(number);
    return {
      id: fileName.slice(0, -".sql".length),
      fileName,
      sql: readFileSync(resolve(absolute, fileName), "utf8"),
    };
  });
}

async function journalExists(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ one: number }>(
    `SELECT 1 AS one FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`,
  );
  return result.rowCount === 1;
}

async function journalledIds(client: PoolClient): Promise<Set<string>> {
  if (!(await journalExists(client))) {
    return new Set<string>();
  }
  const result = await client.query<{ id: string }>("SELECT id FROM schema_migrations");
  return new Set(result.rows.map((row) => row.id));
}

export interface RunMigrationsOptions {
  readonly appRole: string;
  readonly dir?: string;
  readonly log?: (line: string) => void;
}

/**
 * Applies every migration the journal does not already list. Each file runs in its own
 * transaction together with its journal row, and the row is read back afterwards, so a
 * half-applied migration can never be recorded as done.
 */
export async function runMigrations(
  pool: Pool,
  options: RunMigrationsOptions,
): Promise<MigrationRunResult> {
  const quotedRole = quoteIdentifier(options.appRole);
  const log = options.log ?? (() => {});
  const files = listMigrationFiles(options.dir);
  if (files.length === 0) {
    throw new MigrationError("no migration files found");
  }

  return withClient(pool, async (client) => {
    const done = await journalledIds(client);
    const applied: string[] = [];
    const alreadyApplied: string[] = [];

    for (const file of files) {
      if (done.has(file.id)) {
        alreadyApplied.push(file.id);
        log(`already applied ${file.id}`);
        continue;
      }

      const sql = file.sql.replaceAll(APP_ROLE_PLACEHOLDER, quotedRole);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, now())", [
          file.id,
        ]);
        await client.query("COMMIT");
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // The connection is unusable; the error below is the one that matters.
        }
        throw new MigrationError(`migration ${file.id} failed and was rolled back`, {
          cause: error,
        });
      }

      const check = await client.query<{ id: string }>(
        "SELECT id FROM schema_migrations WHERE id = $1",
        [file.id],
      );
      if (check.rowCount !== 1) {
        throw new MigrationError(
          `migration ${file.id} reported success but is not journalled: refusing to continue`,
        );
      }
      applied.push(file.id);
      log(`applied ${file.id}`);
    }

    return { appRole: options.appRole, applied, alreadyApplied };
  });
}

/**
 * Postcondition of a complete run: every table exists and the runtime role holds exactly the
 * privileges the migrations granted - in particular INSERT and SELECT, but never UPDATE or
 * DELETE, on `audit_events` (S7).
 */
export async function verifySchema(pool: Pool, appRole: string): Promise<SchemaReport> {
  return withClient(pool, async (client) => {
    const tables = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`,
    );
    const found = new Set(tables.rows.map((row) => row.table_name));
    const missingTables = EXPECTED_TABLES.filter((name) => !found.has(name));

    const grants = await client.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE grantee = $1 AND table_schema = current_schema()`,
      [appRole],
    );

    const held = new Map<string, Set<string>>();
    for (const row of grants.rows) {
      const set = held.get(row.table_name) ?? new Set<string>();
      set.add(row.privilege_type);
      held.set(row.table_name, set);
    }

    const missingGrants: string[] = [];
    const unexpectedGrants: string[] = [];
    for (const [table, expected] of Object.entries(EXPECTED_GRANTS)) {
      const actual = held.get(table) ?? new Set<string>();
      for (const privilege of expected) {
        if (!actual.has(privilege)) {
          missingGrants.push(`${table}.${privilege}`);
        }
      }
      for (const privilege of actual) {
        if (!expected.includes(privilege)) {
          unexpectedGrants.push(`${table}.${privilege}`);
        }
      }
    }
    for (const [table, actual] of held) {
      if (!(table in EXPECTED_GRANTS)) {
        for (const privilege of actual) {
          unexpectedGrants.push(`${table}.${privilege}`);
        }
      }
    }

    return {
      ok: missingTables.length === 0 && missingGrants.length === 0 && unexpectedGrants.length === 0,
      missingTables,
      missingGrants: missingGrants.sort(),
      unexpectedGrants: unexpectedGrants.sort(),
    };
  });
}
