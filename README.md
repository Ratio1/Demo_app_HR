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

## Production environment — minimal

A production deployment supplies exactly these five variables. The server reads them with the
runtime role; every `manage` command reads them with the owner role.

| Variable | Example | Rule |
|---|---|---|
| `DB_SERVER` | `db.example.test` or `db.example.test:5432` | `host` or `host:port`; bracket IPv6 literals (`[::1]:5432`). No URL, no query string, no TLS options. |
| `DB_PORT` | `5432` | Optional, default `5432`. Leave it unset when `DB_SERVER` carries a port; two different ports, or an empty value, refuse to start. |
| `DB_USER` | `hr_app` to serve; `hr_owner` for `migrate` (and every other `manage` command) | Serving uses the DML-only runtime role; `manage` refuses any user that does not end in `_owner`. |
| `DB_PASSWORD` | `<secret>` | The only secret. Never logged, never echoed, never a command-line argument. |
| `DB_NAME` | `hr` | An existing, dedicated database. |

No other variable exists: no `DATABASE_URL`, no `APP_URL`, no signing or session secret, and no
secret besides `DB_PASSWORD` (operator decision D3). The public origin is stored in the
database, not in the environment (`manage.mjs bootstrap` / `set-origin`). It must be the exact
origin the browser has open: behind Cloudflare that is `https://…`, e.g.
`https://hr.example.test`, even though the app itself speaks plain HTTP (D10).
[`.env.example`](.env.example) lists the five names. Real values go only in git-ignored files,
never in a commit.

**Listener settings are fixed, not configuration.** `HOSTNAME=0.0.0.0`, `PORT=3000`,
`NODE_ENV=production` and `NEXT_TELEMETRY_DISABLED=1` are shipped defaults in the `Dockerfile`
(`ENV`). The WAR source build below does not use the Dockerfile, so its start command must set
all four explicitly, inline. `HOSTNAME` is the one that bites: Docker sets it to the container
ID in every container, and the standalone `server.js` listens on `$HOSTNAME`, falling back to
`0.0.0.0` only when it is unset. (`server.js` also defaults `PORT` to `3000` and forces
`NODE_ENV=production`; `NEXT_TELEMETRY_DISABLED` has no code default.) Keep them out of the
deployment's environment: `NODE_ENV=production` there would make `npm ci` skip the dev
dependencies the build needs.

**The database CA is a file, not a variable.** The pool connects with TLS chain and hostname
verification (`rejectUnauthorized: true`, `servername` = the `DB_SERVER` host) and trusts only
the CA it reads from `certs/dev-ca.crt`. That name is fixed in code (`src/server/db/pool.ts`)
whatever database the CA belongs to, and it is resolved against the working directory.
`certs/*.crt` is git-ignored, so a fresh checkout does not have it: a production checkout must
provide the **production database CA** at that path. Either commit it on the branch the
deployment builds from (`git add -f certs/dev-ca.crt`; a CA certificate is public, never a key),
or have a build command write the PEM to that path. The database server's certificate must name
the `DB_SERVER` host. The dev CA used locally is not a production trust root.

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
  a public certificate, never a key. A production build needs the production database CA
  instead: see "Production environment — minimal" above and `DEPLOY.md`.
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
`docker run --rm [-it] --env-file <owner env file> <image> manage.mjs <command>` runs it. From a
built checkout (`npm ci && npm run build:cli`) it is `node dist/cli/manage.mjs <command>`, run
from the repository root: it reads `certs/dev-ca.crt` and `migrations/` relative to the working
directory. Every command needs the **owner** role (`DB_USER` ending in `_owner`). It refuses the
runtime role, and passwords are only ever typed at a hidden prompt, never passed as arguments.

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

## Base image

`node:24-bookworm-slim`, pinned by digest in the `Dockerfile` (`ARG BASE`, used by both stages):

```text
node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
```

It carries Node 24.21.0 and npm 11.19.0, and no `git`. WAR's `image` field takes the tag,
`node:24-bookworm-slim`. The runner source passes a `tag@sha256:…` reference to `docker pull`
unchanged, but a digest-pinned WAR deployment has not been tried: NOT VERIFIED. With the tag
alone, WAR pulls whatever the tag points to at every container start (`image_pull_policy`
defaults to `always`).

## Ratio1 WAR (source build)

WAR does not run the Dockerfile. It clones the configured branch into `/app` of a plain `image`
container (installing `git` first if the image lacks it), then runs `cd /app && <entry>` for
every `build_and_run_commands` entry, chained with `&&` in one `sh -c`, as root. Every restart is
a fresh container, clone and build. Values for the Ratio1 SDK's
`Session.create_worker_web_app`:

| Field | Value |
|---|---|
| `image` | `"node:24-bookworm-slim"` |
| `vcs_data` | `{"PROVIDER": "github", "REPO_OWNER": "Ratio1", "REPO_NAME": "Demo_app_HR", "BRANCH": "<branch>", "USERNAME": "<github user>", "TOKEN": "<github token>"}`; required by the SDK. The runner source also accepts `REPO_URL` and labels `REPO_OWNER`/`REPO_NAME` legacy support. The branch must provide `certs/dev-ca.crt` (see above). |
| `port` | `3000` |
| `env` | `{"DB_SERVER": "db.example.test", "DB_PORT": "5432", "DB_USER": "hr_app", "DB_PASSWORD": "<secret>", "DB_NAME": "hr"}`: the runtime role, nothing else |
| `build_and_run_commands` | The list below, in order |
| `container_resources` | `{"cpu": 1, "memory": "1g"}` |
| `volumes`, `file_volumes` | `{}` (empty) |

Tunnel, node and GitHub credentials are the deployer's platform settings, never application
`env`.

```python
build_and_run_commands = [
    "env -u DB_SERVER -u DB_PORT -u DB_USER -u DB_PASSWORD -u DB_NAME npm ci --no-audit --no-fund",
    "env -u DB_SERVER -u DB_PORT -u DB_USER -u DB_PASSWORD -u DB_NAME npm run build",
    "cp -r public .next/standalone/public",
    "cp -r .next/static .next/standalone/.next/static",
    "mkdir -p .next/standalone/certs && cp certs/dev-ca.crt .next/standalone/certs/dev-ca.crt",
    "HOSTNAME=0.0.0.0 PORT=3000 NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 node --max-old-space-size=512 .next/standalone/server.js",
]
```

- **1-2** are the Dockerfile's build stage. `npm run build` is `next build && npm run build:cli`:
  the standalone server lands in `.next/standalone/`, the `manage` CLI in `dist/`. WAR sets `env`
  on the container, so every command would inherit the database credentials; `env -u` keeps them
  out of the install and the build (spec §8). The build needs no database either way.
- **3-5** put next to the server what the Dockerfile's runtime stage copies: `public/`,
  `.next/static/` and the CA. The CA goes inside `.next/standalone/` because the generated
  `server.js` changes its working directory to its own (`process.chdir(__dirname)`) and the CA
  path resolves against the working directory. The server never reads `dist/` or `migrations/`.
- **6** is the image's `CMD` plus its four `ENV` listener settings, inline, started from `/app`:
  one Node process, old-space capped at 512 MiB directly.
- **Resources.** The spec's serving envelope is 0.5 CPU and 1 GiB. The runner source converts
  `cpu` with `float()`, but no fractional value has been applied on a node: NOT VERIFIED, hence
  `1`. The build runs in the same container under the same limits; its peak memory under a
  1 GiB cap has not been measured.

**Migrations and first-time setup never run in the serving container.** Serving uses the
DML-only `hr_app` role, and `/health/ready` answers `503` until the newest migration
(`0002_tighten_grants`) is journalled **and** `bootstrap` has created the settings row. Run the
steps below with the **owner** variables (`DB_USER=hr_owner`, the other four unchanged) from any
machine that reaches the database, in one of two ways:

- a checkout of the deployed commit: `npm ci --no-audit --no-fund && npm run build:cli`, the CA
  at `certs/dev-ca.crt`, then `node dist/cli/manage.mjs <command>` from the repository root, with
  the owner variables in its environment (never on the command line);
- the Docker image: `docker run --rm [-it] --env-file <owner-env-file> <image> manage.mjs <command>`.

1. `migrate`: once before the first serve, and again after every upgrade, before the new version
   serves. Safe to re-run; it then verifies the tables and the runtime role's exact grants.
2. `bootstrap`: once. It creates the first HR admin and stores the public origin, at hidden
   prompts. It needs an interactive terminal and refuses without one, so it cannot run inside
   WAR's non-interactive exec.
3. `set-origin https://<public host>`: whenever the public name changes. The value must be the
   exact browser-facing origin, e.g. `https://hr.example.test` (D10); a mismatch makes every
   sign-in and every change fail.

`migrate` could also run as a separate one-off WAR deployment with the owner variables; that has
not been tried.

This section documents facts read from this repository's code and from the Ratio1 SDK and
edge-node source. Real WAR deployment is out of scope (operator decision D3) and none of it has
been run: NOT VERIFIED.

## License

See [`LICENSE`](LICENSE).
