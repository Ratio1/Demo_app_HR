import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Regression guard for the slice-2 review's third finding, whose real cause was not the card
 * CSS it named but the page width behind it.
 *
 * This theme renames Tailwind's spacing scale to `xs…3xl`, and `max-w-*` resolves a *named* key
 * against the spacing namespace before the container namespace. `max-w-md` therefore compiled
 * to `max-width: var(--spacing-md)` — 1rem — and every single-column page (`/login`, `/me`, the
 * employee editor, the error and not-found shells) rendered as a 16px column. Adding
 * `--container-md` does not fix it; the utility has to go. `.page-column` replaces it.
 *
 * The same trap is waiting for any other `max-w-<key>` that collides with a spacing token name,
 * so the assertion is written against the whole `max-w-` family, not just `md`.
 */
const APP_DIR = new URL("../../src/app/", import.meta.url).pathname;
const CSS = readFileSync(new URL("../../src/app/globals.css", import.meta.url).pathname, "utf8");

/** Spacing keys declared in the `@theme` block: a `max-w-<key>` for any of these is a trap. */
const SPACING_KEYS = [...CSS.matchAll(/^\s*--spacing-([a-z0-9]+):/gmu)].map((m) => m[1]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return tsxFiles(path);
    }
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("single-column page width", () => {
  it("declares .page-column from a token", () => {
    expect(SPACING_KEYS).toContain("md");
    expect(CSS).toMatch(/--page-column-width:\s*28rem/u);
    expect(CSS).toMatch(/\.page-column\s*\{\s*max-width:\s*var\(--page-column-width\)/u);
  });

  it("uses no max-w-* utility whose key is also a spacing token", () => {
    const trap = new RegExp(`\\bmax-w-(${SPACING_KEYS.join("|")})\\b`, "u");
    const offenders = tsxFiles(APP_DIR).filter((file) => trap.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps the single-column pages on .page-column", () => {
    for (const page of [
      "login/page.tsx",
      "me/page.tsx",
      "employees/page.tsx",
      "not-found.tsx",
      "error.tsx",
      "global-error.tsx",
    ]) {
      expect(readFileSync(join(APP_DIR, page), "utf8")).toContain("page-column");
    }
  });
});
