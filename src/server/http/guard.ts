/**
 * The mutation guard every `/api/**` handler runs first (spec §6 S3, S4; access matrix R12).
 *
 * Fixed order, so every route answers the same way to the same abuse:
 *
 *  1. body size - over 64 KiB is refused while reading, before anything is parsed (`413`);
 *  2. media type - only `application/x-www-form-urlencoded` (`415`);
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
import { readFormBody } from "./request.ts";
import { problemResponse } from "./response.ts";

export interface MutationContext {
  readonly form: URLSearchParams;
  readonly publicOrigin: string;
  readonly correlationId: string;
}

export type GuardOutcome =
  | { readonly ok: true; readonly context: MutationContext }
  | { readonly ok: false; readonly response: Response };

export async function guardMutation(pool: Pool, request: Request): Promise<GuardOutcome> {
  const body = await readFormBody(request);
  if (!body.ok) {
    if (body.reason === "too_large") {
      return { ok: false, response: problemResponse(413, "too_large") };
    }
    if (body.reason === "unsupported_media_type") {
      return { ok: false, response: problemResponse(415, "unsupported_media_type") };
    }
    return { ok: false, response: problemResponse(400, "invalid_input") };
  }

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

  return {
    ok: true,
    context: {
      form: body.form,
      publicOrigin: publicOrigin as string,
      correlationId: newCorrelationId(),
    },
  };
}
