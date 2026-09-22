import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NavMenuList, type NavItem } from "../../src/app/_components/NavMenuList.js";
import { NavLeaveIcon, NavOverviewIcon } from "../../src/app/_components/icons.js";

/**
 * tokens.md §5.13: `aria-current="page"` on the current entry, and — new this slice — a
 * `<1024px` collapse toggle wired via `aria-expanded`/`aria-controls`. The list starts open
 * (`data-open="true"`) in server-rendered markup, so navigation still works before hydration
 * (see the component's own doc comment).
 */
describe("NavMenuList markup", () => {
  // `icon` is an element, matching what AppNav passes across the RSC boundary — a component
  // reference is not serializable there and no longer typechecks (NavMenuList's NavItem doc).
  const items: NavItem[] = [
    { href: "/", label: "Overview", icon: createElement(NavOverviewIcon), current: true },
    { href: "/leave", label: "My leave", icon: createElement(NavLeaveIcon), current: false },
  ];

  it("marks only the current entry with aria-current=page", () => {
    const html = renderToStaticMarkup(createElement(NavMenuList, { items }));
    const overviewLink = html.match(/<a\b[^>]*href="\/"[^>]*>/)?.[0] ?? "";
    const leaveLink = html.match(/<a\b[^>]*href="\/leave"[^>]*>/)?.[0] ?? "";
    expect(overviewLink).toContain('aria-current="page"');
    expect(leaveLink).not.toContain("aria-current");
  });

  it("renders the list open by default and wires the toggle to it", () => {
    const html = renderToStaticMarkup(createElement(NavMenuList, { items }));
    expect(html).toContain('data-open="true"');
    expect(html).toMatch(/<button[^>]*aria-expanded="true"/);
    const controls = html.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });

  it("renders each entry's icon element inside its link", () => {
    const html = renderToStaticMarkup(createElement(NavMenuList, { items }));
    const linkedIcons = html.match(/<a\b[^>]*class="app-nav__link"[^>]*><svg\b/g) ?? [];
    expect(linkedIcons).toHaveLength(items.length);
    expect(html).toContain('aria-hidden="true"');
  });

  it("labels the toggle button Menu", () => {
    const html = renderToStaticMarkup(createElement(NavMenuList, { items }));
    expect(html).toContain(">Menu<");
  });
});
