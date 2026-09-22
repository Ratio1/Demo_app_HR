import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Avatar } from "../../src/app/_components/Avatar.js";

/**
 * tokens.md §5.10: initials only, never a portrait; `role="img"` with the accessible name on
 * the outer span, initials text `aria-hidden` (the name is already given once, programmatically
 * — repeating it as visible+announced text would double-announce it to a screen reader).
 */
describe("Avatar", () => {
  it("carries the full name as the one accessible name, via role=img", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { fullName: "Ada Lovelace" }));
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Ada Lovelace"');
  });

  it("renders the initials as decorative (aria-hidden) text", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { fullName: "Ada Lovelace" }));
    const initialsMatch = html.match(/<span class="avatar__initials"[^>]*>([^<]*)<\/span>/);
    expect(initialsMatch?.[0]).toContain('aria-hidden="true"');
    expect(initialsMatch?.[1]).toBe("AL");
  });

  it("defaults to the 32px row/card size and accepts the 56px detail-header size", () => {
    const defaultHtml = renderToStaticMarkup(createElement(Avatar, { fullName: "Ada Lovelace" }));
    expect(defaultHtml).toContain('data-size="32"');

    const largeHtml = renderToStaticMarkup(
      createElement(Avatar, { fullName: "Ada Lovelace", size: 56 }),
    );
    expect(largeHtml).toContain('data-size="56"');
  });

  it("never renders an <img> tag (no remote portraits, R7-10)", () => {
    const html = renderToStaticMarkup(createElement(Avatar, { fullName: "Ada Lovelace" }));
    expect(html).not.toContain("<img");
  });
});
