import type { Metadata } from "next";
import type { ReactNode } from "react";

import "./globals.css";

/**
 * Root layout — session-free by design (access-matrix R2: "the session resolver never runs
 * in a layout"). It owns exactly three things: the skip link (tokens.md §5.12, first
 * focusable element in <body>), the system font stack (applied to <body> in globals.css) and
 * the page shell every route — including the unauthenticated /login — renders inside.
 *
 * The role-aware navigation list and the logout form (tokens.md §5.13) are NOT rendered here:
 * they need the current session (email, role, csrf token), which only an authenticated page
 * can read without turning this layout into an authorization boundary. `/` and `/me` render
 * the shared <AppNav> component themselves. See the slice 1 part C report for this reading of
 * "nav shell".
 */
export const metadata: Metadata = {
  title: "Demo_App_HR",
  description: "Minimal HR demo application.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main-content" className="skip-link">
          Skip to main content
        </a>
        <header className="border-b border-divider">
          <div className="mx-auto max-w-5xl px-md py-sm">
            <span className="text-heading-sm font-semibold text-text-primary">Demo_App_HR</span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
