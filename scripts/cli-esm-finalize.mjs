// Finalises `tsc -p tsconfig.cli.json` output so Node runs it as ES modules.
//
// tsc emits .js files; the package itself is CommonJS, so dist/ gets its own package.json
// declaring the emitted tree as ESM, and the CLI entry point is renamed to the .mjs name the
// container runs. Idempotent: running it twice is a no-op.
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const distDir = resolve(process.cwd(), "dist");
const emitted = resolve(distDir, "cli/manage.js");
const entry = resolve(distDir, "cli/manage.mjs");
const manifest = resolve(distDir, "package.json");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const desired = `${JSON.stringify({ type: "module" }, null, 2)}\n`;
if (!(await exists(manifest)) || (await readFile(manifest, "utf8")) !== desired) {
  await writeFile(manifest, desired, "utf8");
}

if (await exists(emitted)) {
  await rename(emitted, entry);
}

if (!(await exists(entry))) {
  console.error("cli-esm-finalize: dist/cli/manage.mjs is missing - did tsc -p tsconfig.cli.json run?");
  process.exit(1);
}

console.log("cli-esm-finalize: dist/cli/manage.mjs ready (dist/ marked as ESM)");
