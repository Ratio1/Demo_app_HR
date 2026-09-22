import type { SVGProps } from "react";

/**
 * Decorative icons, inlined as real SVG markup (never `<img>`/`next/image`, both forbidden —
 * see eslint.config.mjs and tokens.md §5.5's inlining rule) so a single file can be recoloured
 * with `currentColor` from the surrounding text colour, with no `style` attribute anywhere.
 * Markup copied verbatim from the committed files in `src/assets/icons/`; only the attribute
 * casing changed for JSX (`stroke-width` → `strokeWidth`, etc.). Every icon here is
 * `aria-hidden="true"` and carries no accessible name of its own — the control that hosts it
 * supplies the name (tokens.md §5.1/§5.13).
 */

function iconProps(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.75,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    focusable: "false",
    "aria-hidden": "true",
    ...props,
  };
}

/** src/assets/icons/nav-overview.svg */
export function NavOverviewIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  );
}

/** src/assets/icons/nav-profile.svg */
export function NavProfileIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c0-4.5 3.5-7.5 7-7.5s7 3 7 7.5" />
    </svg>
  );
}

/** src/assets/icons/action-logout.svg */
export function ActionLogoutIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M10 4 H6 a1 1 0 0 0 -1 1 v14 a1 1 0 0 0 1 1 h4" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <polyline points="16,8 20,12 16,16" />
    </svg>
  );
}

/** src/assets/icons/state-loading.svg */
export function StateLoadingIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 4 a8 8 0 1 1 -5.66 2.34" />
    </svg>
  );
}

/** src/assets/icons/state-invalid.svg */
export function StateInvalidIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M12 3.5 L21.5 20 L2.5 20 Z" />
      <line x1="12" y1="10" x2="12" y2="14" />
      <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** src/assets/icons/state-forbidden.svg */
export function StateForbiddenIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="9" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  );
}

/** src/assets/icons/state-db-unavailable.svg */
export function StateDbUnavailableIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <ellipse cx="12" cy="6" rx="7" ry="3" />
      <path d="M5 6 v6 a7 3 0 0 0 14 0 V6" />
      <path d="M5 12 v6 a7 3 0 0 0 14 0 v-6" />
      <line x1="4" y1="20" x2="20" y2="4" />
    </svg>
  );
}
