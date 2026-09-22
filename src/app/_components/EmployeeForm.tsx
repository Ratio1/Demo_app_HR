"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  CODE_MAX_LENGTH,
  CSRF_FIELD_NAME,
  DEPARTMENT_MAX_LENGTH,
  NAME_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  WORK_EMAIL_MAX_LENGTH,
  type FieldErrors,
  type HrEmployeeDTO,
  // Relative, not `@/server/...`: this is a client component that vitest unit-tests directly
  // (tests/unit/employee-form.test.ts), and the `@` path alias is a Next/tsc-only resolution
  // that plain vitest (no tsconfig-paths plugin configured) cannot follow.
} from "../../server/dto/employees.ts";

import { Banner } from "./Banner";

/**
 * The employee create/edit form (slice-2 brief §"API": "forms submit with a small client
 * component using `fetch` (JSON), errors rendered inline"). Reads only types from
 * `@/server/dto/employees` (the brief's own boundary: "import types only") plus the field-name
 * and bound constants that module already exports for exactly this purpose (its own doc
 * comment: "a client component may import from it ... without dragging `pg` ... into a browser
 * bundle").
 *
 * Success is `200 { ok, location }`, not the brief's `303` — read from
 * `src/server/dto/employees.ts`'s own "Why `200` and not the brief's `303`" note (a `fetch`
 * caller cannot read a native `303`'s `Location`). The client navigates to the server-built
 * `location` itself; nothing here builds a redirect target from user input.
 */

type FormValues = {
  code: string;
  full_name: string;
  work_email: string;
  title: string;
  department: string;
  start_date: string;
};

type SubmitState =
  | { readonly status: "idle" }
  | { readonly status: "submitting" }
  | { readonly status: "invalid"; readonly fields: FieldErrors; readonly summary?: string }
  | { readonly status: "stale" }
  | { readonly status: "error"; readonly message: string };

function emptyValues(): FormValues {
  return { code: "", full_name: "", work_email: "", title: "", department: "", start_date: "" };
}

function valuesFromEmployee(employee: HrEmployeeDTO): FormValues {
  return {
    code: employee.code,
    full_name: employee.full_name,
    work_email: employee.work_email,
    title: employee.title,
    department: employee.department,
    start_date: employee.start_date,
  };
}

const GENERIC_UNAVAILABLE = "We can't reach the database right now. Try again shortly.";

export function EmployeeForm({
  mode,
  employee,
  csrfToken,
}: {
  mode: "create" | "edit";
  employee?: HrEmployeeDTO;
  csrfToken: string;
}) {
  const router = useRouter();
  const [values, setValues] = useState<FormValues>(
    employee ? valuesFromEmployee(employee) : emptyValues(),
  );
  const [state, setState] = useState<SubmitState>({ status: "idle" });

  const fieldErrors: FieldErrors = state.status === "invalid" ? state.fields : {};

  function update<K extends keyof FormValues>(key: K, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState({ status: "submitting" });

    const body: Record<string, string | number> = { ...values, [CSRF_FIELD_NAME]: csrfToken };
    if (mode === "edit" && employee) {
      body.version = employee.version;
    }
    const url = mode === "create" ? "/api/employees" : `/api/employees/${employee!.id}`;

    let response: Response;
    try {
      response = await fetch(url, {
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
      setState({ status: "error", message: "You don't have access to do that." });
      return;
    }
    if (response.status === 404) {
      setState({ status: "error", message: "That employee record could not be found." });
      return;
    }
    if (response.status === 409 && payload?.error === "conflict_stale") {
      setState({ status: "stale" });
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
      {/* Slice-2 brief: "CSRF token from the session in a hidden field" — kept as a real DOM
          field, matching slice 1's forms, even though the submit handler reads `csrfToken`
          from the closure rather than from `FormData` (both read the same session value). */}
      <input type="hidden" name={CSRF_FIELD_NAME} value={csrfToken} />
      {state.status === "invalid" && state.summary ? (
        <div className="mb-lg">
          <Banner state="invalid">{state.summary}</Banner>
        </div>
      ) : null}
      {state.status === "stale" ? (
        <div className="mb-lg">
          <Banner state="stale">
            This record changed — reload to see the current values.
          </Banner>
        </div>
      ) : null}
      {state.status === "error" ? (
        <div className="mb-lg">
          <Banner state="db-unavailable">{state.message}</Banner>
        </div>
      ) : null}

      <div className="field-row">
        <label htmlFor="employee-code" className="field-label">
          Employee code
        </label>
        <input
          id="employee-code"
          className="field"
          name="code"
          value={values.code}
          onChange={(event) => update("code", event.target.value)}
          maxLength={CODE_MAX_LENGTH}
          required
          aria-invalid={fieldErrors.code ? true : undefined}
          aria-describedby={fieldErrors.code ? "employee-code-error" : undefined}
        />
        {fieldErrors.code ? (
          <p id="employee-code-error" className="field__error" role="alert">
            {fieldErrors.code}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="employee-full-name" className="field-label">
          Full name
        </label>
        <input
          id="employee-full-name"
          className="field"
          name="full_name"
          value={values.full_name}
          onChange={(event) => update("full_name", event.target.value)}
          maxLength={NAME_MAX_LENGTH}
          required
          aria-invalid={fieldErrors.full_name ? true : undefined}
          aria-describedby={fieldErrors.full_name ? "employee-full-name-error" : undefined}
        />
        {fieldErrors.full_name ? (
          <p id="employee-full-name-error" className="field__error" role="alert">
            {fieldErrors.full_name}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="employee-work-email" className="field-label">
          Work email
        </label>
        <input
          id="employee-work-email"
          className="field"
          type="email"
          name="work_email"
          value={values.work_email}
          onChange={(event) => update("work_email", event.target.value)}
          maxLength={WORK_EMAIL_MAX_LENGTH}
          required
          aria-invalid={fieldErrors.work_email ? true : undefined}
          aria-describedby={fieldErrors.work_email ? "employee-work-email-error" : undefined}
        />
        {fieldErrors.work_email ? (
          <p id="employee-work-email-error" className="field__error" role="alert">
            {fieldErrors.work_email}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="employee-title" className="field-label">
          Job title
        </label>
        <input
          id="employee-title"
          className="field"
          name="title"
          value={values.title}
          onChange={(event) => update("title", event.target.value)}
          maxLength={TITLE_MAX_LENGTH}
          required
          aria-invalid={fieldErrors.title ? true : undefined}
          aria-describedby={fieldErrors.title ? "employee-title-error" : undefined}
        />
        {fieldErrors.title ? (
          <p id="employee-title-error" className="field__error" role="alert">
            {fieldErrors.title}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="employee-department" className="field-label">
          Department
        </label>
        <input
          id="employee-department"
          className="field"
          name="department"
          value={values.department}
          onChange={(event) => update("department", event.target.value)}
          maxLength={DEPARTMENT_MAX_LENGTH}
          required
          aria-invalid={fieldErrors.department ? true : undefined}
          aria-describedby={fieldErrors.department ? "employee-department-error" : undefined}
        />
        {fieldErrors.department ? (
          <p id="employee-department-error" className="field__error" role="alert">
            {fieldErrors.department}
          </p>
        ) : null}
      </div>

      <div className="field-row">
        <label htmlFor="employee-start-date" className="field-label">
          Start date
        </label>
        <input
          id="employee-start-date"
          className="field field--date"
          name="start_date"
          type="text"
          inputMode="numeric"
          pattern="\d{4}-\d{2}-\d{2}"
          value={values.start_date}
          onChange={(event) => update("start_date", event.target.value)}
          required
          aria-invalid={fieldErrors.start_date ? true : undefined}
          aria-describedby="employee-start-date-hint employee-start-date-error"
        />
        <p id="employee-start-date-hint" className="field__hint">
          Format: YYYY-MM-DD
        </p>
        {fieldErrors.start_date ? (
          <p id="employee-start-date-error" className="field__error" role="alert">
            {fieldErrors.start_date}
          </p>
        ) : null}
      </div>

      <button type="submit" className="btn btn--primary" disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Saving…" : mode === "create" ? "Create employee" : "Save changes"}
      </button>
    </form>
  );
}
