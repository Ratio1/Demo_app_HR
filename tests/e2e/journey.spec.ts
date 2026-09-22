import { test, expect, type Page, type Browser, type BrowserContext, type APIResponse } from "@playwright/test";

import { driveManageCli } from "./support/cli.ts";
import {
  ADMIN1_EMAIL,
  ADMIN1_PASSWORD_FILE,
  ADMIN2_EMAIL,
  ADMIN2_EMPLOYEE_CODE,
  ADMIN2_PASSWORD_FILE,
  CONTAINER_PREFIX,
  EMPLOYEE_EMAIL,
  EMPLOYEE_EMPLOYEE_CODE,
  EMPLOYEE_PASSWORD_FILE,
  OWNER_ENV_FILE,
  secretDir,
} from "./support/env.ts";
import { generatePassword, hasMarker, readSecret, writeMarker, writeSecret } from "./support/secrets.ts";

/**
 * Slice 4 — the end-to-end journey and its denied paths (slice-4-brief.md), against the
 * `demo-hr-e2e` container `global-setup.ts` starts. Every mutation is page-driven (ruling
 * R-G): Playwright's Node-side `request` fixture is used only for the one check a real browser
 * can never even present (a POST with literally no `Origin` header — every browser-issued
 * fetch carries one); every forced POST that bypasses a disabled control instead runs inside
 * `page.evaluate`, from the page's own authenticated context, cookies included.
 *
 * Every test logs in fresh and closes what it opens, rather than sharing a page/context across
 * tests: this Playwright build was observed restarting its single worker process mid-file
 * during this slice's own runs (a fresh Node process re-imports the spec module, silently
 * resetting any module-level "already logged in" / "already provisioned" state — see
 * `support/secrets.ts`'s `hasMarker`/`writeMarker` doc comment and the report's test-authoring
 * notes). Provisioning the org is memoized with an on-disk marker for the same reason. Tests
 * are **not** `.serial()`: a failure records itself and the run continues into the next test.
 */

const PROVISION_MARKER = "journey-provisioned.marker";

async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

/** A fresh, single-purpose context+page, logged in as `email`. Caller closes the context. */
async function freshSession(browser: Browser, email: string, password: string): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, email, password);
  return { context, page };
}

/** The session's CSRF synchronizer token, read from the nav's own logout form — present on
 * every authenticated page (`AppNav.tsx`) and identical to the one every fetch call uses. */
async function csrfTokenFrom(page: Page): Promise<string> {
  return page.locator('form[action="/api/logout"] input[name="csrf"]').inputValue();
}

async function gotoLeaveForm(page: Page): Promise<void> {
  await page.goto("/leave");
  // The route has its own `loading.tsx` Suspense fallback; wait past it before interacting.
  await expect(page.locator("#leave-kind")).toBeVisible();
}

async function createEmployeeAs(page: Page, code: string, fullName: string, workEmail: string): Promise<void> {
  await page.goto("/employees?new=1");
  await expect(page.getByRole("heading", { name: "New employee" })).toBeVisible();
  await page.locator("#employee-code").fill(code);
  await page.locator("#employee-full-name").fill(fullName);
  await page.locator("#employee-work-email").fill(workEmail);
  await page.locator("#employee-title").fill("Coordinator");
  await page.locator("#employee-department").fill("Operations");
  await page.locator("#employee-start-date").fill("2026-03-02");
  await page.getByRole("button", { name: "Create employee" }).click();
  await page.waitForURL((url) => url.pathname === "/employees" && url.searchParams.get("saved") === "created");
}

/**
 * Idempotent across both in-process re-invocation and a worker restart (the on-disk marker):
 * admin1 creates the two employee records, then a second HR admin and the employee's own
 * login are provisioned through the pty (`support/cli.ts`), exactly as the brief describes.
 */
async function ensureOrgProvisioned(browser: Browser): Promise<void> {
  if (hasMarker(secretDir(), PROVISION_MARKER)) {
    return;
  }

  const admin1Password = await readSecret(secretDir(), ADMIN1_PASSWORD_FILE);
  const { context, page } = await freshSession(browser, ADMIN1_EMAIL, admin1Password);
  try {
    // Scoped to the nav's own identity caption: the overview page's "Signed in as
    // <strong>{email}</strong>" sentence repeats the same address, which would otherwise make
    // this a strict-mode-ambiguous locator (two matches).
    await expect(page.locator("span.text-caption", { hasText: ADMIN1_EMAIL })).toBeVisible();

    await createEmployeeAs(page, ADMIN2_EMPLOYEE_CODE, "Bo Second", ADMIN2_EMAIL);
    await createEmployeeAs(page, EMPLOYEE_EMPLOYEE_CODE, "Cy Staff", EMPLOYEE_EMAIL);
  } finally {
    await context.close();
  }

  const admin2Password = generatePassword();
  await writeSecret(secretDir(), ADMIN2_PASSWORD_FILE, admin2Password);
  const admin2Created = await driveManageCli(
    `${CONTAINER_PREFIX}-createuser-admin2`,
    ["create-user", "--role", "hr_admin", "--email", ADMIN2_EMAIL, "--employee", ADMIN2_EMPLOYEE_CODE],
    [
      { expect: "Password (15-128 characters):", answer: admin2Password, secret: true },
      { expect: "Password (15-128 characters) (again):", answer: admin2Password, secret: true },
    ],
    { envFile: OWNER_ENV_FILE },
  );
  expect(admin2Created.exitCode, admin2Created.transcript).toBe(0);
  expect(admin2Created.transcript).toContain(`linked to employee ${ADMIN2_EMPLOYEE_CODE}`);

  const employeePassword = generatePassword();
  await writeSecret(secretDir(), EMPLOYEE_PASSWORD_FILE, employeePassword);
  const employeeCreated = await driveManageCli(
    `${CONTAINER_PREFIX}-createuser-employee`,
    ["create-user", "--role", "employee", "--email", EMPLOYEE_EMAIL, "--employee", EMPLOYEE_EMPLOYEE_CODE],
    [
      { expect: "Password (15-128 characters):", answer: employeePassword, secret: true },
      { expect: "Password (15-128 characters) (again):", answer: employeePassword, secret: true },
    ],
    { envFile: OWNER_ENV_FILE },
  );
  expect(employeeCreated.exitCode, employeeCreated.transcript).toBe(0);
  expect(employeeCreated.transcript).toContain(`linked to employee ${EMPLOYEE_EMPLOYEE_CODE}`);

  await writeMarker(secretDir(), PROVISION_MARKER);
}

test.describe("Slice 4 journey", () => {
  test("admin1 signs in and provisions a second HR admin and an employee login", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    // Re-affirm the login itself is the observable journey step, not just a setup side effect.
    const { context, page } = await freshSession(browser, ADMIN1_EMAIL, await readSecret(secretDir(), ADMIN1_PASSWORD_FILE));
    await expect(page.locator("span.text-caption", { hasText: ADMIN1_EMAIL })).toBeVisible();
    await context.close();
  });

  test("the employee signs in, submits leave, and sees the weekday count before submitting", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const { context, page } = await freshSession(browser, EMPLOYEE_EMAIL, await readSecret(secretDir(), EMPLOYEE_PASSWORD_FILE));
    await gotoLeaveForm(page);

    await page.locator("#leave-kind").selectOption("annual");
    await page.locator("#leave-start-date").fill("2026-10-05"); // Monday
    await page.locator("#leave-end-date").fill("2026-10-09"); // Friday, same week

    // The live count must be on screen *before* the click that submits the form.
    await expect(page.getByRole("status").filter({ hasText: "weekday" })).toHaveText(/5 weekdays \(Mon–Fri\)/);

    await page.getByRole("button", { name: "Submit request" }).click();
    await page.waitForURL((url) => url.pathname === "/leave" && url.searchParams.get("saved") === "submitted");
    await expect(page.getByText("Your leave request has been submitted.")).toBeVisible();

    const row = page.locator("table.data-table tbody tr", { hasText: "2026-10-05" });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-status="pending"]')).toBeVisible();
    await context.close();
  });

  test("admin2 approves the request, and the employee sees it approved", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const admin2 = await freshSession(browser, ADMIN2_EMAIL, await readSecret(secretDir(), ADMIN2_PASSWORD_FILE));
    await admin2.page.goto("/approvals");

    const row = admin2.page.locator("table.data-table tbody tr", { hasText: "Cy Staff" });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Approve Cy Staff's request" }).click();
    const dialog = admin2.page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Approve", exact: true }).click();

    await admin2.page.waitForURL((url) => url.pathname === "/approvals" && url.searchParams.get("saved") === "approved");
    await expect(admin2.page.getByText("The request has been approved.")).toBeVisible();
    await admin2.context.close();

    const employee = await freshSession(browser, EMPLOYEE_EMAIL, await readSecret(secretDir(), EMPLOYEE_PASSWORD_FILE));
    await employee.page.goto("/leave");
    // Both the desktop `<table>` and the mobile `<ul>` card list render the same data
    // simultaneously (only one is CSS-hidden per viewport) — `.first()` picks either, since
    // both reflect the identical server-confirmed status.
    await expect(employee.page.locator('[data-status="approved"]').first()).toBeVisible();

    await employee.page.goto("/");
    await expect(employee.page.getByText("Latest request:")).toBeVisible();
    await expect(employee.page.locator('[data-status="approved"]').first()).toBeVisible();
    await employee.context.close();
  });
});

test.describe("Slice 4 — denied paths", () => {
  test("D-040: an HR admin cannot approve or reject their own request, button or forced POST", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const { context, page } = await freshSession(browser, ADMIN2_EMAIL, await readSecret(secretDir(), ADMIN2_PASSWORD_FILE));
    await gotoLeaveForm(page);
    await page.locator("#leave-kind").selectOption("personal");
    await page.locator("#leave-start-date").fill("2026-11-02");
    await page.locator("#leave-end-date").fill("2026-11-04");
    await page.getByRole("button", { name: "Submit request" }).click();
    await page.waitForURL((url) => url.pathname === "/leave" && url.searchParams.get("saved") === "submitted");
    const ownRequestId = new URL(page.url()).searchParams.get("id");
    expect(ownRequestId).not.toBeNull();

    await page.goto("/approvals");
    const ownRow = page.locator("table.data-table tbody tr", { hasText: "Bo Second" });
    await expect(ownRow).toBeVisible();
    await expect(ownRow.getByRole("button", { name: /Approve|Reject/ })).toHaveCount(0);
    await expect(ownRow.getByText("A different HR admin must decide your own request.")).toBeVisible();

    // The disabled affordance is not the control (S4): force the exact POST the button would
    // have sent, against the admin's own real request id, from the page's own authenticated
    // context (real cookies, real CSRF) rather than Node-side `request` (ruling R-G).
    const csrfToken = await csrfTokenFrom(page);
    const forced = await page.evaluate(
      async ({ id, csrf }) => {
        const response = await fetch(`/api/leave/${id}/decision`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "approve", version: 1, csrf }),
        });
        return response.status;
      },
      { id: ownRequestId, csrf: csrfToken },
    );
    expect(forced).toBe(403);
    await context.close();
  });

  test("D-023/D-076: an employee cannot reach /employees, by page or by forced API call", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const { context, page } = await freshSession(browser, EMPLOYEE_EMAIL, await readSecret(secretDir(), EMPLOYEE_PASSWORD_FILE));
    await page.goto("/employees");
    // The rendered JSX uses a typographic apostrophe (`&rsquo;`), not the straight one.
    await expect(page.getByText("You don’t have access to this.")).toBeVisible();

    const csrfToken = await csrfTokenFrom(page);
    const status = await page.evaluate(async (csrf) => {
      const response = await fetch("/api/employees", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          code: "E-9999",
          full_name: "Forced Post",
          work_email: "forced.post@example.test",
          title: "x",
          department: "x",
          start_date: "2026-01-01",
          csrf,
        }),
      });
      return response.status;
    }, csrfToken);
    expect(status).toBe(403);
    await context.close();
  });

  test("stale edit: a second tab's save is refused and its inputs are preserved", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const { context, page: firstTab } = await freshSession(browser, ADMIN1_EMAIL, await readSecret(secretDir(), ADMIN1_PASSWORD_FILE));

    // Find the employee id from the list rather than hard-coding it.
    await firstTab.goto("/employees");
    const link = firstTab.getByRole("link", { name: "Open Cy Staff" });
    await link.click();
    await firstTab.waitForURL((url) => url.pathname === "/employees" && url.searchParams.has("id"));
    const employeeUrl = firstTab.url();

    const secondTab = await context.newPage();
    await secondTab.goto(employeeUrl);

    // Tab A saves first, bumping the row's version.
    await firstTab.locator("#employee-title").fill("Senior Coordinator");
    await firstTab.getByRole("button", { name: "Save changes" }).click();
    await firstTab.waitForURL((url) => url.searchParams.get("saved") === "updated");

    // Tab B still holds the pre-save version and types into the still-open form.
    await secondTab.locator("#employee-title").fill("Should Not Save");
    await secondTab.getByRole("button", { name: "Save changes" }).click();
    await expect(secondTab.getByText("This record changed — reload to see the current values.")).toBeVisible();
    await expect(secondTab.locator("#employee-title")).toHaveValue("Should Not Save");

    await context.close();
  });

  test("overlap: a range that overlaps the employee's already-decided request is refused", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const { context, page } = await freshSession(browser, EMPLOYEE_EMAIL, await readSecret(secretDir(), EMPLOYEE_PASSWORD_FILE));
    await gotoLeaveForm(page);
    await page.locator("#leave-kind").selectOption("annual");
    await page.locator("#leave-start-date").fill("2026-10-07");
    await page.locator("#leave-end-date").fill("2026-10-12");
    await page.getByRole("button", { name: "Submit request" }).click();
    await expect(page.getByText("Overlapping pending or approved requests are rejected.")).toBeVisible();
    await context.close();
  });

  test("D-072: five wrong passwords lock the account out", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const throwawayCode = "E-9100";
    const throwawayEmail = "lockout.target@example.test";

    const admin1 = await freshSession(browser, ADMIN1_EMAIL, await readSecret(secretDir(), ADMIN1_PASSWORD_FILE));
    await createEmployeeAs(admin1.page, throwawayCode, "Lockout Target", throwawayEmail);
    await admin1.context.close();

    const throwawayPassword = generatePassword();
    const created = await driveManageCli(
      `${CONTAINER_PREFIX}-createuser-lockout`,
      ["create-user", "--role", "employee", "--email", throwawayEmail, "--employee", throwawayCode],
      [
        { expect: "Password (15-128 characters):", answer: throwawayPassword, secret: true },
        { expect: "Password (15-128 characters) (again):", answer: throwawayPassword, secret: true },
      ],
      { envFile: OWNER_ENV_FILE },
    );
    expect(created.exitCode, created.transcript).toBe(0);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto("/login");
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await page.locator("#login-email").fill(throwawayEmail);
      await page.locator("#login-password").fill("definitely-the-wrong-password");
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.waitForURL((url) => url.pathname === "/login");
      await expect(page.getByText("We could not sign you in.")).toBeVisible();
    }

    // The fifth wrong attempt crosses MAX_FAILED_LOGINS and the server answers `429` directly
    // (src/app/api/login/route.ts → lockedOutPage()) with a small, real HTML page — LoginForm is
    // a plain, scriptless <form>, so the browser navigates straight to that document. The fix
    // (commit e231554, slice-4 "App defects found" #5) ships an <h1>, a `role="alert"` paragraph
    // naming the retry delay and a link back to `/login`; asserted below rather than only
    // checked for the absence of raw JSON, so a regression is caught even if some other non-JSON
    // body were ever substituted.
    await page.locator("#login-email").fill(throwawayEmail);
    await page.locator("#login-password").fill("definitely-the-wrong-password");
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/login")),
      page.getByRole("button", { name: "Sign in" }).click(),
    ]);
    expect(response.status()).toBe(429);
    await expect(page.getByRole("heading", { name: "Too many attempts" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveText(/Try again in \d+ seconds?\./);

    await context.close();
  });

  test("Origin-less POST is refused before a session is even considered", async ({ request }) => {
    // The top-level `request` fixture, not `page.request`: a fresh, cookie-less context, so
    // this is unambiguously not an authenticated call (ruling R-G) — it exercises a guard a
    // real browser can never even present (every browser-issued fetch carries an `Origin`).
    const response: APIResponse = await request.post("/api/leave", {
      headers: { "content-type": "application/json", origin: "" },
      data: JSON.stringify({ kind: "annual", start_date: "2026-12-01", end_date: "2026-12-04", csrf: "x" }),
    });
    expect(response.status()).toBe(403);
  });

  test("logout, then Back, shows no private page", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const { context, page } = await freshSession(browser, EMPLOYEE_EMAIL, await readSecret(secretDir(), EMPLOYEE_PASSWORD_FILE));
    await page.goto("/");
    // Scoped to the nav's identity caption: the overview page's own "Signed in as
    // <strong>{email}</strong>" sentence repeats the address (strict-mode-ambiguous otherwise).
    const identityCaption = page.locator("span.text-caption", { hasText: EMPLOYEE_EMAIL });
    await expect(identityCaption).toBeVisible();

    const logoutResponse = page.waitForResponse((r) => r.url().endsWith("/api/logout"));
    await page.getByRole("button", { name: "Log out" }).click();
    await logoutResponse;
    await page.waitForURL((url) => url.pathname === "/login");

    await page.goBack();
    await page.waitForLoadState("networkidle").catch(() => undefined);
    const onLogin = new URL(page.url()).pathname === "/login";
    const stillShowsEmail = await identityCaption.isVisible().catch(() => false);
    expect(onLogin || !stillShowsEmail, `back navigation showed a private page at ${page.url()}`).toBe(true);

    await context.close();
  });

  test("D-003: a deactivated employee's live session dies, and their login is refused", async ({ browser }) => {
    await ensureOrgProvisioned(browser);
    const employeePassword = await readSecret(secretDir(), EMPLOYEE_PASSWORD_FILE);

    // The employee's own tab, opened before the deactivation below and never re-logged-in —
    // proves a *live* session dies immediately, not merely that a fresh login is refused
    // afterwards.
    const employee = await freshSession(browser, EMPLOYEE_EMAIL, employeePassword);
    await expect(employee.page.locator("span.text-caption", { hasText: EMPLOYEE_EMAIL })).toBeVisible();

    const admin1 = await freshSession(browser, ADMIN1_EMAIL, await readSecret(secretDir(), ADMIN1_PASSWORD_FILE));
    await admin1.page.goto("/employees");
    const link = admin1.page.getByRole("link", { name: "Open Cy Staff" });
    await link.click();
    await admin1.page.waitForURL((url) => url.pathname === "/employees" && url.searchParams.has("id"));
    await admin1.page.getByRole("button", { name: "Deactivate" }).click();
    await admin1.page.waitForURL((url) => url.searchParams.get("saved") === "status");
    await expect(admin1.page.locator('.employee-status[data-active="false"]')).toBeVisible();
    await admin1.context.close();

    await employee.page.goto("/");
    await employee.page.waitForURL((url) => url.pathname === "/login");

    await employee.page.locator("#login-email").fill(EMPLOYEE_EMAIL);
    await employee.page.locator("#login-password").fill(employeePassword);
    await employee.page.getByRole("button", { name: "Sign in" }).click();
    await employee.page.waitForURL((url) => url.pathname === "/login");
    await expect(employee.page.getByText("We could not sign you in.")).toBeVisible();
    await employee.context.close();
  });
});
