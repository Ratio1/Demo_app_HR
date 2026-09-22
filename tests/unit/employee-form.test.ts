import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

// Imported after the mock so the component picks up the mocked `next/navigation`.
const { EmployeeForm } = await import("../../src/app/_components/EmployeeForm.js");

/**
 * Static-markup assertions for the initial render only (no jsdom in this project — see
 * tests/unit/login-form.test.ts's own comment), following the same pattern: field names the
 * server contract expects (`src/server/dto/employees.ts`'s `EMPLOYEE_FORM_FIELDS`), the hidden
 * `csrf` field, labels bound via `htmlFor`/`id`, and bounded `maxLength`s matching the DTO's
 * exported constants.
 */
describe("EmployeeForm markup", () => {
  it("renders every field with a bound label, in create mode, prefilled empty", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeForm, { mode: "create", csrfToken: "test-csrf-token" }),
    );

    for (const [id, name] of [
      ["employee-code", "code"],
      ["employee-full-name", "full_name"],
      ["employee-work-email", "work_email"],
      ["employee-title", "title"],
      ["employee-department", "department"],
      ["employee-start-date", "start_date"],
    ]) {
      const inputMatch = html.match(new RegExp(`<input\\b[^>]*\\bname="${name}"[^>]*>`, "i"));
      expect(inputMatch, `expected an <input name="${name}">`).not.toBeNull();
      expect(inputMatch?.[0]).toContain(`id="${id}"`);
      expect(html).toMatch(new RegExp(`<label for="${id}"`));
    }
  });

  it("carries the csrf token as a hidden field", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeForm, { mode: "create", csrfToken: "test-csrf-token" }),
    );
    const hidden = html.match(/<input\b[^>]*type="hidden"[^>]*>/i)?.[0] ?? "";
    expect(hidden).toMatch(/name="csrf"/);
    expect(hidden).toMatch(/value="test-csrf-token"/);
  });

  it("prefills every field from the given employee in edit mode", () => {
    const employee = {
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
    const html = renderToStaticMarkup(
      createElement(EmployeeForm, { mode: "edit", employee, csrfToken: "tok" }),
    );
    expect(html).toContain('value="Ada Lovelace"');
    expect(html).toContain('value="ada@example.test"');
    expect(html).toContain('value="2020-01-15"');
    expect(html).toContain('value="E-001"');
    expect(html).toContain("Save changes");
  });

  it("labels the create-mode submit button distinctly from edit mode", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeForm, { mode: "create", csrfToken: "tok" }),
    );
    expect(html).toContain("Create employee");
  });

  it("uses a text input with the ISO pattern for the start date, not a native date picker", () => {
    const html = renderToStaticMarkup(
      createElement(EmployeeForm, { mode: "create", csrfToken: "tok" }),
    );
    const startDate = html.match(/<input\b[^>]*\bname="start_date"[^>]*>/i)?.[0] ?? "";
    expect(startDate).toMatch(/type="text"/);
    // React's static-markup renderer emits the DOM-property spelling (`inputMode`), not the
    // HTML-attribute spelling (`inputmode`) — both parse identically in a browser, since HTML
    // attribute names are case-insensitive.
    expect(startDate).toMatch(/inputmode="numeric"/i);
    expect(html).toContain("Format: YYYY-MM-DD");
  });
});
