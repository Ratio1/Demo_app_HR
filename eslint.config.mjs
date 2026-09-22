import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Project rules that encode decisions taken in the slice 1 brief, so a later change
 * that breaks one of them fails `npm run lint` instead of review.
 *
 *  - no `'use server'`            spec §3: mutations are Node-runtime Route Handlers only.
 *  - no `style` JSX attribute     ruling R-H: `style-src 'self'`, so no inline styles anywhere.
 *  - no `next/image`              `images: { unoptimized: true }`; the UI uses the committed SVGs.
 *  - no `NEXT_PUBLIC_*`           spec §4: the five DB_* variables are the only configuration.
 *  - `pg` only under src/server/db/**   spec §3/§5: one data layer, no ad-hoc clients.
 *  - no `server-only` under src/server/**  ruling O1: the `manage` CLI shares those modules.
 */
const forbiddenImports = {
  nextImage: {
    name: "next/image",
    message:
      "next/image is forbidden: images are unoptimized and the UI uses the committed SVGs in src/assets/icons/.",
  },
  pg: {
    name: "pg",
    message: "`pg` may only be imported under src/server/db/** — use the pool/repository modules.",
  },
  serverOnly: {
    name: "server-only",
    message:
      "`server-only` must not be imported under src/server/** (ruling O1): the `manage` CLI shares these modules.",
  },
};

const restrictedSyntax = [
  {
    selector: "ExpressionStatement[directive='use server']",
    message:
      "Server Actions/Functions are forbidden (spec §3): use a Node-runtime Route Handler under src/app/api/**.",
  },
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/^NEXT_PUBLIC_/]",
    message:
      "NEXT_PUBLIC_* variables are forbidden (spec §4): the only configuration is DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.",
  },
  {
    selector:
      "MemberExpression[object.object.name='process'][object.property.name='env'][property.value=/^NEXT_PUBLIC_/]",
    message:
      "NEXT_PUBLIC_* variables are forbidden (spec §4): the only configuration is DB_SERVER, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME.",
  },
  {
    selector: "JSXAttribute[name.name='style']",
    message:
      "Inline styles are forbidden (ruling R-H, CSP `style-src 'self'`): use a Tailwind class or the shared stylesheet.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "coverage/**",
    "test-results/**",
    "playwright-report/**",
    "next-env.d.ts",
  ]),
  {
    name: "demo-app-hr/project-rules",
    // Pinned explicitly: the eslint-plugin-react bundled with eslint-config-next 16.3.5
    // detects the React version through an ESLint 9 context API that ESLint 10 removed, and
    // crashes on every file unless the version is given here.
    settings: { react: { version: "19.3.0" } },
    rules: {
      "no-restricted-syntax": ["error", ...restrictedSyntax],
      "no-restricted-imports": [
        "error",
        { paths: [forbiddenImports.nextImage, forbiddenImports.pg] },
      ],
    },
  },
  {
    name: "demo-app-hr/server-modules",
    files: ["src/server/**/*.ts", "src/server/**/*.tsx"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [forbiddenImports.nextImage, forbiddenImports.pg, forbiddenImports.serverOnly],
        },
      ],
    },
  },
  {
    name: "demo-app-hr/data-layer",
    files: ["src/server/db/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [forbiddenImports.nextImage, forbiddenImports.serverOnly] },
      ],
    },
  },
]);

export default eslintConfig;
