"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { CSRF_FIELD_NAME, LEAVE_CONSEQUENCE_COPY, type OwnLeaveDTO } from "../../server/dto/leave.ts";

import { ActionCancelIcon } from "./icons";
import { Banner } from "./Banner";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The cancel button on a pending row of `/leave`'s own history (slice-3 brief: "cancel button on
 * pending rows (confirm dialog with consequence copy)"). Only ever rendered by the caller for a
 * `status === "pending"` row that belongs to the viewer — the server re-checks both (owner,
 * `pending`) independently and answers `404`/`409 conflict_not_pending` if either has changed
 * since the page loaded.
 */

type ControlState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "not_pending" }
  | { readonly status: "not_found" }
  | { readonly status: "forbidden"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const GENERIC_UNAVAILABLE = "We can't reach the database right now. Try again shortly.";

export function LeaveCancelControl({ request, csrfToken }: { request: OwnLeaveDTO; csrfToken: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ControlState>({ status: "idle" });

  async function handleConfirm() {
    setState({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch(`/api/leave/${request.id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: request.version, [CSRF_FIELD_NAME]: csrfToken }),
      });
    } catch {
      setState({ status: "error", message: GENERIC_UNAVAILABLE });
      return;
    }

    if (response.status === 200) {
      const payload = (await response.json().catch(() => null)) as { location?: string } | null;
      if (payload?.location) {
        setState({ status: "idle" });
        setOpen(false);
        router.push(payload.location);
        return;
      }
      setState({ status: "error", message: GENERIC_UNAVAILABLE });
      return;
    }

    if (response.status === 401) {
      router.push("/login");
      return;
    }

    const payload = (await response.json().catch(() => null)) as { error?: string } | null;

    if (response.status === 404) {
      setState({ status: "not_found" });
      return;
    }
    if (response.status === 409 && payload?.error === "conflict_not_pending") {
      setState({ status: "not_pending" });
      return;
    }
    if (response.status === 403) {
      setState({ status: "forbidden", message: "You don't have access to do that." });
      return;
    }
    setState({ status: "error", message: GENERIC_UNAVAILABLE });
  }

  const busy = state.status === "submitting";

  return (
    <>
      <button
        type="button"
        className="btn btn--secondary"
        onClick={() => setOpen(true)}
        aria-label={`Cancel the ${request.start_date} to ${request.end_date} request`}
      >
        <ActionCancelIcon />
        <span>Cancel</span>
      </button>
      <ConfirmDialog
        id={`cancel-leave-${request.id}`}
        open={open}
        title="Cancel this request?"
        confirmLabel="Cancel request"
        variant="destructive"
        busy={busy}
        onConfirm={() => void handleConfirm()}
        onClose={() => setOpen(false)}
      >
        <p className="text-body text-text-primary">{LEAVE_CONSEQUENCE_COPY.cancel}</p>
        {state.status === "not_pending" ? (
          <div className="mt-md">
            <Banner state="stale" autoFocusOnLoad={false}>
              This request is no longer pending — reload to see its current status.
            </Banner>
          </div>
        ) : null}
        {state.status === "not_found" ? (
          <div className="mt-md">
            <Banner state="forbidden" autoFocusOnLoad={false}>
              This request could not be found.
            </Banner>
          </div>
        ) : null}
        {state.status === "forbidden" ? (
          <div className="mt-md">
            <Banner state="forbidden" autoFocusOnLoad={false}>
              {state.message}
            </Banner>
          </div>
        ) : null}
        {state.status === "error" ? (
          <div className="mt-md">
            <Banner state="db-unavailable" autoFocusOnLoad={false}>
              {state.message}
            </Banner>
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
