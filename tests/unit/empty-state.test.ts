import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { EmptyState } from "../../src/app/_components/EmptyState.js";
import { EmptyDirectoryIcon } from "../../src/app/_components/icons.js";

describe("EmptyState", () => {
  it("renders the illustration, heading, body and the one action, data-state=empty by default", () => {
    const html = renderToStaticMarkup(
      createElement(
        EmptyState,
        { illustration: EmptyDirectoryIcon, heading: "No colleagues yet" },
        "There's nothing here yet.",
      ),
    );
    expect(html).toContain('data-state="empty"');
    expect(html).toContain('role="status"');
    expect(html).toContain("No colleagues yet");
    expect(html).toContain("There&#x27;s nothing here yet.");
  });

  it("switches to data-state=no-results for the paging-past-the-end variant", () => {
    const html = renderToStaticMarkup(
      createElement(
        EmptyState,
        { illustration: EmptyDirectoryIcon, heading: "No results", variant: "no-results" },
        "Nothing on this page.",
      ),
    );
    expect(html).toContain('data-state="no-results"');
  });

  it("renders the supplied action node", () => {
    const html = renderToStaticMarkup(
      createElement(
        EmptyState,
        {
          illustration: EmptyDirectoryIcon,
          heading: "No colleagues yet",
          action: createElement(
            "button",
            { type: "button", className: "btn btn--primary" },
            "Add employee",
          ),
        },
        "There's nothing here yet.",
      ),
    );
    expect(html).toContain("Add employee");
  });
});
