/**
 * Playwright global teardown for slice 4: removes the `demo-hr-e2e*` container(s), the
 * generated `.env.e2e*` credential files, and the secret directory `global-setup.ts` created —
 * so nothing this run wrote survives it, credentials included. `hr_test`'s row data is left as
 * the last test suite leaves it; the next run's `global-setup.ts` drops every table before it
 * migrates, so nothing here depends on that state either way.
 */
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { promisify } from "node:util";

import { APP_ENV_FILE, CONTAINER_PREFIX, OWNER_ENV_FILE, SECRET_DIR_ENV } from "./support/env.ts";
import { shredSecretDir } from "./support/secrets.ts";

const execFileAsync = promisify(execFile);

async function removeE2eContainers(): Promise<void> {
  const { stdout } = await execFileAsync("docker", [
    "ps",
    "-a",
    "--filter",
    `name=^/${CONTAINER_PREFIX}`,
    "--format",
    "{{.Names}}",
  ]).catch(() => ({ stdout: "" }));
  const names = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  for (const name of names) {
    await execFileAsync("docker", ["rm", "-f", name]).catch(() => undefined);
  }
}

export default async function globalTeardown(): Promise<void> {
  await removeE2eContainers();

  await rm(APP_ENV_FILE, { force: true });
  await rm(OWNER_ENV_FILE, { force: true });

  const secretDir = process.env[SECRET_DIR_ENV];
  if (secretDir !== undefined && secretDir !== "") {
    await shredSecretDir(secretDir);
  }
}
