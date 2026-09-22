"use client";

import { useEffect, useRef, type ReactNode } from "react";

import { ActionCloseIcon } from "./icons";

/**
 * tokens.md §5.9 — the one dialog/confirm component, shared by leave cancellation (S8) and HR
 * approve/reject (S9). Native `<dialog>` via `showModal()`/`close()`: the focus trap and
 * Escape-to-close are both browser-native behaviour, not reimplemented here.
 *
 * The one thing the native element does not guarantee across browsers is *which* element
 * regains focus on close, so this component captures `document.activeElement` itself the
 * moment it opens and explicitly refocuses it when it closes, rather than trusting the platform
 * default (tokens.md §5.9: "focus... returns to the control that opened it").
 *
 * Fully controlled by the caller (`open`/`onClose`/`onConfirm`/`busy`): the caller owns the
 * request lifecycle (idle/submitting/error) exactly as `EmployeeForm`/`EmployeeStatusControl`
 * do for a plain form, so an error keeps the dialog open with the caller's own inline banner as
 * part of `children`, and success sets `open={false}` and navigates.
 */
export function ConfirmDialog({
  id,
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  variant,
  busy = false,
  onConfirm,
  onClose,
}: {
  id: string;
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant: "primary" | "destructive";
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    if (open && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  function handleClose() {
    onClose();
    openerRef.current?.focus();
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog"
      id={id}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-body`}
      aria-busy={busy || undefined}
      onClose={handleClose}
    >
      <div className="dialog__header">
        <h2 id={`${id}-title`} className="dialog__title">
          {title}
        </h2>
        <button
          type="button"
          className="dialog__close"
          aria-label="Close"
          onClick={handleClose}
          disabled={busy}
        >
          <ActionCloseIcon />
        </button>
      </div>
      <div id={`${id}-body`} className="dialog__body">
        {children}
      </div>
      <div className="dialog__footer">
        <button
          type="button"
          className="btn btn--secondary"
          onClick={handleClose}
          disabled={busy}
        >
          {cancelLabel}
        </button>
        <button
          type="button"
          className={`btn ${variant === "destructive" ? "btn--destructive" : "btn--primary"}`}
          onClick={onConfirm}
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {busy ? "Saving…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
