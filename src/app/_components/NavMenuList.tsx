"use client";

import { useId, useState, type ComponentType, type SVGProps } from "react";
import Link from "next/link";

import { ActionMenuIcon } from "./icons";

export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  current: boolean;
};

/**
 * tokens.md §5.13 — the collapsible primary nav. At ≥1024px (`--breakpoint-lg`, ruling R-L)
 * every entry is always visible and the toggle button (`action-menu.svg`) is hidden by CSS
 * (`.app-nav__toggle`, `@media (min-width: 64rem)`); below that the list starts open (server
 * markup renders `data-open="true"`, so the nav still works with JavaScript disabled/not yet
 * hydrated — no flash of hidden content) and this button collapses/expands it,
 * `aria-expanded`/`aria-controls` wired to the list's id.
 *
 * Deviation from tokens.md's literal wording, recorded here rather than left silent: the token
 * spec calls this a sliding "off-canvas panel"; this ships as an in-flow expand/collapse
 * (`display: none` ↔ `flex` on the same `<ul>`, `globals.css`) instead of a panel that animates
 * over the page content. It is still keyboard-trap-free (the token doc's own requirement — "a
 * `<nav>` region, not a modal"), keeps the identical `aria-current`/hover states of the expanded
 * desktop nav, and needs no new z-index/overlay layer or focus-trap logic under this slice's
 * time budget; NOT re-derived as a visual off-canvas panel, flagged for the design council.
 */
export function NavMenuList({ items }: { items: readonly NavItem[] }) {
  const [open, setOpen] = useState(true);
  const listId = useId();

  return (
    <nav aria-label="Primary">
      <button
        type="button"
        className="app-nav__toggle btn btn--quiet"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((current) => !current)}
      >
        <ActionMenuIcon />
        <span>Menu</span>
      </button>
      <ul id={listId} className="app-nav__list" data-open={open} role="list">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className="app-nav__link"
                aria-current={item.current ? "page" : undefined}
              >
                <Icon />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
