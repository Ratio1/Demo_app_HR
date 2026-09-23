# REVIEW.md: Demo_App_HR

What spec §1 asks this file to record: the sessions and models actually used, the reviewed
commit, the findings with severity and disposition, the evidence, and the operator decisions
that narrowed the spec. No self-approval, no fabricated votes. A check that was not run is
**NOT VERIFIED**. WAR, tunnel and CI items are **OUT OF SCOPE (D3/D4)**. Evidence paths starting
with `_agents/` are in the `Demo_App_Wrapper` meta-repo that builds this app; the other paths are in
this repository.

## Reviewed commit

- `README.md`, `DEPLOY.md`, `SECURITY.md` and this file were last corrected in the slice 5 fix
  round, against the code at `88131f40cf85762a296eb6dd3d69f441469010be` (`88131f4`, 2026-09-23),
  the round's last code commit and the tree its test run used. They land in the docs-only commit
  that immediately follows it; a file cannot name the commit that contains it.
- Slice 5 part D first wrote them against `636c548` and, for `seed-demo`, `fee2f55`. The rest of
  part S (the capped smoke, `RESOURCE_TESTS.md`, `sbom.cdx.json`) landed at `04d782c`.
- The closing whole-codebase review (slice 5 part R) reviewed `04d782c` and returned
  `needs_fixes` (0 critical, 4 important, 8 minor). The fix round is `a2f4205`..`88131f4` plus
  the docs commit. The re-review outcome is appended at the end of this file by the
  orchestrator; nothing here pre-states it.

## Sessions and models

The build ran under Claude Code. The orchestrator (coordinator) is pinned to `claude-fable-5-1` in
the meta-repo's `.claude/settings.json`. That stands in for spec §1's `gpt-astra-6-ultra`
coordinator under the meta-repo's model policy, and a top model is never used as a subagent.
Session ids were not recorded. Implementer models are copied from each report's header. Reviewer
models are the role pin (`opus`) the ledger records. The slice 5 closing review is the only
reviewer report that states an exact model id: Opus 5.5 (1M), `claude-opus-5-5[1m]`.

| Stage | Role | Model actually used | Submodule commits | Evidence |
|---|---|---|---|---|
| Phase 0: threat model, access matrix | `backend-security` | Opus 5 (1M), `claude-opus-5[1m]` | none | `_agents/projects/HR/sdd/phase-0/task-2-report.md`, `task-3-report.md` |
| Phase 0: data contract | `db-architect` | Opus 5 (1M), `claude-opus-5[1m]` | none | `…/phase-0/task-4-report.md` |
| Phase 0: spikes S-images, S0, S10, S4, S5 | `test-engineer` | Sonnet 5, `claude-sonnet-5` | none | `…/phase-0/task-{1,5,6,7,8}-report.md`, `_agents/projects/HR/spikes/` |
| Phase 1: design council | see the seat table below | | `61e968a` (35 SVGs) | `…/sdd/phase-1/task-{1,2,3}-report.md` |
| Slice 1 A: scaffold, config, pool, migrations | `db-architect` | Opus 5 (1M), `claude-opus-5[1m]` | in `c3697b0..1863d0d` (18) | `…/sdd/slices/slice-1-A-report.md` |
| Slice 1 B: auth, CLI, routes, proxy, Dockerfile, fix round | `backend-security` | Opus 5 (1M), `claude-opus-5[1m]` | same range | `slice-1-B-report.md`, `slice-1-fix-report.md` |
| Slice 1 C: login, `/me`, theme | `frontend` | Sonnet 5, `claude-sonnet-5` | same range | `slice-1-C-report.md` |
| Slice 2 B: employees, cascade, fix round | `backend-security` | Opus 5 (1M), `claude-opus-5[1m]` | in `b93420a..0a29d61` (17) | `slice-2-B-report.md`, `slice-2-fix-report.md` |
| Slice 2 C: employees, directory, profile screens | `frontend` | Sonnet 5, `claude-sonnet-5` | same range | `slice-2-C-report.md` |
| Slice 3 B: leave, approvals, dashboards, fix round | `backend-security` | Opus 5 (1M), `claude-opus-5[1m]` | in `9bc8bd2..62d37a8` (10) | `slice-3-B-report.md`, `slice-3-fix-report.md` |
| Slice 3 C: leave and approvals screens | `frontend` | Sonnet 5, `claude-sonnet-5` | same range | `slice-3-C-report.md` |
| Go-live (D9): `demo-hr-live` from `96dcb26` | `test-engineer` | Sonnet 5, `claude-sonnet-5` | none | `go-live-report.md` |
| Slice 4 D10: plain-HTTP origin, HSTS removed | `backend-security` | Opus 5 (1M), `claude-opus-5[1m]` | `96dcb26` | `slice-4-D10-report.md` |
| Slice 4 tests: DENY suite, Playwright, axe | `test-engineer` | Sonnet 5, `claude-sonnet-5` | `276b840`, `0b23c3e` | `slice-4-tests-report.md` |
| Slice 4 UI fixes | `frontend` | Sonnet 5, `claude-sonnet-5` | `e231554`, `6c0ec91`, `58fe29a` | `slice-4-ui-fixes-report.md` |
| Slice 4 fix round | `test-engineer` | Sonnet 5, `claude-sonnet-5` | `d256e61`..`636c548` (6) | `slice-4-fix-report.md` |
| Slice 5 S: `seed-demo`, capped smoke, audit, SBOM | `test-engineer` | Claude Sonnet 5, `claude-sonnet-5` | `fee2f55`, `04d782c` | `slice-5-S-report.md` |
| Slice 5 D: these four documents | `backend-security` | Opus 5.5 (1M), `claude-opus-5-5[1m]` | `3ec3945`, `6675f5b` | `…/slice-5-D-report.md` |
| Slice 5 R: closing review | `reviewer-security-privacy` | Opus 5.5 (1M), `claude-opus-5-5[1m]` | read-only (reviewed `04d782c`) | `slice-5-R-report.md` |
| Slice 5 fix round: readiness, `Host` check, smoke leak check, lockout re-check, docs | `backend-security` | Opus 5.5 (1M), `claude-opus-5-5[1m]` | `a2f4205`..`88131f4` (5) plus the docs commit | `slice-5-fix-report.md` |
| Slice 5 L: final re-launch | `test-engineer` | sonnet (role pin); not yet run | none | its report |

### Design council (seat authority, fixed before any council report landed)

| Council seat | Spec §1 names | Model actually used | Authority |
|---|---|---|---|
| Artwork specialist | `gpt-5.6-sol-xhigh` | `sonnet` (role `design-artwork`) | operator-approved substitution — D6 (ask Q14, 2026-09-22) |
| UI designer | `gpt-5.5-xhigh` | `sonnet` (role `design-ui`) | operator-approved substitution — D6 (ask Q14, 2026-09-22) |
| UX architect | `gpt-6-astra-xhigh` | `opus` (role `design-ux-architect`) | operator decision D2 (AGENTS.md, 2026-09-21) |

The council reviewed the design (flows, tokens, artwork) in Phase 1. Its sign-off on implemented
browser flows was replaced by the operator's own acceptance session (D8). That sign-off is
therefore **NOT VERIFIED** until the operator gives it.

### Code-review council (one fresh, non-authoring seat per slice, D8)

Spec §1 asks for three parallel seats. D8 narrowed that to one fresh reviewer per slice plus one
closing whole-codebase pass, with at most one fix round each. Minor findings went to the
meta-repo's `_agents/projects/HR/DEFERRED.md`.

| Slice | Seat (role, model) | Findings | Disposition |
|---|---|---|---|
| 1 | `reviewer-security-privacy`, opus | 1 important: the image shipped the CLI only at `dist/cli/manage.mjs`, so `manage.mjs <cmd>` failed. 9 minors. | Fixed in `1863d0d`; re-review approved; minors deferred |
| 2 | `reviewer-correctness-war`, opus | 1 critical: `Referrer-Policy: no-referrer` made browsers send `Origin: null`, so every native form POST got `403`. 3 important: anonymous `/employees` and `/directory` answered `200`; `/me` overflowed at 390 px; a failed bootstrap container was left running. | Fixed in `80d6f22`, `09a8608`, `fba4e71`, `0a29d61`; re-review approved; 3 minors deferred |
| 3 | `reviewer-sql-concurrency`, opus | 1 critical: nav icons passed as functions across the RSC boundary, so every signed-in route failed in the container. 1 important: no gate rendered a signed-in route. | Fixed in `62d37a8` plus a container check of six routes; re-review approved |
| 4 | `reviewer-correctness-war` (fresh seat), opus | 1 critical: `npm test` was red, so e2e never ran through it. 6 important: axe scanned unproven page state; the lockout test under-asserted; the keyboard test checked nothing; the grant probe could not fail (and the grant gap was real); `DEPLOY.md` was missing; `/api/password`'s `429` page. | Fixed in `d256e61`..`636c548`; re-review approved |
| 5 | `reviewer-security-privacy` (fresh), Opus 5.5 (1M) | 0 critical. 4 important: `/health/ready` checked only `0001_init`; no `Host` check on mutations; the smoke's server-log secret check could not fail; stale or overclaiming docs. 8 minors. | Fix round `a2f4205`..`88131f4` plus docs; minors m1, m3, m4 fixed there, m2 and m5-m8 left for `DEFERRED.md`. Re-review: appended below by the orchestrator |

## Operator decisions (one line each)

- **D3** (2026-09-21): WAR, Deeploy and tunnels are out of scope; the app runs against local PostgreSQL and is configured only by `DB_SERVER`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` (five variables, replacing §4's four); R1DB stays NOT VERIFIED.
- **D4** (2026-09-21): the deliverable is one locally built image that serves the app and runs `manage`, using the given `hr`/`hr_test` databases; no CI/CD, no release branch, no registry push.
- **D5** (2026-09-21): MVP acceptance is the operator's own local review and testing session on `hr`; no default or published passwords; automated tests use `hr_test` with throw-away credentials.
- **D6** (2026-09-22): the first plan and asks Q1-Q14 were approved on their defaults, including the artwork and UI-designer seats on sonnet (Q1, Q3 and Q12 were later reversed by D8).
- **D7** (2026-09-22): stop, simplify, and deliver a minimal MVP as soon as possible.
- **D8** (2026-09-22): the simplified plan was approved. It has a keep/defer/drop table; one reviewer per slice plus a closing pass; `FOR UPDATE` instead of portable anchors; the resource gate and scanners reported NOT VERIFIED; S6 as the per-account lockout only; the operator's session as the design sign-off.
- **D9** (2026-09-22): the pipeline builds and launches the app, and the operator only tests it live; demo accounts get generated one-time passwords, handed over in a private git-ignored file.
- **D10** (2026-09-22): plain HTTP, with TLS terminated at Cloudflare; origins may be `http://` for any host; no HSTS from the app; database TLS unchanged.

## Deviations from the spec

**Scope (D8 keep/defer/drop).** *Kept:* spec §2 in full; S1-S5 and S7; S6 reduced; §4's five
variables, `verify-full`, owner/runtime role split and CLI-only accounts; §8's non-root,
read-only, single-container envelope; §7's screens on the committed tokens and artwork.
*Deferred:* idempotency keys and mutation receipts; `SERIALIZABLE` with retry; checksummed
restartable migrations; S6 global budgets and DB-shared throttles; S1 forced-reset mode;
`cleanup`/`export-subject`/`erase-subject`; the 20-minute resource profile and
`scripts/test-resource-profile`; two-replica evidence; scanner suite and ASVS mapping; bounded
search with sort/filter allowlists; `reset-demo`; the full axe x screenshot matrix. *Dropped:*
`war-build.sh`/`war-start.sh` and the host `scripts/manage` wrapper; the portable
`leave_seq`/`admin_seq` anchors; the `csrf_tokens`, `preauth_sessions`, `mutation_receipts` and
`migration_lock` tables; separate activate/deactivate and approve/reject routes; the employee
search route.

**Access-matrix rulings.**
- *R-Q (D-020, D-036):* on HR-only object-addressed routes, an `employee` gets `403` from the role
  check before the object is read, where the design matrix says `404` for a foreign object. The
  code stays as it is (the uniform `403` discloses nothing). `tests/int/deny.test.ts` pins the
  current `403` and keeps the matrix's `404` as two `it.fails` ratchets, which is the "2 expected
  fail" in every `npm test` run.
- *D-081:* an `hr_admin` cancelling someone else's request gets `404` (cancel is owner-only). The
  test was corrected to match the code and the slice-4 brief. The matrix row itself still says
  `403`.

**Contract deviations recorded in slice reports.**
- JSON-driven mutations answer `200 {ok, location, …}`, not `303`, because a `fetch` caller cannot
  read a `303`. `location` is built by the server.
- Both form and JSON bodies are accepted through one strict schema.
- Routes are `POST /api/employees/[id]` and `…/status`, not `PATCH` or separate verbs.
- `/directory` is active-only for HR too; inactive records are managed on `/employees`.
- An unlinked `hr_admin` at `/me` sees "no employee record linked", not `403`.
- Page redirects are `307`, not `303`.
- `employees.code` uniqueness is case-sensitive, while `work_email` is unique after lowercasing.
- `start_date` is bounded to 1900-2100; leave dates have no year or length bound (deferred).
- An empty `DB_PORT` is refused rather than treated as unset.
- Login rotation revokes only the presented session.
- `Referrer-Policy` is `same-origin`, not `no-referrer`.
- `style-src 'self'` with no style nonce, and the app ships its own error pages (R-H).
- `cacheMaxMemorySize: 0` (R-I).
- `ENTRYPOINT ["node"]` set explicitly (R-J).
- `0002_tighten_grants` narrows the runtime role's grants; the runtime keeps `UPDATE` on `settings`.
- Only the self-approval refusal and the last-admin refusal are audited among business refusals.
- The self-approval row renders no buttons, rather than disabled buttons.
- The nav collapses in-flow, not as an off-canvas panel.
- Migrations assume transactional DDL.
- The image build id is the constant `local`, because `.git` is not in the build context.
- D10 removed HSTS and the loopback-only restriction on `http://` origins.
- The fictional seed's leave requests are `pending` and `cancelled` only, not a full status mix:
  `approved`/`rejected` rows need a real deciding account, and the seed creates none (D5.3).

**Process.**
- Spec §1's coordinator and seat models were substituted as recorded above.
- Spec §1's three parallel code-review seats became one seat per slice (D8).
- Every commit carries one `Co-Authored-By` trailer naming the model that wrote it, except the
  Phase 1 artwork commit `61e968a`. It carries the orchestrator's `Claude Fable 5.1` trailer,
  while the SVGs were authored by the artwork seat on Sonnet 5.
- During the go-live, the four initial one-time passwords were read back into an agent's context.
  All four were rotated at once and the handover file rewritten without anyone reading the new
  values (`go-live-report.md`, concern 1). Twice, a throw-away password was echoed during a failed
  bootstrap attempt (a slice-2 container run and go-live attempt 1). Neither value ever became a
  credential.

## Release-gate status (spec §9)

"pass" means an automated or recorded check passed on local PostgreSQL 18, with the evidence
named. The last full run is the slice 5 fix round's, at `88131f4`
(`_agents/projects/HR/sdd/slices/slice-5-fix-report.md`): lint and typecheck clean; unit 212
passed; integration 171 passed plus 2 expected fail; Playwright 39 passed, on a fresh
`demo-hr:e2e` build. Before it, the closing review's `npm test` at `04d782c` gave 207 / 166 plus
2 expected fail / 39 (`slice-5-R-report.md`). Slice 4's run (207 / 162 plus 2 / 39) predates
`fee2f55`, which added `src/server/services/seed.ts`, CLI code and 4 integration tests, and
`04d782c`, which added the smoke script.

| Gate | Status | What passed | What did not, and why |
|---|---|---|---|
| Product | **pass** | Employee create/edit/activate/deactivate, directory and profile, request/cancel/approve/reject, both dashboards: `tests/e2e/journey.spec.ts`, `tests/int/employees.test.ts`, `tests/int/leave.test.ts` | None |
| Access | **pass** | Two employees plus two HR admins; objects, lists, counts, field and link over-posting, self-approval, inactive accounts, last-admin protection: `tests/int/deny.test.ts` (D-### rows), `tests/int/employees.test.ts`, journey denied paths | D-020/D-036 ratcheted (R-Q). D-016 verified by inspection only (no role-change path exists). D-027 not constructed (argued unreachable): NOT VERIFIED |
| Security/privacy | **NOT VERIFIED** | CSRF and Origin (`tests/int/auth-routes.test.ts`, journey Origin-less POST); approved `Host` on mutations, foreign `Host` refused (`auth-routes.test.ts`, `tests/int/employees.test.ts`, `tests/unit/auth-primitives.test.ts`); sessions, idle and absolute expiry, rotation, revocation; lockout (`auth-routes.test.ts`, journey); `no-store` and Back after logout (journey); DTO field allowlists (`tests/unit/employees-dto.test.ts`, `leave-dto.test.ts`, `tests/int/employees.test.ts`) | No SQLi/XSS probe tests; `Host` is checked on mutations only, not on GETs; forced-reset mode deferred (D8); no sweep of HTML/RSC/logs/browser storage for hidden HR data; CSP not asserted by a test |
| SQL | **NOT VERIFIED** | PostgreSQL migrations and exact grants (`tests/int/migrate.test.ts`); overlap and double submission, racing decisions, stale edits (`tests/int/leave.test.ts`, `employees.test.ts`); cascade and audit atomicity; timezone-safe dates (`npm run test:unit:tz`, three zones) | Actual R1DB: NOT VERIFIED (D3; not reachable). Retry on `40001`/`40P01`: deferred (D8). Recovery: not tested. The concurrency tests assert outcomes, not proven contention |
| Deploy | **NOT VERIFIED** | DB-free image build (every `docker build`); five-variable start, read-only and capped (`go-live-report.md`, `tests/e2e/global-setup.ts`); DML-only serving (`migrate.test.ts`); TLS refusal on the wrong CA (`tests/int/pool-tls.test.ts`, spike S0); hydration under the CSP in a real browser (journey) | TLS outage/restart and two replicas with same-build assets: NOT VERIFIED. Real WAR HTTPS, isolation and CSP on a node: OUT OF SCOPE (D3/D4) |
| Resources/state | **NOT VERIFIED** | Exact app name `Demo_App_HR` (UI title, docs); local-Docker cgroup limits (cpu.max 50000/100000, memory.max 1 GiB, swap 0, zero mounts, uid 1000: spike S5, `_agents/projects/HR/spikes/S5-readonly-fs.md`) | The §8 20-minute workload and peak-memory gate: NOT VERIFIED. Slice 5's 5-minute smoke is the only load check and it ran (`RESOURCE_TESTS.md`: 269 requests, 0 non-200, peak memory ≈123 MiB under a 1 GiB cap; its server-log secret check was vacuous, so that line is NOT VERIFIED). Clean redeploy and state recovery: pending, because slice 5 part L (the re-launch) has not run. WAR 0.5-core/1-GiB/zero-volume deployment: OUT OF SCOPE (D3) |
| Quality | **NOT VERIFIED** | All critical and important review findings fixed (table above); lower-severity findings listed in `DEFERRED.md` | `npm audit --omit=dev` found 0 vulnerabilities. The CycloneDX SBOM (`sbom.cdx.json`, CycloneDX 1.5, 24 components) was produced **only with `--omit=dev`**; the full-tree `npm sbom` fails with `ESBOMPROBLEMS`, so a complete SBOM is NOT VERIFIED (`RESOURCE_TESTS.md` "Dependency audit"). Image, secret and SAST scans and authenticated DAST: NOT VERIFIED (D8). CI-based scanning: OUT OF SCOPE (D4) |
| Design/review | **NOT VERIFIED** | axe: zero serious/critical violations in 26 scans (7 routes, both roles, 390x844 and 1440x900) plus keyboard checks on `/leave` and `/approvals` (`tests/e2e/a11y.spec.ts`, `slice-4-tests-report.md`) | The every-state x viewport matrix was deferred (D8). The design council's sign-off on the final commit was replaced by the operator's session (D8). The closing code review ran (`needs_fixes`); its fix round is done and the re-review is pending |

Other §9 deliverables: source and lockfile, Dockerfile and `.dockerignore`, migrations,
`.env.example` (five placeholders, D3), tests, and these four documents are in this repository.
The fictional seed (`manage seed-demo`), `RESOURCE_TESTS.md` and `sbom.cdx.json` come from slice 5
part S. No screenshots are committed. The WAR scripts and `scripts/manage` were dropped (D8).

## Closing review (slice 5 part R)

To be appended by the orchestrator: reviewed commit, reviewer model, findings with severity,
dispositions, and the fix-round result.
