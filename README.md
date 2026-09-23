# Demo_App_HR

A small, security-hardened HR tutorial app: employee records, a limited colleague directory,
and leave requests with a second-admin approval rule. Next.js App Router (standalone server),
TypeScript strict, React, local Tailwind CSS, `pg`, Zod and Argon2id (`@node-rs/argon2`),
packaged as **one Docker image** that both serves the app and runs the `manage` maintenance
CLI. All state lives in an external PostgreSQL database reached over TLS `verify-full`.
Everything in this repository uses fictional data only (`example.test`).

| Document | What it covers |
|---|---|
| [`DEPLOY.md`](DEPLOY.md) | Building and running the image, the public origin, health checks, the external-deployment hand-off |
| [`SECURITY.md`](SECURITY.md) | Status of controls S1-S7, known gaps, preconditions of use, what is NOT VERIFIED |
| [`REVIEW.md`](REVIEW.md) | Sessions and models used, reviews, operator decisions, deviations, the release-gate status table |

## What the app does

Two roles, one organization, English UI.

| Role | Can |
|---|---|
| `hr_admin` | Create, edit, activate and deactivate employee records; see the HR overview (headcount, per-department counts, approval queue); approve or reject pending leave, **except their own**. May also have an employee record and request leave. |
| `employee` | See active colleagues' name, title, department and work email; see their own profile; submit `annual`/`personal` leave, see their own history, cancel their own pending requests. |

Accounts are never created through the web UI: there is no sign-up and there are no default
passwords. Accounts come from the `manage` CLI, and an `employee` account must be linked to an
employee record. Deactivating an employee disables their login, revokes their sessions, hides
them from the directory and cancels their pending leave, all in one transaction. The last active
HR administrator cannot be removed. Leave durations are **illustrative Monday-Friday counts**,
not entitlements (no holidays, accrual or payroll).

## Configuration: five variables, nothing else

| Variable | Meaning |
|---|---|
| `DB_SERVER` | `host` or `host:port`; bracket IPv6 literals (`[::1]:5432`). No URL, no query string, no TLS options. |
| `DB_PORT` | Optional, default `5432`. Leave it unset when `DB_SERVER` carries a port; two different ports refuse to start. An empty value is refused too. |
| `DB_USER` | The runtime role (`…_app`) to serve, the owner role (`…_owner`) for every `manage` command. |
| `DB_PASSWORD` | Never logged, never echoed, never a command-line argument. |
| `DB_NAME` | An existing, dedicated database. |

There is no `DATABASE_URL`, no signing secret, no `APP_URL` and no `PORT` variable (operator
decision D3). The public origin is stored in the database (`manage bootstrap` / `set-origin`).
The listener is fixed at `0.0.0.0:3000` inside the container. [`.env.example`](.env.example)
lists the five names. Real values go only in git-ignored files written by a tool, never in a
commit.

## Local run (the pipeline runs this, not you)

On the development machine this repository belongs to, **the agent pipeline builds, migrates,
seeds and starts the app; the operator only opens the URL** (operator decision D9). The
commands are listed so the sequence is reproducible, not because anyone is expected to type
them. They run from the root of the `Demo_App_Wrapper` meta-repo, whose `_tools/pgsql/pg` provides
the shared PostgreSQL 18 server, the credentials files and the dev CA.

```bash
_tools/pgsql/pg ensure && mkdir -p Demo_app_HR/certs && cp "$(_tools/pgsql/pg ca)" Demo_app_HR/certs/dev-ca.crt
_tools/pgsql/pg env hr --server host.docker.internal:5432 --write Demo_app_HR/.env.live.local
_tools/pgsql/pg env hr --role owner --server host.docker.internal:5432 --write Demo_app_HR/.env.live.owner.local
docker build -t demo-hr:live Demo_app_HR
docker run --rm --env-file Demo_app_HR/.env.live.owner.local demo-hr:live manage.mjs migrate
docker run --rm -it --env-file Demo_app_HR/.env.live.owner.local demo-hr:live manage.mjs bootstrap
docker run --rm --env-file Demo_app_HR/.env.live.owner.local demo-hr:live manage.mjs seed-demo
docker run -d --name demo-hr-live --restart unless-stopped --read-only --cpus=0.5 --memory=1g --memory-swap=1g \
  -p 127.0.0.1:3001:3000 --env-file Demo_app_HR/.env.live.local demo-hr:live
```

Then open `http://127.0.0.1:3001`.

- The dev CA is copied into the build context and baked into the image; it is git-ignored and is
  a public certificate, never a key. See `DEPLOY.md` for what a non-dev build needs instead.
- `bootstrap` asks at hidden prompts for the first administrator's email, a password (twice,
  15-128 characters) and the public origin (`http://127.0.0.1:3001` here). Under D9 the pipeline
  answers those prompts through a pseudo-terminal with **generated one-time passwords** and hands
  them to the operator in a private, git-ignored file outside this repository, never in a commit,
  log or chat message. Change them at `/me` after the first sign-in.
- `seed-demo` adds 12 fictional employees (codes `E-2xxx`, four departments) and 30 leave
  requests. The requests are `pending` or `cancelled` only: an approved or rejected request must
  name a real deciding account, and the seed creates **no accounts and no passwords**. The
  accounts for the walkthrough come from `create-user`, below.
  (The first go-live on 2026-09-23 predates `seed-demo` and seeded through the app's own API.)
- Port `3001` belongs to the live container `demo-hr-live`. To re-run the last line, `docker rm -f
  demo-hr-live` first. Automated tests use `127.0.0.1:3101` and never touch `3001`.

## Walkthrough (acceptance)

This is the spec's journey (HR adds an employee, the operator links a login, the employee
requests leave, a *different* HR admin approves, the employee sees the result) plus the denied
paths worth seeing by hand. It mirrors the operator's acceptance checklist. It needs four
accounts, created with the owner credentials (`create-user` prompts for the email if `--email`
is omitted, then for the password twice, hidden):

| Actor | How it is created |
|---|---|
| **Admin A**: HR admin, no employee record | `manage.mjs bootstrap` |
| **Admin B**: HR admin with an employee record | `manage.mjs create-user --role hr_admin --employee <code>` |
| **Employee E**: linked employee | `manage.mjs create-user --role employee --employee <code>` |
| **Spare login L**: another linked employee, used only for the lockout step | `manage.mjs create-user --role employee --employee <code>` |

1. Sign in as **Admin A** at `/login`.
2. Look at the **overview** (`/`): headcount, per-department counts, the number of pending approvals.
3. Open **Employees** (`/employees`): every record, active and inactive, with its login-link status.
4. **Create** a new employee from the form and see it appear in the list.
5. Open the **Directory** (`/directory`): the four-field colleague view (name, title, department,
   work email), active colleagues only.
6. Sign out, sign in as **Employee E**.
7. On `/leave`, **submit a range that overlaps** one of E's pending or approved requests (submit one
   first if E has none) and see the `409` overlap refusal in the form.
8. Sign out, sign in as **Admin B**.
9. On `/approvals`, **approve or reject** E's pending request. Signed in as E again, the decision
   shows on `/leave` and on `/`.
10. As Admin B, submit a leave request for yourself on `/leave`. On `/approvals`, your own row
    shows no Approve/Reject buttons, only "A different HR admin must decide your own request."
    Sign in as Admin A (an `hr_admin` needs no employee record to decide someone else's request)
    and decide it there: **the self-approval bar blocks the owner, not every admin.**
11. As Admin A, **deactivate** an employee on `/employees` and watch them disappear from the
    directory. If they had a login, it stops working at once.
12. Try **five wrong passwords** against Spare login L to see the lockout page and `Retry-After`.
    The lock clears itself after 15 minutes.

Also worth a look: as Employee E, open `/employees` (you get "You don't have access to this.",
not the list); edit the same employee in two tabs as an admin and save both (the second save
gets a `409` with its typed input preserved); sign out and press Back (you land on `/login`, not
a cached private page).

## Tests

Unit tests need nothing else. Integration tests use the scratch database `hr_test` (never `hr`)
and drop and re-create its tables. The Playwright suite builds its own image, starts a read-only,
capped `demo-hr-e2e` container on `127.0.0.1:3101` against `hr_test`, provisions its own
throw-away accounts through the CLI's hidden prompts, and tears everything down again. It needs
Docker and the cached Playwright 1.61.1 Chromium. From the meta-repo root:

```bash
_tools/pgsql/pg ensure && _tools/pgsql/pg create-app hr_test
cp "$(_tools/pgsql/pg ca)" Demo_app_HR/certs/dev-ca.crt
_tools/pgsql/pg env hr_test --server localhost:5432 --write Demo_app_HR/.env.test.local
_tools/pgsql/pg env hr_test --role owner --server localhost:5432 --write Demo_app_HR/.env.test.owner.local
npm --prefix Demo_app_HR ci
npm --prefix Demo_app_HR test          # test:unit, then test:int, then test:e2e
```

| Script | What it runs |
|---|---|
| `npm run lint` / `npm run typecheck` | ESLint; `tsc` for the app and the CLI |
| `npm run test:unit` (`test:unit:tz`) | Vitest unit project (and the same run under UTC, `Pacific/Kiritimati` and `Pacific/Niue`) |
| `npm run test:int` | Vitest integration project against `hr_test`, one file at a time |
| `npm run test:e2e` | Playwright: the journey, eight denied paths, axe and keyboard checks at 390x844 and 1440x900 |
| `npm test` | The three above, in order, stopping at the first failure |

Never run `test:int` and `test:e2e` at the same time: both reset `hr_test`. The last full green
run (2026-09-23, the slice 5 fix round at `88131f4`: lint, typecheck, then the three steps of
`npm test`) reported 212 unit tests passed; 171 integration tests passed plus
**2 expected fail**; 39 Playwright tests passed. The two expected failures are deliberate
ratchets (`it.fails`) for access-matrix rows D-020 and D-036. The code answers `403` where the
design document says `404`; see "Deviations" in `REVIEW.md`. They are not test failures.

## The `manage` CLI

The CLI ships inside the image as `/app/manage.mjs`. The image's entrypoint is `node`, so
`docker run --rm [-it] --env-file <owner env file> <image> manage.mjs <command>` runs it. Every
command needs the **owner** role (`DB_USER` ending in `_owner`). It refuses the runtime role, and
passwords are only ever typed at a hidden prompt, never passed as arguments.

| Command | Does |
|---|---|
| `migrate` | Applies the numbered `migrations/*.sql` files, each in one transaction, journalled in `schema_migrations`; then verifies the seven tables and the runtime role's exact grants. Safe to re-run. |
| `bootstrap` | Creates the first HR administrator and stores the public origin, in one transaction (hidden prompts; needs `-it`). |
| `set-origin <url>` | Replaces the public origin every mutation's `Origin` and `Host` headers are compared against (`http://` or `https://`, scheme and authority only). |
| `create-user --role hr_admin\|employee [--email <address>] [--employee <code>]` | Creates an account and optionally links it to an employee record. `employee` requires `--employee`. A missing, already-linked or deactivated record is refused. |
| `reset-password <email>` | Sets a new password at a hidden prompt and revokes that account's sessions. |
| `disable-user <email>` | Deactivates an account and revokes its sessions; never the last active HR admin. |
| `seed-demo [--force]` | Adds 12 fictional employees and 30 `pending`/`cancelled` leave requests in one transaction, audited under a fixed system actor that has no account. No accounts, no passwords. Refuses a non-empty `employees` table unless `--force`, which appends a batch with fresh `E-2xxx` codes and emails. |

Not provided, deferred by operator decision D8: `cleanup`, `export-subject`, `erase-subject`,
`reset-demo`, and a host-side `scripts/manage` wrapper.

## Deployment

Real Ratio1 WAR / Deeploy deployment and tunnel setup are done externally and are out of scope
for this repository's development process (operator decisions D3 and D4). In production, TLS
terminates at Cloudflare and the app itself speaks plain HTTP (D10). `DEPLOY.md` lists what an
external deployment needs: build and run commands, port `3000`, the five variables, migrate
before serve, the health endpoints, and the CA bundle.

## License

See [`LICENSE`](LICENSE).
