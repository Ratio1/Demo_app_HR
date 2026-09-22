import { defineConfig, devices } from "@playwright/test";

import { BASE_URL } from "./tests/e2e/support/env.ts";

/**
 * Slice 4 — the Playwright journey, DENY paths and a11y suites (slice-4-brief.md). Global
 * setup/teardown own the whole container lifecycle: build/reuse `demo-hr:e2e`, migrate and
 * bootstrap `hr_test` through it, run the read-only capped `demo-hr-e2e` container on
 * `127.0.0.1:3101`, then tear it all down again. Cached Chromium only — `PLAYWRIGHT_BROWSERS_PATH`
 * is left at its default and this config never triggers a download.
 *
 * `workers: 1` / `fullyParallel: false`: the journey builds state (an employee, two more
 * accounts, leave requests) that later tests and `a11y.spec.ts`'s own fixtures depend on inside
 * the *same* `hr_test`, and only one container is running. `trace`/`video` are off on purpose —
 * a trace or a video would capture the login form's POST body, password field included.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  outputDir: "test-results",
  globalSetup: "./tests/e2e/global-setup.ts",
  globalTeardown: "./tests/e2e/global-teardown.ts",
  use: {
    baseURL: BASE_URL,
    trace: "off",
    video: "off",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    ignoreHTTPSErrors: false,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } },
    },
  ],
});
