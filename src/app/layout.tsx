import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * Scaffold root layout. The themed shell - Tailwind theme from the design tokens, header,
 * navigation and the error boundaries - is added with the first screens.
 */
export const metadata: Metadata = {
  title: "Demo_App_HR",
  description: "Minimal HR demo application.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
