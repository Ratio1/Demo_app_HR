/**
 * `GET /health/live` (spec §8): process only.
 *
 * No database, no session, no configuration read - if this process can answer, it is alive.
 * The body is two constant fields; it names no host, no role, no schema, no version and no
 * build id (§8 "disclose no internals").
 *
 * `force-dynamic` keeps `next build` from prerendering it, which would also be a build-time
 * evaluation of a runtime probe.
 */
import { jsonResponse } from "../../../server/http/response.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(): Response {
  return jsonResponse(200, { status: "ok" });
}
