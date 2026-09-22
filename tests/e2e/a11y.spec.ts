import { test, expect, type Page, type Browser } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

import { driveManageCli } from "./support/cli.ts";
import {
  ADMIN1_EMAIL,
  ADMIN1_PASSWORD_FILE,
  CONTAINER_PREFIX,
  OWNER_ENV_FILE,
  secretDir,
} from "./support/env.ts";
import { generatePassword, hasMarker, readSecret, writeMarker, writeSecret } from "./support/secrets.ts";

/**
 * Slice 4 — axe + keyboard across the seven signed-in-or-not routes, at both required
 * viewports (slice-4-brief.md). Self-provisions its own fixture accounts (a distinct `hr_admin`
 * and `employee`, both linked, with one pending leave request) rather than depending on
 * `journey.spec.ts`'s run or order — Playwright would otherwise run this file *first*
 * (alphabetically before `journey.spec.ts`), before that file's accounts exist.
 *
 * Provisioning is memoized with an on-disk marker (`support/secrets.ts`'s `hasMarker`/
 * `writeMarker`), not a module-level flag or promise: this Playwright build was observed
 * restarting its single worker process mid-file during this slice's own runs, which silently
 * resets in-memory state (a fresh Node process re-imports this module). Every test reads the
 * fixture passwords back from their 0600 files rather than trusting a module-level variable
 * survived from an earlier test, for the same reason.
 */

const A11Y_ADMIN_EMAIL = "el.axe@example.test";
const A11Y_EMPLOYEE_EMAIL = "fi.axe@example.test";
const A11Y_ADMIN_CODE = "E-A100";
const A11Y_EMPLOYEE_CODE = "E-A101";
const A11Y_ADMIN_PASSWORD_FILE = "a11y-admin.pw";
const A11Y_EMPLOYEE_PASSWORD_FILE = "a11y-employee.pw";
const A11Y_PROVISION_MARKER = "a11y-provisioned.marker";

const VIEWPORTS = [
  { name: "mobile (390x844)", width: 390, height: 844 },
  { name: "desktop (1440x900)", width: 1440, height: 900 },
] as const;

async function loginAs(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#login-email").fill(email);
  await page.locator("#login-password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname === "/");
}

async function createEmployeeAs(page: Page, code: string, fullName: string, workEmail: string): Promise<void> {
  await page.goto("/employees?new=1");
  await expect(page.getByRole("heading", { name: "New employee" })).toBeVisible();
  await page.locator("#employee-code").fill(code);
  await page.locator("#employee-full-name").fill(fullName);
  await page.locator("#employee-work-email").fill(workEmail);
  await page.locator("#employee-title").fill("Reviewer");
  await page.locator("#employee-department").fill("Quality");
  await page.locator("#employee-start-date").fill("2026-02-02");
  await page.getByRole("button", { name: "Create employee" }).click();
  await page.waitForURL((url) => url.pathname === "/employees" && url.searchParams.get("saved") === "created");
}

/** Idempotent across both re-invocation and a worker restart — see the file's doc comment. */
async function ensureFixtures(browser: Browser): Promise<void> {
  if (hasMarker(secretDir(), A11Y_PROVISION_MARKER)) {
    return;
  }

  const admin1Password = await readSecret(secretDir(), ADMIN1_PASSWORD_FILE);
  const setupContext = await browser.newContext();
  const setupPage = await setupContext.newPage();

  await loginAs(setupPage, ADMIN1_EMAIL, admin1Password);
  await createEmployeeAs(setupPage, A11Y_ADMIN_CODE, "El Axe", A11Y_ADMIN_EMAIL);
  await createEmployeeAs(setupPage, A11Y_EMPLOYEE_CODE, "Fi Axe", A11Y_EMPLOYEE_EMAIL);

  const adminPassword = generatePassword();
  await writeSecret(secretDir(), A11Y_ADMIN_PASSWORD_FILE, adminPassword);
  const adminCreated = await driveManageCli(
    `${CONTAINER_PREFIX}-createuser-a11y-admin`,
    ["create-user", "--role", "hr_admin", "--email", A11Y_ADMIN_EMAIL, "--employee", A11Y_ADMIN_CODE],
    [
      { expect: "Password (15-128 characters):", answer: adminPassword, secret: true },
      { expect: "Password (15-128 characters) (again):", answer: adminPassword, secret: true },
    ],
    { envFile: OWNER_ENV_FILE },
  );
  expect(adminCreated.exitCode, adminCreated.transcript).toBe(0);

  const employeePassword = generatePassword();
  await writeSecret(secretDir(), A11Y_EMPLOYEE_PASSWORD_FILE, employeePassword);
  const employeeCreated = await driveManageCli(
    `${CONTAINER_PREFIX}-createuser-a11y-employee`,
    ["create-user", "--role", "employee", "--email", A11Y_EMPLOYEE_EMAIL, "--employee", A11Y_EMPLOYEE_CODE],
    [
      { expect: "Password (15-128 characters):", answer: employeePassword, secret: true },
      { expect: "Password (15-128 characters) (again):", answer: employeePassword, secret: true },
    ],
    { envFile: OWNER_ENV_FILE },
  );
  expect(employeeCreated.exitCode, employeeCreated.transcript).toBe(0);

  // One pending request, so /leave has a Cancel control and /approvals has an Approve/Reject
  // row for both the axe scan and the keyboard sweep to exercise.
  const employeePage = await setupContext.newPage();
  await loginAs(employeePage, A11Y_EMPLOYEE_EMAIL, employeePassword);
  await employeePage.goto("/leave");
  await employeePage.locator("#leave-kind").selectOption("annual");
  await employeePage.locator("#leave-start-date").fill("2026-10-12");
  await employeePage.locator("#leave-end-date").fill("2026-10-16");
  await employeePage.getByRole("button", { name: "Submit request" }).click();
  await employeePage.waitForURL((url) => url.searchParams.get("saved") === "submitted");

  await setupContext.close();
  await writeMarker(secretDir(), A11Y_PROVISION_MARKER);
}

interface RouteCheck {
  readonly path: string;
  /** "" means anonymous (no session). */
  readonly email: string;
}

const ADMIN_ROUTES = ["/", "/directory", "/me", "/employees", "/leave", "/approvals"] as const;
const EMPLOYEE_ROUTES = ["/", "/directory", "/me", "/employees", "/leave", "/approvals"] as const;

/**
 * Asserts something route- and role-specific is actually on the page, before the axe scan and
 * the scroll-width check run below. Without this, `page.goto` followed immediately by
 * `analyze()` would scan a Suspense fallback, an unexpected redirect or an empty error page just
 * as cleanly as the real content — all four `src/app/**\/loading.tsx` files render their own
 * `<main id="main-content">`, so that id alone (already present before this fix) proves nothing.
 * `getByRole` only matches the accessibility tree, which excludes `display:none` elements, so a
 * locator scoped to content one viewport hides (the desktop-only `data-table` vs. the
 * mobile-only `card-list`) resolves to nothing at the other width; every locator below is
 * therefore chosen to be visible at **both** required viewports (390×844 and 1440×900).
 */
async function assertRouteResolved(page: Page, path: string, roleLabel: "anonymous" | "hr_admin" | "employee"): Promise<void> {
  const forbidden = () => expect(page.getByText("You don’t have access to this.")).toBeVisible();
  switch (path) {
    case "/login":
      await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
      return;
    case "/":
      await expect(page.getByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
      return;
    case "/directory":
      await expect(page.getByRole("heading", { level: 1, name: "Directory" })).toBeVisible();
      return;
    case "/me":
      await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
      return;
    case "/leave":
      // Both fixture accounts are linked employees (`el.axe` is an `hr_admin(self)`), so both
      // render the submit form — the same locator the keyboard test below already waits on.
      await expect(page.locator("#leave-kind")).toBeVisible();
      return;
    case "/employees":
      if (roleLabel === "employee") {
        await forbidden();
      } else {
        // Not the per-row "Open <name>" link: that one lives only in the desktop table
        // (`hidden sm:table`) and has no equivalent in the mobile card list. "New employee" sits
        // outside both and is visible at every width, and only renders for the real list view.
        await expect(page.getByRole("link", { name: "New employee" })).toBeVisible();
      }
      return;
    case "/approvals":
      if (roleLabel === "employee") {
        await forbidden();
      } else {
        // `ApprovalDecisionControl` renders once in the desktop table and once in the mobile
        // card list with the same `aria-label`, so exactly one is ever in the accessibility
        // tree at a time — safe at both viewports (already relied on by the keyboard test).
        await expect(page.getByRole("button", { name: "Approve Fi Axe's request" })).toBeVisible();
      }
      return;
    default:
      throw new Error(`assertRouteResolved: no expectation wired up for ${path}`);
  }
}

function checks(): RouteCheck[] {
  const list: RouteCheck[] = [{ path: "/login", email: "" }];
  for (const path of ADMIN_ROUTES) {
    list.push({ path, email: A11Y_ADMIN_EMAIL });
  }
  for (const path of EMPLOYEE_ROUTES) {
    list.push({ path, email: A11Y_EMPLOYEE_EMAIL });
  }
  return list;
}

for (const viewport of VIEWPORTS) {
  test.describe(`axe — ${viewport.name}`, () => {
    for (const route of checks()) {
      const roleLabel = route.email === "" ? "anonymous" : route.email === A11Y_ADMIN_EMAIL ? "hr_admin" : "employee";

      test(`${route.path} (${roleLabel}) has zero serious/critical violations, no horizontal scroll`, async ({
        page,
        browser,
      }) => {
        await ensureFixtures(browser);
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        if (route.email === A11Y_ADMIN_EMAIL) {
          await loginAs(page, A11Y_ADMIN_EMAIL, await readSecret(secretDir(), A11Y_ADMIN_PASSWORD_FILE));
        } else if (route.email === A11Y_EMPLOYEE_EMAIL) {
          await loginAs(page, A11Y_EMPLOYEE_EMAIL, await readSecret(secretDir(), A11Y_EMPLOYEE_PASSWORD_FILE));
        }
        await page.goto(route.path);
        await assertRouteResolved(page, route.path, roleLabel);

        const results = await new AxeBuilder({ page }).analyze();
        const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
        expect(bad, JSON.stringify(bad.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })), null, 2)).toEqual(
          [],
        );

        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(
          scrollWidth,
          `document.documentElement.scrollWidth (${scrollWidth}) exceeds the ${viewport.width}px viewport on ${route.path}`,
        ).toBeLessThanOrEqual(viewport.width);
      });
    }
  });
}

test.describe("keyboard", () => {
  test("/leave: Tab reaches every control, Enter submits, focus returns to the banner on error", async ({
    page,
    browser,
  }) => {
    await ensureFixtures(browser);
    await loginAs(page, A11Y_EMPLOYEE_EMAIL, await readSecret(secretDir(), A11Y_EMPLOYEE_PASSWORD_FILE));
    await page.goto("/leave");
    // The route has its own `loading.tsx` Suspense fallback; wait for the real form rather
    // than the skeleton before driving focus through it.
    await expect(page.locator("#leave-kind")).toBeVisible();

    const expectedIds = ["leave-kind", "leave-start-date", "leave-end-date"];
    // The fixture leaves one pending request behind (see `ensureFixtures`), so both the submit
    // form's own button and that request's Cancel control are in the tab order and must stay
    // reachable — a control silently dropping out of the tab order must fail this test, not
    // pass it because nothing downstream ever looked at what was collected for it.
    const expectedButtonLabels = ["Submit request", "Cancel"];
    const reached = new Set<string>();
    await page.locator("body").click(); // start from a known place, nothing focused
    for (let i = 0; i < 25; i += 1) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => document.activeElement?.id ?? "");
      if (id !== "") {
        reached.add(id);
      }
      const tag = await page.evaluate(() => document.activeElement?.tagName ?? "");
      if (tag === "BUTTON") {
        const text = await page.evaluate(() => document.activeElement?.textContent ?? "");
        if (text.includes("Submit request") || text.includes("Cancel")) {
          reached.add(text.trim());
        }
      }
    }
    for (const id of expectedIds) {
      expect(reached.has(id), `Tab never focused #${id} on /leave (reached: ${[...reached].join(", ")})`).toBe(true);
    }
    for (const label of expectedButtonLabels) {
      expect(
        reached.has(label),
        `Tab never focused the "${label}" button on /leave (reached: ${[...reached].join(", ")})`,
      ).toBe(true);
    }

    // Enter submits, from the keyboard, no mouse click. A range overlapping the fixture's own
    // pending request (2026-10-12 – 2026-10-16) is used rather than an end-before-start date:
    // the latter is a *per-field* `role="alert"` message next to the input, not a `.banner` —
    // only a whole-request refusal (overlap, forbidden, over-large, …) renders the focusable
    // `Banner` component this assertion is about.
    await page.locator("#leave-kind").selectOption("annual");
    await page.locator("#leave-start-date").fill("2026-10-13");
    await page.locator("#leave-end-date").fill("2026-10-14");
    await page.locator("#leave-end-date").press("Enter");

    const banner = page.locator(".banner").first();
    await expect(banner).toBeVisible();
    const focusIsBanner = await page.evaluate(() => document.activeElement?.classList.contains("banner") ?? false);
    expect(focusIsBanner, "focus did not return to the error banner after an invalid submission").toBe(true);
  });

  test("/approvals: Tab reaches the Approve/Reject controls, Enter opens the confirm dialog", async ({
    page,
    browser,
  }) => {
    await ensureFixtures(browser);
    await loginAs(page, A11Y_ADMIN_EMAIL, await readSecret(secretDir(), A11Y_ADMIN_PASSWORD_FILE));
    await page.goto("/approvals");

    const approveButton = page.getByRole("button", { name: "Approve Fi Axe's request" });
    await expect(approveButton).toBeVisible();

    let found = false;
    for (let i = 0; i < 40 && !found; i += 1) {
      await page.keyboard.press("Tab");
      found = await page.evaluate(
        (label) => document.activeElement?.getAttribute("aria-label") === label,
        `Approve Fi Axe's request`,
      );
    }
    expect(found, "Tab never reached the Approve button on /approvals").toBe(true);

    await page.keyboard.press("Enter");
    const openDialog = page.locator("dialog[open]");
    await expect(openDialog).toBeVisible();
    // Both the approve and reject <dialog> elements exist in the DOM at all times (only one
    // has the `open` attribute at a time), so an unscoped "Close" button locator matches two.
    // Close without deciding — this file must not consume the fixture other tests may still use.
    await openDialog.getByRole("button", { name: "Close" }).click();
  });
});
