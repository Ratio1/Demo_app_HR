"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Relative, not `@/server/...` — see EmployeeForm.tsx's identical import for why (this
// component is unit-tested directly and plain vitest has no tsconfig-paths resolution).
import { CSRF_FIELD_NAME, type HrEmployeeDTO } from "../../server/dto/employees.ts";

import { Banner } from "./Banner";

/**
 * The activate/deactivate control on the employee editor (slice-2 brief: "activate/deactivate
 * button with consequence copy"). The copy is always visible next to the button, not gated
 * behind a confirmation dialog — tokens.md §5.9 specifies a `<dialog>` for this action, but the
 * brief's own wording for this slice names only "button with consequence copy"; recorded as a
 * deviation in the slice 2 part C report rather than guessed into a modal the brief never asked
 * for.
 *
 * Consequence copy is the brief's own sentence verbatim, not the longer spec §2 wording tokens.md
 * quotes for a future dialog — the brief is this slice's authority.
 */
type ControlState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "stale" }
  | { readonly status: "last_admin" }
  | { readonly status: "error"; readonly message: string };

const GENERIC_UNAVAILABLE = "We can't reach the database right now. Try again shortly.";

export function EmployeeStatusControl({
  employee,
  csrfToken,
}: {
  employee: HrEmployeeDTO;
  csrfToken: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<ControlState>({ status: "idle" });

  const nextAction: "activate" | "deactivate" = employee.active ? "deactivate" : "activate";

  async function handleSubmit(event: { preventDefault(): void }) {
    event.preventDefault();
    setState({ status: "submitting" });

    let response: Response;
    try {
      response = await fetch(`/api/employees/${employee.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: nextAction,
          version: employee.version,
          [CSRF_FIELD_NAME]: csrfToken,
        }),
      });
    } catch {
      setState({ status: "error", message: GENERIC_UNAVAILABLE });
      return;
    }

    if (response.status === 200) {
      const payload = (await response.json().catch(() => null)) as { location?: string } | null;
      if (payload?.location) {
        router.push(payload.location);
        router.refresh();
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

    if (response.status === 409 && payload?.error === "conflict_last_admin") {
      setState({ status: "last_admin" });
      return;
    }
    if (response.status === 409) {
      setState({ status: "stale" });
      return;
    }
    if (response.status === 403) {
      setState({ status: "error", message: "You don't have access to do that." });
      return;
    }
    setState({ status: "error", message: GENERIC_UNAVAILABLE });
  }

  const busy = state.status === "submitting";

  return (
    <form className="consequence-panel mt-lg" onSubmit={(event) => void handleSubmit(event)}>
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      <p className="text-body text-text-secondary">
        {employee.active
          ? "Deactivating signs the person out, hides them from the directory and cancels their pending leave."
          : "Activating restores this person's directory listing. Their login stays disabled until re-enabled by an administrator."}
      </p>

      {state.status === "stale" ? (
        <div className="mt-sm">
          <Banner state="stale">
            This record changed — reload to see the current values.
          </Banner>
        </div>
      ) : null}
      {state.status === "last_admin" ? (
        <div className="mt-sm">
          <Banner state="invalid">
            This is the last active HR administrator account, so it cannot be deactivated.
          </Banner>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="mt-sm">
          <Banner state="db-unavailable">{state.message}</Banner>
        </div>
      ) : null}

      <button
        type="submit"
        className={`btn ${employee.active ? "btn--destructive" : "btn--secondary"} mt-sm`}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy ? "Saving…" : employee.active ? "Deactivate" : "Activate"}
      </button>
    </form>
  );
}
