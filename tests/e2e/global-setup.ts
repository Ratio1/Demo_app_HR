/**
 * Playwright global setup for slice 4 (playwright.config.ts). Builds (or reuses) the
 * `demo-hr:e2e` image, migrates and bootstraps `hr_test` through it, and starts the read-only,
 * capped `demo-hr-e2e` server container on `127.0.0.1:3101` — never touching the operator's
 * `demo-hr-live` container on `3001` or database `hr` (ruling R-O).
 *
 * Every credential file this writes (`.env.e2e.local`, `.env.e2e.owner.local`) is regenerated
 * on every run and deleted again by `global-teardown.ts`; nothing here reads one back. The
 * three account passwords are generated in memory, written once to 0600 files under a
 * `mkdtemp` directory, and handed to `manage.mjs` only over the pty in `support/cli.ts` —
 * never as a CLI argument, an env var value logged anywhere, or a return value.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { promisify } from "node:util";

import { createPool, withClient } from "../../src/server/db/pool.ts";
import { loadDbConfig } from "../../src/server/config/env.ts";

import { driveManageCli, runManageNonInteractive } from "./support/cli.ts";
import {
  ADMIN1_EMAIL,
  ADMIN1_PASSWORD_FILE,
  APP_ENV_FILE,
  APP_ROOT,
  BASE_URL,
  CA_CERT,
  CONTAINER_PREFIX,
  E2E_HOST,
  E2E_PORT,
  IMAGE_TAG,
  META_ROOT,
  OWNER_ENV_FILE,
  PG_TOOL,
  SECRET_DIR_ENV,
  SERVER_CONTAINER,
} from "./support/env.ts";
import { generatePassword, makeSecretDir, writeSecret } from "./support/secrets.ts";

const execFileAsync = promisify(execFile);

/** Every table the app owns, in an order that is safe to drop — mirrors tests/int/helpers.ts. */
const DROP_ALL_TABLES =
  "DROP TABLE IF EXISTS leave_requests, employees, sessions, audit_events, settings, accounts, schema_migrations CASCADE";

async function pg(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(PG_TOOL, args, { cwd: META_ROOT });
  return stdout.trim();
}

async function dropHrTestFromHost(): Promise<void> {
  // Host-side connection to the same `hr_test` database the container reaches over
  // `host.docker.internal`, but via `localhost` — the credential file `npm run test:int`
  // already uses (git-ignored; regenerated here so this file's presence is never assumed).
  const hostOwnerEnvFile = `${APP_ROOT}/.env.test.owner.local`;
  await pg("env", "hr_test", "--role", "owner", "--server", "localhost:5432", "--write", hostOwnerEnvFile);
  const raw = await readFile(hostOwnerEnvFile, "utf8");
  const parsed = Object.fromEntries(
    raw
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      }),
  );
  const pool = createPool(loadDbConfig(parsed));
  try {
    await withClient(pool, (client) => client.query(DROP_ALL_TABLES));
  } finally {
    await pool.end();
  }
}

async function ensureCaCertificate(): Promise<void> {
  if (existsSync(CA_CERT)) {
    return;
  }
  const caPath = await pg("ca");
  await copyFile(caPath, CA_CERT);
}

async function buildImage(): Promise<void> {
  if (process.env.E2E_REUSE_IMAGE === "1") {
    return;
  }
  await execFileAsync("docker", ["build", "-t", IMAGE_TAG, "."], { cwd: APP_ROOT, maxBuffer: 64 * 1024 * 1024 });
}

async function removeStaleContainers(): Promise<void> {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${CONTAINER_PREFIX}`,
    "--format",
    "{{.Names}}",
  ]);
  const names = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const name of names) {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
  }
}

async function waitForReady(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE_URL}/health/ready`);
      if (response.status === 200) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`demo-hr-e2e never became ready on ${BASE_URL}: ${String(lastError)}`);
}

export default async function globalSetup(): Promise<void> {
  await removeStaleContainers();
  await ensureCaCertificate();
  await dropHrTestFromHost();

  await pg("env", "hr_test", "--server", "host.docker.internal:5432", "--write", APP_ENV_FILE);
  await pg("env", "hr_test", "--role", "owner", "--server", "host.docker.internal:5432", "--write", OWNER_ENV_FILE);

  await buildImage();

  const migrated = await runManageNonInteractive(`${CONTAINER_PREFIX}-migrate`, ["migrate"], OWNER_ENV_FILE);
  if (migrated.exitCode !== 0) {
    throw new Error(`manage.mjs migrate failed (exit ${migrated.exitCode}):\n${migrated.transcript}`);
  }

  const secretDir = await makeSecretDir();
  process.env[SECRET_DIR_ENV] = secretDir;

  const admin1Password = generatePassword();
  await writeSecret(secretDir, ADMIN1_PASSWORD_FILE, admin1Password);

  const bootstrapped = await driveManageCli(
    `${CONTAINER_PREFIX}-bootstrap`,
    ["bootstrap"],
    [
      { expect: "Administrator email:", answer: ADMIN1_EMAIL },
      { expect: "Password (15-128 characters):", answer: admin1Password, secret: true },
      { expect: "Password (15-128 characters) (again):", answer: admin1Password, secret: true },
      { expect: "Public origin", answer: BASE_URL },
    ],
    { envFile: OWNER_ENV_FILE },
  );
  if (bootstrapped.exitCode !== 0) {
    throw new Error(`manage.mjs bootstrap failed (exit ${bootstrapped.exitCode}):\n${bootstrapped.transcript}`);
  }

  await execFileAsync("docker", [
    "run",
    "-d",
    "--name",
    SERVER_CONTAINER,
    "--read-only",
    "--cpus=0.5",
    "--memory=1g",
    "--memory-swap=1g",
    "-p",
    `${E2E_HOST}:${E2E_PORT}:3000`,
    "--env-file",
    APP_ENV_FILE,
    IMAGE_TAG,
  ]);

  await waitForReady();
}
