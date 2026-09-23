# SECURITY.md: Demo_App_HR

Status of the spec's mandatory controls (S1-S7) as the code at this commit implements them,
after operator decision D8 narrowed the scope for the MVP. **Implemented** means present in the
code and covered by the tests named in `REVIEW.md`. **Reduced** means part of the control is
missing. **Deferred** means not built. This is a demo on fictional data. It is not an OWASP ASVS
assessment, not a certification, and not a claim of GDPR/NIS2/CRA compliance.

## S1-S7 at a glance

| ID | Status | What holds (code) | What is missing |
|---|---|---|---|
| S1 Passwords | **Reduced** | Argon2id `m=19456` KiB (19 MiB), `t=2`, `p=1`, fresh salt per hash (`src/server/auth/password.ts`). 15-128 code points after NFKC, never truncated, paste allowed; bundled 60-entry blocklist plus repeated/monotonic-run refusal (`blocklist.ts`). Unknown and inactive accounts get the same Argon2 work and the same generic failure (`dummyVerify`). Recovery is operator-only (`manage reset-password`). | Forced-reset session mode (sessions limited to "change password / log out" after a reset): **deferred (D8)**. `reset-password` revokes sessions instead. |
| S2 Sessions | **Implemented** | 256-bit CSPRNG opaque token; only its SHA-256 is stored. `__Host-session`, `Secure; HttpOnly; SameSite=Lax; Path=/`, no `Domain`, no `Max-Age`. Idle 30 min, absolute 8 h, both enforced from database timestamps. Account and role are re-read on every request. A new session on login (the presented one revoked); all sessions revoked and a fresh one issued on password change; revoked on logout, reset and deactivation (`auth/session.ts`, `repos/sessions.ts`). No JWT, signing key or `localStorage`. | Login revokes only the session it was presented with, not the account's other sessions. Two-replica behaviour is by design (all state in the DB) but was **not tested**. |
| S3 CSRF / Origin | **Implemented** (D8 shape) | Every mutation is a Node Route Handler under `/api/**`, and each one checks exact `Origin` equality against `settings.public_origin`: missing, `null` or different is `403`; its `Host` must equal that origin's host too (S5) (`http/guard.ts`, `auth/origin.ts`). Authenticated forms carry the session's 256-bit synchronizer token; login uses a `__Host-csrf` double-submit cookie (Max-Age 600 s) minted by `src/proxy.ts`. `POST`/`PUT`/`PATCH`/`DELETE` outside `/api/**` get `405`. A GET changes no business data (it only refreshes the session's idle clock). Success locations are built by the server. | No separate pre-auth session table (D8 dropped it). Since D10 the configured origin may be `http://`; exactness still applies. |
| S4 Authorization / input | **Reduced** | Role, object and field checks run server-side in one place per surface (`http/authorize.ts`, `services/*.ts`). Page reads use the same services, and middleware authorizes nothing. Field-allowlisted DTOs (`dto/*.ts`), `z.strictObject` with over-post and duplicate-key refusal, 64 KiB cap enforced while the body streams, parameterised SQL only, React autoescaping, no `dangerouslySetInnerHTML`. | The `/employees` list and `/directory` are **unpaged** (the `≤100-row pages` rule holds only for leave lists). Search and sort allowlists were never built (**deferred, D8**). No dedicated SQL-injection or XSS probe tests exist (safe by construction, **not tested**). |
| S5 Transport / headers | **Reduced** | Per-request CSP nonce, `script-src 'self' 'nonce-…' 'strict-dynamic'`, `style-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`; inbound CSP/nonce headers stripped (`src/proxy.ts`). `nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()`. `Cache-Control: no-store` on every non-static response. Logout sends `Clear-Site-Data: "cache", "cookies"`, and Back after logout lands on `/login` (tested). Approved `Host` only on every mutation: the `Host` header must equal the configured origin's host exactly, or `403`; `X-Forwarded-Host` is never read (`checkHost` in `auth/origin.ts`, run by `http/guard.ts`; tested on `/api/login` and `/api/employees`). | **No HSTS** (D10: Cloudflare owns it). `Host` is enforced on mutations only; GET pages and health checks answer any `Host`. The ingress must forward the public hostname as `Host` (`DEPLOY.md`). HTTPS ingress is Cloudflare's, not the app's (D10). The CSP header is not asserted by any automated test (spike S4 and the slice-1 smoke checked it by hand; the browser suite shows hydration works under it). `Referrer-Policy` is `same-origin`, not `no-referrer`, because `no-referrer` makes browsers send `Origin: null` on form posts (`http/response.ts`). |
| S6 Throttling / failure | **Reduced (D8)** | Per-account lockout: 5 failures, then 15 minutes, counted atomically in the `accounts` row, so it holds across replicas (`repos/accounts.ts`). One active Argon2 hash per container and eight waiting; any further caller gets `429` + `Retry-After` (`auth/semaphore.ts`). Pool max 4, 5 s acquisition timeout, 10 s statement timeout. A database failure returns a sanitized `503`. The app's own code logs one fixed message (a discarded idle pool connection) and nothing else. | **Deferred (D8):** the global login/pre-auth budget (120/min), DB-shared throttles beyond the lockout, bounded mutation/query rates, a bounded pool waiter queue. `/api/password` has no failure counter of its own. A locked account answers `429` while an unknown email answers `303`, so five guesses reveal whether an account exists. What Next.js itself logs for an unexpected exception was not audited. |
| S7 Audit / maintenance | **Reduced** | Audit rows (actor, object type/id, action, outcome, correlation id, time) are written with the caller's transaction, so they commit or roll back with the change they describe (`repos/audit.ts`). The runtime role holds only `INSERT, SELECT` on `audit_events`, and tests prove it cannot update or delete a row. `seed-demo` rows are audited under a fixed system actor id that has no account. | **Deferred (D8):** `cleanup`, `export-subject`, `erase-subject`, and expiry of old sessions/audit rows (90-day audit retention is not enforced). `denied` rows are written for failed logins (including locked accounts), a wrong current password, the self-approval bar and the last-admin refusal; other refusals (`403`/`404`/`409`) write nothing, and an unknown email writes nothing. |

## Preconditions of use

- **Loopback or a TLS-terminating ingress only.** The session and CSRF cookies are `Secure`.
  Behind Cloudflare the browser sees `https://`, and on `127.0.0.1` the browser treats the page as
  secure. A direct plain-HTTP deployment on any other host cannot sign anyone in (`DEPLOY.md`).
- **S6 is the per-account lockout only.** That is acceptable on loopback with fictional data. It
  is **not** acceptable on a public origin without an edge rate limit in front of `/api/login`
  and `/api/password` (operator decision D8, point 4).
- **No MFA.** Spec §6 puts MFA outside this demo. Verified administrator MFA is required before
  any real-data use.
- **Fictional data only.** A real-data release needs the operator approvals spec §6 lists
  (purpose and lawful basis, notices, retention and erasure including backups, processor and node
  locations, access reviews, incident and patch handling, encryption at rest, a tested restore).
  None of those exist, and neither do the subject export and erasure commands.

## Known gaps, stated plainly

- **Audit immutability is not DBA-proof.** The runtime role cannot change audit rows; the owner
  role and any database superuser can. No stronger claim is made.
- **`FOR UPDATE` portability.** Concurrency on the leave, overlap and last-admin paths relies on
  `SELECT … FOR UPDATE` row locks plus `status`/`version` write guards under PostgreSQL's default
  isolation. There is no `SERIALIZABLE` and no retry loop (D8). That is correct on PostgreSQL 18.
  It is an **untested gap** on CockroachDB/R1DB, which the spec also targets.
- **Migrations assume transactional DDL** (one transaction per numbered file, journalled); no
  checksums, no lock (single-operator step). Also a portability gap for R1DB.
- **The runtime role can still `UPDATE` `settings`** (the stored public origin, which the Origin
  check trusts). A compromised server process could change it. The migrations remove only
  `INSERT`/`DELETE` there.
- **Plain HTTP between Cloudflare and the container.** Whatever runs between the edge and the
  container port is trusted. The app trusts no forwarded header. Its `Host` check on mutations
  refuses a request addressed to any other name, but not a hop that forwards the right `Host`.

## Database transport

TLS with chain **and** hostname verification (`rejectUnauthorized: true`, `servername` set,
libpq's `verify-full` equivalent) against the CA bundled in the image (`src/server/db/pool.ts`).
Never disabled, never fetched at run time, never mounted. A server whose certificate the bundled
CA did not sign is refused (`tests/int/pool-tls.test.ts`). Current images carry the **dev CA**
of the shared development server, not a production trust root (`DEPLOY.md`).

## NOT VERIFIED

- The spec §8 resource gate (20 minutes, 200 employees / 2,000 leave requests, p95 and peak
  memory). The only load check is slice 5's 5-minute local-Docker smoke, recorded in
  `RESOURCE_TESTS.md`, and it is not that gate.
- Image, secret and SAST scans and authenticated DAST. D8 replaced them with `npm audit` and a
  CycloneDX SBOM (slice 5 part S; `RESOURCE_TESTS.md` "Dependency audit"). `npm audit --omit=dev`
  found 0 vulnerabilities. The SBOM (`sbom.cdx.json`, CycloneDX 1.5, 24 components) covers
  **production dependencies only** (`--omit=dev`); the full-tree `npm sbom` fails with
  `ESBOMPROBLEMS`, so a complete SBOM is NOT VERIFIED.
- The OWASP ASVS 5.0.0 Level 2 mapping. This page replaces it (D8); no ASVS ids are claimed.
- R1DB / CockroachDB compatibility (not reachable from the development machine; D3).
- Two replicas, database outage and recovery, SIGTERM drain, and a non-loopback `http://` origin
  in a real browser.

Report a suspected vulnerability privately to the repository owner, not in a public issue.
