"use client";

import { useMemo, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  CSRF_FIELD_NAME,
  LEAVE_CONSEQUENCE_COPY,
  LEAVE_KINDS,
  LEAVE_KIND_LABELS,
  type FieldErrors,
  type LeaveKind,
  // Relative, not `@/server/...`: this is a client component that vitest unit-tests directly
  // (tests/unit/leave-form.test.ts), and the `@` path alias is a Next/tsc-only resolution that
  // plain vitest (no tsconfig-paths plugin configured) cannot follow — see EmployeeForm.tsx's
  // identical comment.
} from "../../server/dto/leave.ts";
import { isIsoDateString, validateLeaveRange } from "../../shared/dates.ts";

import { Banner } from "./Banner";

/**
 * The leave submit form (slice-3 brief: "submit form (kind select, two date inputs with
 * keyboard entry, live weekday count, consequence copy)"). The live count and the "no weekday
 * in range" refusal both come from `validateLeaveRange` in `src/shared/dates.ts` — the same
 * pure function the server calls before writing a row — so the two can never disagree (spec §2:
 * "the form shows the same count before submission").
 *
 * Success is `200 { ok, location }`, matching `EmployeeForm`'s own "why not the brief's 303"
 * reasoning: a `fetch` caller cannot read a native redirect's `Location` header, and the server
 * builds `location` itself (`savedLeaveLocation`, `src/server/dto/leave.ts`) — this component
 * never constructs a navigation target from user input.
 */

type FormValues = {
  kind: LeaveKind;
  start_date: string;
  end_date: string;
};

type SubmitState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "invalid"; readonly fields: FieldErrors; readonly summary?: string }
  | { readonly status: "overlap" }
  | { readonly status: "forbidden"; readonly message: string }
  | { readonly status: "error"; readonly message: string };

const GENERIC_UNAVAILABLE = "We can't reach the database right now. Try again shortly.";

function emptyValues(): FormValues {
  return { kind: "annual", start_date: "", end_date: "" };
}

export function LeaveForm({ csrfToken }: { csrfToken: string }) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(emptyValues());
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  const fieldErrors: FieldErrors = state.status === "invalid" ? state.fields : {};

  // Live weekday count (spec §2 / slice-3 brief): computed only once both dates parse as real
  // calendar dates, so a half-typed date never flashes a stale or nonsensical number.
  const range = useMemo(() => {
    if (!isIsoDateString(values.start_date) || !isIsoDateString(values.end_date)) {
      return null;
    }
    return validateLeaveRange(values.start_date, values.end_date);
  }, [values.start_date, values.end_date]);

  function update<K extends keyof FormValues>(key: K, value: FormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const body = { ...values, [CSRF_FIELD_NAME]: csrfToken };

    let response: Response;
    try {
      response = await fetch("/api/leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      setState({ status: "error", message: GENERIC_UNAVAILABLE });
      return;
    }

    if (response.status === 200) {
      const payload = (await response.json().catch(() => null)) as { location?: string } | null;
      if (payload?.location) {
        // Reset before navigating — see EmployeeForm.tsx's identical comment: a same-route push
        // can re-render this component in place rather than remount it.
        setState({ status: "idle" });
        setValues(emptyValues());
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

    const payload = (await response.json().catch(() => null)) as
      | { error?: string; fields?: FieldErrors }
      | null;

    if (response.status === 400 && payload?.fields) {
      setState({ status: "invalid", fields: payload.fields });
      return;
    }
    if (response.status === 400) {
      setState({ status: "invalid", fields: {}, summary: "Check the highlighted fields and try again." });
      return;
    }
    if (response.status === 403) {
      setState({ status: "forbidden", message: "You don't have access to do that." });
      return;
    }
    if (response.status === 409 && payload?.error === "conflict_overlap") {
      setState({ status: "overlap" });
      return;
    }
    if (response.status === 429) {
      const retryAfter = response.headers.get("Retry-After");
      setState({
        status: "invalid",
        fields: {},
        summary: retryAfter
          ? `Too many attempts. Try again in ${retryAfter} seconds.`
          : "Too many attempts. Try again shortly.",
      });
      return;
    }
    if (response.status === 413) {
      setState({ status: "invalid", fields: {}, summary: "That submission was too large." });
      return;
    }
    setState({ status: "error", message: GENERIC_UNAVAILABLE });
  }

  const busy = state.status === "submitting";

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />

      {state.status === "invalid" && state.summary ? (
        <div className="mb-lg">
          <Banner state="invalid">{state.summary}</Banner>
        </div>
      ) : null}
      {state.status === "overlap" ? (
        <div className="mb-lg">
          <Banner state="stale">{LEAVE_CONSEQUENCE_COPY.overlap}</Banner>
        </div>
      ) : null}
      {state.status === "forbidden" ? (
        <div className="mb-lg">
          <Banner state="forbidden">{state.message}</Banner>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="mb-lg">
          <Banner state="db-unavailable">{state.message}</Banner>
        </div>
      ) : null}

      <div className="field-row">
        <label htmlFor="leave-kind" className="field-label">
          Leave type
        </label>
        <span className="select-wrapper">
          <select
            id="leave-kind"
            name="kind"
            className="field field--select"
            value={values.kind}
            onChange={(event) => update("kind", event.target.value as LeaveKind)}
            aria-invalid={fieldErrors.kind ? true : undefined}
            aria-describedby={fieldErrors.kind ? "leave-kind-error" : undefined}
          >
            {LEAVE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {LEAVE_KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </span>
        {fieldErrors.kind ? (
          <p id="leave-kind-error" className="field__error" role="alert">
            {fieldErrors.kind}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="leave-start-date" className="field-label">
          Start date
        </label>
        <input
          id="leave-start-date"
          className="field field--date"
          name="start_date"
          type="text"
          inputMode="numeric"
          pattern="\d{4}-\d{2}-\d{2}"
          value={values.start_date}
          onChange={(event) => update("start_date", event.target.value)}
          required
          aria-invalid={fieldErrors.start_date ? true : undefined}
          aria-describedby="leave-start-date-hint leave-start-date-error"
        />
        <p id="leave-start-date-hint" className="field__hint">
          Format: YYYY-MM-DD
        </p>
        {fieldErrors.start_date ? (
          <p id="leave-start-date-error" className="field__error" role="alert">
            {fieldErrors.start_date}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="leave-end-date" className="field-label">
          End date
        </label>
        <input
          id="leave-end-date"
          className="field field--date"
          name="end_date"
          type="text"
          inputMode="numeric"
          pattern="\d{4}-\d{2}-\d{2}"
          value={values.end_date}
          onChange={(event) => update("end_date", event.target.value)}
          required
          aria-invalid={fieldErrors.end_date ? true : undefined}
          aria-describedby="leave-end-date-hint leave-end-date-error"
        />
        <p id="leave-end-date-hint" className="field__hint">
          Format: YYYY-MM-DD
        </p>
        {fieldErrors.end_date ? (
          <p id="leave-end-date-error" className="field__error" role="alert">
            {fieldErrors.end_date}
          </p>
        ) : null}
        {/* Live weekday count — polite, not an error: it only ever reports a valid range back;
            an invalid one (no weekday, end before start) is left to the server's own inline
            `field__error` above rather than duplicated here, so there is exactly one message
            per problem. */}
        {range?.ok ? (
          <p className="field__hint" role="status">
            {range.weekdays} weekday{range.weekdays === 1 ? "" : "s"} (Mon–Fri), illustrative
            only — not a legal entitlement or accrual balance.
          </p>
        ) : null}
      </div>

      <p className="mb-md text-body text-text-secondary">{LEAVE_CONSEQUENCE_COPY.overlap}</p>

      <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Submitting…" : "Submit request"}
      </button>
    </form>
  );
}
