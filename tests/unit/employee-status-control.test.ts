import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const { EmployeeStatusControl } = await import(
  "../../src/app/_components/EmployeeStatusControl.js"
);

const activeEmployee = {
  id: "11111111-1111-1111-1111-111111111111",
  code: "E-001",
  full_name: "Ada Lovelace",
  work_email: "ada@example.test",
  title: "Engineer",
  department: "R&D",
  start_date: "2020-01-15",
  active: true,
  link: { linked: false } as const,
  version: 3,
};

/** Slice-2 brief: "activate/deactivate button with consequence copy" — always visible, not
 * gated behind a confirmation dialog (see the component's own doc comment for the deviation
 * from tokens.md §5.9). */
describe("EmployeeStatusControl markup", () => {
  it("shows the deactivate consequence copy and a destructive button for an active employee", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeStatusControl, { employee: activeEmployee, csrfToken: "tok" }),
    );
    expect(html).toContain(
      "Deactivating signs the person out, hides them from the directory and cancels their pending leave.",
    );
    expect(html).toContain("btn--destructive");
    expect(html).toContain(">Deactivate<");
  });

  it("shows the activate consequence copy and a non-destructive button for an inactive employee", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeStatusControl, {
        employee: { ...activeEmployee, active: false },
        csrfToken: "tok",
      }),
    );
    expect(html).toContain("Activating restores this person&#x27;s directory listing.");
    expect(html).not.toContain("btn--destructive");
    expect(html).toContain(">Activate<");
  });

  it("carries the csrf token as a hidden field", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeStatusControl, { employee: activeEmployee, csrfToken: "test-csrf" }),
    );
    const hidden = html.match(/<input\b[^>]*type="hidden"[^>]*>/i)?.[0] ?? "";
    expect(hidden).toMatch(/name="csrf"/);
    expect(hidden).toMatch(/value="test-csrf"/);
  });
});
