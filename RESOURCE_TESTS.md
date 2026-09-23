# RESOURCE_TESTS.md — Demo_App_HR

**This document is a 5-minute local-Docker smoke, not the spec §8 resource gate.** §8 asks for
200 fictional employees / 2,000 leave requests, an external load generator, five authenticated
sessions at two business requests/second in aggregate, sustained 20 minutes, with p95 latency,
CPU throttling (`cpu.stat`), DB/network latency and cold-start numbers reported against a
genuinely capped container. None of that ran. What follows is a much smaller check — light
`curl` traffic against a capped container, run from the same host, for five minutes — and every
number below is scoped to that. **The spec §8 gate itself is NOT VERIFIED.**

## What ran

`scripts/smoke-capped.sh`, executed once end to end on 2026-09-23. Environment: Docker 29.8.0,
Node v24.15.0 (host tooling only — the image runs `node:24-bookworm-slim`), curl 8.5.0, `script`
from util-linux 2.39.3, against the app's own `hr_test` database (never `hr`, never
`demo-hr-live`).

1. Dropped every table in `hr_test` (`leave_requests, employees, sessions, audit_events,
   settings, accounts, schema_migrations`) so the run started from a genuinely clean database —
   confirmed empty (`\dt` → "Did not find any tables") before continuing.
2. `docker build -t demo-hr:smoke Demo_app_HR` — succeeded.
3. `docker run --rm --env-file .env.smoke.owner.local demo-hr:smoke manage.mjs migrate` →
   `2 applied, 0 already present; postconditions verified, grants for hr_test_app exact`.
4. `manage.mjs bootstrap`, driven through `script` (which allocates the real pty `docker run -it`
   refuses without — see the header comment in `scripts/smoke-capped.sh`), fed one field at a
   time through a held-open FIFO with a 2-second pause between fields, so the app's per-field
   raw-mode toggle is never raced. Four fields: a fictional admin email
   (`smoke.admin@example.test`), a generated password, its confirmation, and the origin
   `http://127.0.0.1:3101`. Exit code 0. **0 secret bytes found in the bootstrap log** (checked
   with a bash string match against the log's full contents, never a `grep` invocation that would
   have put the password on a child process's own command line). The password was written once to
   a `0600` scratch file for the login step below and `shred -u`'d immediately after use; it was
   never printed, logged, or placed in a command-line argument. That early shred is also why the
   server-log check in step 10 compared against an empty value and could not fail (slice 5 closing
   review, I-3). The script now keeps the file until that check has run, shreds it afterwards and
   in `cleanup`, and fails when there is nothing to compare against; it has not been re-run since.
5. `manage.mjs seed-demo` → `created 12 employees and 30 leave requests (15 cancelled, the rest
   pending) starting at E-2001; no account and no password were created`.
6. Started the image **read-only**, `--cpus=0.5 --memory=1g --memory-swap=1g`,
   `-p 127.0.0.1:3101:3000`, no volume flags.
7. `/health/ready` polled once per second; first `200` at **1139 ms** after `docker run -d`
   returned (cold start).
8. Logged in once as the bootstrapped admin (curl, CSRF token parsed from `/login`'s hidden
   field, password sent via `--data-urlencode password@<0600 file>`, `Origin` header set to the
   container's own origin) → `303`, session cookie set.
9. Five minutes (300 s) of `curl` traffic, ~1 request/second, cycling `/`, `/directory`, `/leave`,
   `/approvals` with the session cookie.
10. Recorded `docker stats`, `/sys/fs/cgroup/memory.peak`, `docker inspect` (read-only/cpu/memory/
    restart count/OOM), `docker diff`, and `docker logs` (leak check; vacuous in this run, see
    step 4), then tore the container down (`docker rm -f`).

## Results

| Metric | Value |
|---|---|
| Cold start to first `/health/ready` 200 | **1139 ms** |
| Requests sent (5 min, ~1 req/s, 4 routes) | **269** |
| Non-200 responses | **0** |
| 5xx responses | **0** |
| Peak container memory (`memory.peak`, cgroup v2) | **128,712,704 bytes ≈ 122.75 MiB** |
| `docker stats` snapshot at the end | `118.2MiB / 1GiB` (11.54%), `0.03%` CPU, `PIDS 11` |
| `ReadonlyRootfs` | `true` |
| `NanoCpus` / `Memory` / `MemorySwap` | `500000000` (0.5 CPU) / `1073741824` / `1073741824` (1 GiB, no swap headroom) — matches `--cpus=0.5 --memory=1g --memory-swap=1g` exactly |
| `RestartCount` / `OOMKilled` | `0` / `false` |
| `docker diff` after the run | empty (no filesystem writes despite `--read-only`) |
| Secret bytes in `bootstrap.log` / server `docker logs` | `bootstrap.log`: `0`; server log: NOT VERIFIED (check was vacuous; fixed script not yet re-run) |

269/269 requests returned `200`; 0 unexpected 5xx, timeouts, restarts, or OOM kills. Peak memory
(≈123 MiB) is well inside the 1 GiB cap and inside the spec's 850 MiB gate threshold too, but this
run's workload (one session, ~1 req/s, GET-only) is far lighter than §8's five sessions / 2 req/s
aggregate / mixed writes over 20 minutes, so that comparison is illustrative only — **it is not
evidence the §8 gate passes.**

## Not measured here (§8 gate, NOT VERIFIED)

- 200 employees / 2,000 leave requests dataset size (this smoke seeded 12 / 30).
- Five concurrent authenticated sessions, 2 business requests/second in aggregate, 20-minute
  duration, list/search/detail/dashboard/write mix with ownership checks on every write.
- p95 business-request latency.
- An external load generator (this smoke's `curl` loop ran from the same host as the container).
- CPU throttling (`cpu.stat` `nr_throttled`/`throttled_usec`).
- Bounded login-burst behaviour, DB outage/recovery, delete/recreate-with-no-mounts negative
  tests (deliberate 429/503 expected only there).
- Two-replica behaviour (shared sessions/revocation/throttles/idempotency across replicas).
- Any run against **R1DB** — not provided by shared infrastructure (per the spec and `BRIEF.md`).

## Dependency audit

Run 2026-09-23, `Demo_app_HR/`, Node v24.15.0, npm 11.18.0.

- `npm audit --omit=dev` → **found 0 vulnerabilities**.
- `npm sbom --sbom-format cyclonedx` (no `--omit` flag) **fails** with `ESBOMPROBLEMS`: the
  installed tree has `eslint@10.11.0` (this app's own pin) while `eslint-config-next@16.3.5`
  bundles `eslint-plugin-import@2.32.0`, `eslint-plugin-jsx-a11y@6.10.2` and
  `eslint-plugin-react@7.37.5`, each of which declares a peer range topping out at `eslint@^9`
  (or `^9.7`). This is a pre-existing devDependency peer-version lag in `eslint-config-next`
  itself, not something introduced by this slice — `package.json`/`package-lock.json` were not
  touched by this work. `npm sbom --sbom-format cyclonedx --omit=dev` (the same scope
  `npm audit` already uses, and the scope closest to what actually ships — devDependencies never
  reach the runtime image) succeeds: **CycloneDX 1.5, 24 components**, committed as
  `sbom.cdx.json`. The full-tree SBOM (including devDependencies) is **NOT VERIFIED** until that
  peer mismatch is resolved — flagged for whoever next touches `package.json`, not fixed here
  (out of scope for this slice, and `package.json` was being edited by a concurrent session at
  the time of this run).
