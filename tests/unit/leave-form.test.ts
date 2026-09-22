import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const { LeaveForm } = await import("../../src/app/_components/LeaveForm.js");
const { LEAVE_CONSEQUENCE_COPY } = await import("../../src/server/dto/leave.js");

/**
 * Static-markup assertions only (no jsdom — see login-form.test.ts's own comment), following
 * `EmployeeForm`'s test pattern: field names/ids the server contract expects
 * (`src/server/dto/leave.ts`'s `LEAVE_FORM_FIELDS`/`LEAVE_KINDS`), the hidden `csrf` field, and
 * the ISO-pattern date inputs (never a native date picker, tokens.md §5.3).
 */
describe("LeaveForm markup", () => {
  it("renders the kind select with exactly the two allowed options", () => {
    const html = renderToStaticMarkup(createElement(LeaveForm, { csrfToken: "tok" }));
    expect(html).toMatch(/<select\b[^>]*id="leave-kind"[^>]*name="kind"/);
    expect(html).toContain("Annual leave");
    expect(html).toContain("Personal leave");
    expect(html).not.toContain("Medical");
  });

  it("renders both date inputs as ISO-pattern text fields, not a native date picker", () => {
    const html = renderToStaticMarkup(createElement(LeaveForm, { csrfToken: "tok" }));
    const start = html.match(/<input\b[^>]*\bname="start_date"[^>]*>/i)?.[0] ?? "";
    const end = html.match(/<input\b[^>]*\bname="end_date"[^>]*>/i)?.[0] ?? "";
    for (const input of [start, end]) {
      expect(input).toMatch(/type="text"/);
      expect(input).toMatch(/inputmode="numeric"/i);
    }
    expect(html).toContain("Format: YYYY-MM-DD");
  });

  it("carries the csrf token as a hidden field", () => {
    const html = renderToStaticMarkup(createElement(LeaveForm, { csrfToken: "test-csrf-token" }));
    const hidden = html.match(/<input\b[^>]*type="hidden"[^>]*>/i)?.[0] ?? "";
    expect(hidden).toMatch(/name="csrf"/);
    expect(hidden).toMatch(/value="test-csrf-token"/);
  });

  it("shows the overlap consequence copy near the submit button", () => {
    const html = renderToStaticMarkup(createElement(LeaveForm, { csrfToken: "tok" }));
    expect(html).toContain(LEAVE_CONSEQUENCE_COPY.overlap);
  });

  it("shows no weekday-count line before any date has been entered", () => {
    const html = renderToStaticMarkup(createElement(LeaveForm, { csrfToken: "tok" }));
    expect(html).not.toContain("illustrative");
  });

  it("labels the submit button", () => {
    const html = renderToStaticMarkup(createElement(LeaveForm, { csrfToken: "tok" }));
    expect(html).toContain("Submit request");
  });
});
