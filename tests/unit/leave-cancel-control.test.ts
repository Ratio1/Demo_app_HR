import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const { LeaveCancelControl } = await import("../../src/app/_components/LeaveCancelControl.js");
const { LEAVE_CONSEQUENCE_COPY } = await import("../../src/server/dto/leave.js");

const pendingRequest = {
  id: "11111111-1111-1111-1111-111111111111",
  kind: "annual" as const,
  start_date: "2026-03-02",
  end_date: "2026-03-06",
  weekdays: 5,
  status: "pending" as const,
  decided_at: null,
  version: 1,
};

/**
 * Slice-3 brief: "cancel button on pending rows (confirm dialog with consequence copy)". Native
 * `showModal()`/close behaviour is not exercisable without jsdom (see login-form.test.ts's own
 * comment); this checks the initial markup only.
 */
describe("LeaveCancelControl markup", () => {
  it("renders a labelled Cancel button", () => {
    const html = renderToStaticMarkup(
      createElement(LeaveCancelControl, { request: pendingRequest, csrfToken: "tok" }),
    );
    expect(html).toContain(">Cancel<");
    expect(html).toMatch(/aria-label="Cancel the 2026-03-02 to 2026-03-06 request"/);
  });

  it("carries the cancel consequence copy inside the confirm dialog", () => {
    const html = renderToStaticMarkup(
      createElement(LeaveCancelControl, { request: pendingRequest, csrfToken: "tok" }),
    );
    expect(html).toContain(LEAVE_CONSEQUENCE_COPY.cancel);
  });

  it("wires the dialog id to this request", () => {
    const html = renderToStaticMarkup(
      createElement(LeaveCancelControl, { request: pendingRequest, csrfToken: "tok" }),
    );
    expect(html).toContain(`id="cancel-leave-${pendingRequest.id}"`);
  });
});
