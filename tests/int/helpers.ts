import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

import { loadDbConfig, type DbConfig } from "../../src/server/config/env.js";

/**
 * Integration tests run against the `hr_test` database on the shared dev server, with both
 * roles in one process. The two credential files are written by the meta-repo tool and are
 * git-ignored; they are parsed here and never printed.
 */
export const OWNER_ENV_FILE = ".env.test.owner.local";
export const APP_ENV_FILE = ".env.test.local";

export function testConfig(file: string): DbConfig {
  const absolute = resolve(process.cwd(), file);
  if (!existsSync(absolute)) {
    const role = file === OWNER_ENV_FILE ? " --role owner" : "";
    throw new Error(
      `${file} is missing. From the meta-repo root run: _tools/pgsql/pg env hr_test${role} --server localhost:5432 --write Demo_app_HR/${file}`,
    );
  }
  const parsed = parseEnv(readFileSync(absolute, "utf8")) as Record<string, string | undefined>;
  return loadDbConfig(parsed);
}

/** Every table 0001 creates, in an order that is safe to drop. */
export const DROP_ALL_TABLES =
  "DROP TABLE IF EXISTS leave_requests, employees, sessions, audit_events, settings, accounts, schema_migrations CASCADE";
