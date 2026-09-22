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

/** Empty-state illustrations (tokens.md §5.11) ship at a 160x160 viewBox, strokeWidth 3. */
function illustrationProps(props: SVGProps<SVGSVGElement>): SVGProps<SVGSVGElement> {
  return {
    viewBox: "0 0 160 160",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 3,
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

/** src/assets/icons/state-stale.svg */
export function StateStaleIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4.5 12 a7.5 7.5 0 0 1 13-5.3" />
      <polyline points="17.5,3.5 17.5,7.7 13.3,7.7" />
      <path d="M19.5 12 a7.5 7.5 0 0 1 -13 5.3" />
      <polyline points="6.5,20.5 6.5,16.3 10.7,16.3" />
    </svg>
  );
}

/** src/assets/icons/state-empty.svg */
export function StateEmptyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M3 9 l2-5 h14 l2 5" />
      <path d="M3 9 v9 a1 1 0 0 0 1 1 h16 a1 1 0 0 0 1-1 V9" />
      <line x1="3" y1="9" x2="9" y2="9" />
      <line x1="15" y1="9" x2="21" y2="9" />
    </svg>
  );
}

/** src/assets/icons/state-no-results.svg */
export function StateNoResultsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="10" cy="10" r="6" />
      <line x1="14.5" y1="14.5" x2="20" y2="20" />
      <line x1="7.5" y1="10" x2="12.5" y2="10" />
    </svg>
  );
}

/** src/assets/icons/nav-directory.svg */
export function NavDirectoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="5" cy="7" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="5" cy="17" r="1" fill="currentColor" stroke="none" />
      <line x1="9" y1="7" x2="20" y2="7" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="17" x2="20" y2="17" />
    </svg>
  );
}

/** src/assets/icons/nav-employees.svg */
export function NavEmployeesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="8.5" cy="11" r="2" />
      <path d="M6 15.5c0-1.7 1.2-2.5 2.5-2.5s2.5 0.8 2.5 2.5" />
      <line x1="13" y1="9.5" x2="18" y2="9.5" />
      <line x1="13" y1="13" x2="18" y2="13" />
    </svg>
  );
}

/** src/assets/icons/action-add.svg */
export function ActionAddIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

/** src/assets/icons/action-edit.svg */
export function ActionEditIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <path d="M4 20 L4.8 16 L15 6 L18 9 L8 19.2 Z" />
      <line x1="13" y1="7.5" x2="16" y2="10.5" />
    </svg>
  );
}

/** src/assets/icons/action-chevron-right.svg */
export function ActionChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <polyline points="9,5 16,12 9,19" />
    </svg>
  );
}

/** src/assets/icons/avatar-frame.svg */
export function AvatarFrameIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...iconProps(props)}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  );
}

/** src/assets/icons/empty-directory.svg */
export function EmptyDirectoryIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...illustrationProps(props)}>
      <path d="M20 64 L20 54 L54 54 L64 68 L140 68 L140 132 L20 132 Z" />
      <line x1="40" y1="90" x2="120" y2="90" strokeOpacity="0.5" />
      <line x1="40" y1="104" x2="105" y2="104" strokeOpacity="0.5" />
      <line x1="40" y1="118" x2="90" y2="118" strokeOpacity="0.5" />
    </svg>
  );
}

/** src/assets/icons/empty-employees.svg */
export function EmptyEmployeesIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...illustrationProps(props)}>
      <circle cx="55" cy="62" r="16" strokeOpacity="0.55" />
      <path d="M27 138 v-14 c0-18 12-29 28-29 s28 11 28 29 v14" strokeOpacity="0.55" />
      <circle cx="104" cy="68" r="18" />
      <path d="M70 140 v-12 c0-20 15-32 34-32 s34 12 34 32 v12" />
    </svg>
  );
}

/** src/assets/icons/empty-no-results.svg */
export function EmptyNoResultsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...illustrationProps(props)}>
      <circle cx="64" cy="64" r="34" />
      <line x1="88" y1="88" x2="126" y2="126" />
      <line x1="48" y1="64" x2="80" y2="64" />
      <circle cx="28" cy="122" r="3" fill="currentColor" stroke="none" fillOpacity="0.4" />
      <circle cx="122" cy="30" r="2.5" fill="currentColor" stroke="none" fillOpacity="0.4" />
      <circle cx="112" cy="118" r="2" fill="currentColor" stroke="none" fillOpacity="0.4" />
    </svg>
  );
}
