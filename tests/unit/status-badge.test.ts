import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "../../src/app/_components/StatusBadge.js";

/**
 * tokens.md §5.7: icon + text label, never colour alone (R7-09) — every status renders a
 * distinct label string a screen reader announces, not only a `data-status` attribute a CSS
 * rule colours.
 */
describe("StatusBadge", () => {
  it.each([
    ["pending", "Pending"],
    ["approved", "Approved"],
    ["rejected", "Rejected"],
    ["cancelled", "Cancelled"],
  ] as const)("renders %s as data-status=%s with a %s label and an icon", (status, label) => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status }));
    expect(html).toContain(`data-status="${status}"`);
    expect(html).toContain(`>${label}<`);
    expect(html).toContain("<svg");
    expect(html).toContain('aria-hidden="true"');
  });

  it("never renders a link, button or other interactive control", () => {
    const html = renderToStaticMarkup(createElement(StatusBadge, { status: "approved" }));
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<button");
  });
});
