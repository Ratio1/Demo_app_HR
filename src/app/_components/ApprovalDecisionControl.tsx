"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  CSRF_FIELD_NAME,
  LEAVE_CONSEQUENCE_COPY,
  type ApprovalDTO,
  type LeaveDecision,
} from "../../server/dto/leave.ts";

import { ActionApproveIcon, ActionRejectIcon } from "./icons";
import { Banner } from "./Banner";
import { ConfirmDialog } from "./ConfirmDialog";

/**
 * The approve/reject controls on a pending row of `/approvals` (slice-3 brief: "approve/reject
 * buttons with confirm + consequence copy"). Self-approval (spec §2: "an HR admin's request
 * needs a different HR admin; never bypass self-approval") is barred **server-side**
 * (`403 forbidden`) — this component's own defence is that it never renders a clickable button
 * for `request.own === true` at all, replacing both with the shared vocabulary's explanatory
 * copy (`LEAVE_CONSEQUENCE_COPY.ownRequest`) instead of a disabled-looking control, matching the
 * slice-3 brief's "own requests shown but disabled with 'a different HR admin must decide'" —
 * the *row* stays visible, only the decision affordance is replaced by text.
 */

type ControlState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "not_pending" }
  | { readonly status: "stale" }
  | { readonly status: "forbidden"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const GENERIC_UNAVAILABLE = "We can't reach the database right now. Try again shortly.";

const DIALOG_COPY: Record<
  LeaveDecision,
  { title: string; confirmLabel: string; variant: "primary" | "destructive" }
> = {
  approve: { title: "Approve this request?", confirmLabel: "Approve", variant: "primary" },
  reject: { title: "Reject this request?", confirmLabel: "Reject", variant: "destructive" },
};

export function ApprovalDecisionControl({
  request,
  csrfToken,
}: {
  request: ApprovalDTO;
  csrfToken: string;
}) {
  const router = useRouter();
  const [pendingAction, setPendingAction] = useState<LeaveDecision | null>(null);
  const [state, setState] = useState<ControlState>({ status: "idle" });

  async function handleConfirm(action: LeaveDecision) {
    setState({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch(`/api/leave/${request.id}/decision`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, version: request.version, [CSRF_FIELD_NAME]: csrfToken }),
      });
    } catch {
      setState({ status: "error", message: GENERIC_UNAVAILABLE });
      return;
    }

    if (response.status === 200) {
      const payload = (await response.json().catch(() => null)) as { location?: string } | null;
      if (payload?.location) {
        setState({ status: "idle" });
        setPendingAction(null);
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

    if (response.status === 409 && payload?.error === "conflict_not_pending") {
      setState({ status: "not_pending" });
      return;
    }
    if (response.status === 409 && payload?.error === "conflict_stale") {
      setState({ status: "stale" });
      return;
    }
    if (response.status === 403) {
      setState({ status: "forbidden", message: "You don't have access to do that." });
      return;
    }
    setState({ status: "error", message: GENERIC_UNAVAILABLE });
  }

  if (request.own) {
    return <p className="text-body text-text-secondary">{LEAVE_CONSEQUENCE_COPY.ownRequest}</p>;
  }

  const busy = state.status === "submitting";

  return (
    <>
      <div className="flex gap-sm">
        <button type="button" className="btn btn--primary" onClick={() => setPendingAction("approve")}>
          <ActionApproveIcon />
          <span>Approve</span>
        </button>
        <button
          type="button"
          className="btn btn--destructive"
          onClick={() => setPendingAction("reject")}
        >
          <ActionRejectIcon />
          <span>Reject</span>
        </button>
      </div>

      {(["approve", "reject"] as const).map((action) => (
        <ConfirmDialog
          key={action}
          id={`decision-${action}-${request.id}`}
          open={pendingAction === action}
          title={DIALOG_COPY[action].title}
          confirmLabel={DIALOG_COPY[action].confirmLabel}
          variant={DIALOG_COPY[action].variant}
          busy={busy && pendingAction === action}
          onConfirm={() => void handleConfirm(action)}
          onClose={() => setPendingAction(null)}
        >
          <p className="text-body text-text-primary">
            {request.weekdays} weekday{request.weekdays === 1 ? "" : "s"} (Mon–Fri), illustrative
            only — not a legal entitlement or accrual balance.
          </p>
          <p className="mt-sm text-body text-text-primary">{LEAVE_CONSEQUENCE_COPY[action]}</p>
          {state.status === "not_pending" ? (
            <div className="mt-md">
              <Banner state="stale" autoFocusOnLoad={false}>
                Already decided — reload.
              </Banner>
            </div>
          ) : null}
          {state.status === "stale" ? (
            <div className="mt-md">
              <Banner state="stale" autoFocusOnLoad={false}>
                This record changed — reload to see the current values.
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
      ))}
    </>
  );
}
