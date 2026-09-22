import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ConfirmDialog } from "../../src/app/_components/ConfirmDialog.js";

/**
 * Static-markup assertions only (no jsdom in this project — see login-form.test.ts's own
 * comment): `showModal()`/focus-return are real browser behaviour this suite cannot exercise,
 * but the initial markup's ARIA wiring and the primary/cancel button contract (tokens.md §5.9)
 * are checked here.
 */
describe("ConfirmDialog markup", () => {
  it("wires aria-labelledby/aria-describedby to the title and body ids", () => {
    const html = renderToStaticMarkup(
      createElement(
        ConfirmDialog,
        {
          id: "cancel-leave",
          open: false,
          title: "Cancel this request?",
          confirmLabel: "Cancel request",
          variant: "destructive",
          onConfirm: () => {},
          onClose: () => {},
        },
        "This cannot be undone.",
      ),
    );
    expect(html).toContain('id="cancel-leave"');
    expect(html).toContain('aria-labelledby="cancel-leave-title"');
    expect(html).toContain('aria-describedby="cancel-leave-body"');
    expect(html).toContain('id="cancel-leave-title"');
    expect(html).toContain('id="cancel-leave-body"');
    expect(html).toContain("This cannot be undone.");
  });

  it("puts Cancel before the primary action in DOM order, both times", () => {
    const html = renderToStaticMarkup(
      createElement(
        ConfirmDialog,
        {
          id: "approve-leave",
          open: false,
          title: "Approve this request?",
          confirmLabel: "Approve",
          variant: "primary",
          onConfirm: () => {},
          onClose: () => {},
        },
        "5 weekdays (Mon–Fri), illustrative only.",
      ),
    );
    const cancelIndex = html.indexOf(">Cancel<");
    const confirmIndex = html.indexOf(">Approve<");
    expect(cancelIndex).toBeGreaterThan(-1);
    expect(confirmIndex).toBeGreaterThan(cancelIndex);
    expect(html).toContain("btn--primary");
    expect(html).not.toContain("btn--destructive");
  });

  it("uses btn--destructive for the destructive variant", () => {
    const html = renderToStaticMarkup(
      createElement(
        ConfirmDialog,
        {
          id: "reject-leave",
          open: false,
          title: "Reject this request?",
          confirmLabel: "Reject",
          variant: "destructive",
          onConfirm: () => {},
          onClose: () => {},
        },
        "The requester will see this as rejected.",
      ),
    );
    expect(html).toContain("btn--destructive");
  });

  it("shows a busy label and aria-busy on the dialog and the primary button while submitting", () => {
    const html = renderToStaticMarkup(
      createElement(
        ConfirmDialog,
        {
          id: "approve-leave",
          open: false,
          title: "Approve this request?",
          confirmLabel: "Approve",
          variant: "primary",
          busy: true,
          onConfirm: () => {},
          onClose: () => {},
        },
        "body",
      ),
    );
    expect(html).toMatch(/<dialog[^>]*aria-busy="true"/);
    expect(html).toContain(">Saving…<");
  });

  it("carries an icon-only close button labelled Close", () => {
    const html = renderToStaticMarkup(
      createElement(
        ConfirmDialog,
        {
          id: "cancel-leave",
          open: false,
          title: "Cancel this request?",
          confirmLabel: "Cancel request",
          variant: "destructive",
          onConfirm: () => {},
          onClose: () => {},
        },
        "body",
      ),
    );
    expect(html).toContain('aria-label="Close"');
  });
});
