/**
 * Throw-away passwords for the e2e fixture accounts. Generated once per run, written to 0600
 * files under a `mkdtemp` directory (`global-setup.ts` sets `HR_E2E_SECRET_DIR`), and never a
 * CLI argument, an assertion message, or a `console.log`. `global-teardown.ts` shreds the
 * directory.
 */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/** 32 base64url characters: well inside the app's 15–128 character password policy. */
export function generatePassword(): string {
  return randomBytes(24).toString("base64url");
}

export async function makeSecretDir(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "demo-hr-e2e-secrets-"));
}

export async function writeSecret(dir: string, fileName: string, value: string): Promise<string> {
  const target = path.join(dir, fileName);
  await writeFile(target, value, { mode: 0o600 });
  await chmod(target, 0o600);
  return target;
}

export async function readSecret(dir: string, fileName: string): Promise<string> {
  return readFile(path.join(dir, fileName), "utf8");
}

export async function shredSecretDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/**
 * A durable, cross-process "already provisioned" marker. Playwright's `workers: 1` still lets
 * this build restart the worker process mid-file (observed empirically in this slice — a fresh
 * process re-imports the spec module, so any in-memory "did I already do this?" flag resets to
 * its initial value); a file under the shared secret directory survives that restart, so setup
 * that must run exactly once (creating an account, an employee code) can check it first instead
 * of trusting a module-level flag.
 */
export function hasMarker(dir: string, name: string): boolean {
  return existsSync(path.join(dir, name));
}

export async function writeMarker(dir: string, name: string): Promise<void> {
  await writeFile(path.join(dir, name), "done", { mode: 0o600 });
}
