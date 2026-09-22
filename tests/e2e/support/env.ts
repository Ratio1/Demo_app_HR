/**
 * Shared constants for the slice 4 Playwright suite (journey.spec.ts, a11y.spec.ts,
 * global-setup.ts, global-teardown.ts). One file so a port or a container-name prefix cannot
 * drift between them.
 *
 * Ruling R-O: the operator's live container owns `127.0.0.1:3001` and database `hr` — never
 * touched here. Every e2e container is named `demo-hr-e2e*` and binds `127.0.0.1:3101` only,
 * against `hr_test`.
 */
import path from "node:path";

/**
 * `Demo_app_HR/`, resolved from this file's own location, never assumed from `cwd()`.
 * `__dirname`, not `import.meta.url`: Playwright's config/test loader transpiles this package
 * (no `"type": "module"`) to CommonJS, where `import.meta` is unavailable.
 */
export const APP_ROOT = path.resolve(__dirname, "../../..");

/** The meta-repo root, one level above the submodule — for the shared `pg` tool only. */
export const META_ROOT = path.resolve(APP_ROOT, "..");

/** Overridable so a future layout change is additive, not a rewrite (advisor note). */
export const PG_TOOL = process.env.HR_PG_TOOL ?? path.join(META_ROOT, "_tools/pgsql/pg");

export const E2E_HOST = "127.0.0.1";
export const E2E_PORT = 3101;
export const BASE_URL = `http://${E2E_HOST}:${E2E_PORT}`;

export const IMAGE_TAG = "demo-hr:e2e";
export const SERVER_CONTAINER = "demo-hr-e2e";
export const CONTAINER_PREFIX = "demo-hr-e2e";

export const APP_ENV_FILE = path.join(APP_ROOT, ".env.e2e.local");
export const OWNER_ENV_FILE = path.join(APP_ROOT, ".env.e2e.owner.local");
export const CA_CERT = path.join(APP_ROOT, "certs/dev-ca.crt");

/** Set by global-setup; read by every test file and by global-teardown. */
export const SECRET_DIR_ENV = "HR_E2E_SECRET_DIR";

export const ADMIN1_EMAIL = "ada.first@example.test";
export const ADMIN2_EMAIL = "bo.second@example.test";
export const EMPLOYEE_EMAIL = "cy.staff@example.test";

export const ADMIN2_EMPLOYEE_CODE = "E-2001";
export const EMPLOYEE_EMPLOYEE_CODE = "E-2002";

export const ADMIN1_PASSWORD_FILE = "admin1.pw";
export const ADMIN2_PASSWORD_FILE = "admin2.pw";
export const EMPLOYEE_PASSWORD_FILE = "employee.pw";

export function secretDir(): string {
  const dir = process.env[SECRET_DIR_ENV];
  if (dir === undefined || dir === "") {
    throw new Error(
      `${SECRET_DIR_ENV} is not set — this file must run under global-setup.ts's Playwright config`,
    );
  }
  return dir;
}
