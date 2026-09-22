import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const { ApprovalDecisionControl } = await import(
  "../../src/app/_components/ApprovalDecisionControl.js"
);
const { LEAVE_CONSEQUENCE_COPY } = await import("../../src/server/dto/leave.js");

const baseRequest = {
  id: "22222222-2222-2222-2222-222222222222",
  employee: { code: "E-002", full_name: "Grace Hopper", department: "Engineering" },
  kind: "personal" as const,
  start_date: "2026-04-06",
  end_date: "2026-04-08",
  weekdays: 3,
  status: "pending" as const,
  created_at: "2026-04-01T00:00:00.000Z",
  version: 1,
  own: false,
};

/**
 * Slice-3 brief: self-approval "the button is not rendered for them" — this component's own
 * defence for that rule (the server's is the authoritative `403`). `own: true` replaces both
 * buttons with `LEAVE_CONSEQUENCE_COPY.ownRequest`; `own: false` renders both, each behind its
 * own confirm dialog carrying the illustrative-duration and finality copy (tokens.md §5.9).
 */
describe("ApprovalDecisionControl markup", () => {
  it("renders no Approve/Reject button for the admin's own request", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionControl, {
        request: { ...baseRequest, own: true },
        csrfToken: "tok",
      }),
    );
    expect(html).not.toContain("<button");
    expect(html).toContain(LEAVE_CONSEQUENCE_COPY.ownRequest);
  });

  it("renders Approve and Reject buttons for another employee's request", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionControl, { request: baseRequest, csrfToken: "tok" }),
    );
    expect(html).toContain(">Approve<");
    expect(html).toContain(">Reject<");
    expect(html).toContain("btn--primary");
    expect(html).toContain("btn--destructive");
  });

  it("wires one confirm dialog per action, each keyed to this request", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionControl, { request: baseRequest, csrfToken: "tok" }),
    );
    expect(html).toContain(`id="decision-approve-${baseRequest.id}"`);
    expect(html).toContain(`id="decision-reject-${baseRequest.id}"`);
  });

  it("states the illustrative weekday count and the finality copy in each dialog", () => {
    const html = renderToStaticMarkup(
      createElement(ApprovalDecisionControl, { request: baseRequest, csrfToken: "tok" }),
    );
    expect(html).toContain("3 weekdays (Mon–Fri), illustrative only");
    expect(html).toContain(LEAVE_CONSEQUENCE_COPY.approve);
    expect(html).toContain(LEAVE_CONSEQUENCE_COPY.reject);
  });
});
