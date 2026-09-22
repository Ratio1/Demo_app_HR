/**
 * The mutation guard every `/api/**` handler runs first (spec §6 S3, S4; access matrix R12).
 *
 * Fixed order, so every route answers the same way to the same abuse:
 *
 *  1. body size - over 64 KiB is refused while reading, before anything is parsed (`413`);
 *  2. media type - `application/x-www-form-urlencoded` for `guardMutation`, and additionally
 *     `application/json` for `guardFieldMutation`; anything else is `415`;
 *  3. provisioning - no `settings.public_origin` means there is no reference origin to compare
 *     against, so the guard fails closed with a sanitized `503` (spec §4);
 *  4. exact `Origin` equality - missing, the literal `null`, or any mismatch is `403`.
 *
 * Session resolution and the CSRF comparison come after, in each handler, because the three
 * routes need different principals. A database failure anywhere is a sanitized `503`: no
 * SQLSTATE, no statement, no host (S6).
 */
import type { Pool } from "../db/pool.ts";

import { withClient } from "../db/pool.ts";
import { checkOrigin } from "../auth/origin.ts";
import { getPublicOrigin } from "../repos/settings.ts";
import { newCorrelationId } from "../repos/audit.ts";
import {
  FORM_CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  mediaType,
  readFormBody,
  readJsonBody,
} from "./request.ts";
import { formToObject, jsonToFields, type BodyFields } from "./forms.ts";
import { problemResponse } from "./response.ts";

export interface MutationContext {
  readonly form: URLSearchParams;
  readonly publicOrigin: string;
  readonly correlationId: string;
}

/** The same context for the routes that take either encoding; the body is already flattened. */
export interface FieldMutationContext {
  readonly fields: BodyFields;
  readonly publicOrigin: string;
  readonly correlationId: string;
}

export type GuardOutcome =
  | { readonly ok: true; readonly context: MutationContext }
  | { readonly ok: false; readonly response: Response };

export type FieldGuardOutcome =
  | { readonly ok: true; readonly context: FieldMutationContext }
  | { readonly ok: false; readonly response: Response };

function bodyProblem(reason: "too_large" | "unsupported_media_type" | "unreadable"): Response {
  if (reason === "too_large") {
    return problemResponse(413, "too_large");
  }
  if (reason === "unsupported_media_type") {
    return problemResponse(415, "unsupported_media_type");
  }
  return problemResponse(400, "invalid_input");
}

/**
 * Steps 3 and 4 of the order above, shared by both guards: the reference origin is read from
 * the database and compared for exact equality. A database failure is a sanitized `503`.
 */
async function checkRequestOrigin(
  pool: Pool,
  request: Request,
): Promise<{ readonly ok: true; readonly publicOrigin: string } | { readonly ok: false; readonly response: Response }> {
  let publicOrigin: string | null;
  try {
    publicOrigin = await withClient(pool, async (client) => getPublicOrigin(client));
  } catch {
    return { ok: false, response: problemResponse(503, "db_unavailable") };
  }

  const origin = checkOrigin(request.headers.get("origin"), publicOrigin);
  if (!origin.ok) {
    if (origin.problem === "unprovisioned") {
      return { ok: false, response: problemResponse(503, "db_unavailable") };
    }
    return { ok: false, response: problemResponse(403, "forbidden") };
  }

  return { ok: true, publicOrigin: publicOrigin as string };
}

export async function guardMutation(pool: Pool, request: Request): Promise<GuardOutcome> {
  const body = await readFormBody(request);
  if (!body.ok) {
    return { ok: false, response: bodyProblem(body.reason) };
  }

  const origin = await checkRequestOrigin(pool, request);
  if (!origin.ok) {
    return { ok: false, response: origin.response };
  }

  return {
    ok: true,
    context: {
      form: body.form,
      publicOrigin: origin.publicOrigin,
      correlationId: newCorrelationId(),
    },
  };
}

/**
 * The slice 2 guard: identical order and identical refusals, but it accepts
 * `application/json` as well as `application/x-www-form-urlencoded` and hands the handler one
 * flat `Record<string, string>` either way (spec §6 S4; the employee editor submits through
 * `fetch`). A body that is not a flat object of scalars, or a form field sent twice, is
 * `400 invalid_input` — it is never merged, flattened or partially accepted.
 */
export async function guardFieldMutation(
  pool: Pool,
  request: Request,
): Promise<FieldGuardOutcome> {
  const type = mediaType(request);
  let fields: Record<string, string> | null;

  if (type === JSON_CONTENT_TYPE) {
    const body = await readJsonBody(request);
    if (!body.ok) {
      return { ok: false, response: bodyProblem(body.reason) };
    }
    fields = jsonToFields(body.value);
  } else if (type === FORM_CONTENT_TYPE) {
    const body = await readFormBody(request);
    if (!body.ok) {
      return { ok: false, response: bodyProblem(body.reason) };
    }
    fields = formToObject(body.form);
  } else {
    return { ok: false, response: problemResponse(415, "unsupported_media_type") };
  }

  const origin = await checkRequestOrigin(pool, request);
  if (!origin.ok) {
    return { ok: false, response: origin.response };
  }

  if (fields === null) {
    return { ok: false, response: problemResponse(400, "invalid_input") };
  }

  return {
    ok: true,
    context: {
      fields,
      publicOrigin: origin.publicOrigin,
      correlationId: newCorrelationId(),
    },
  };
}
