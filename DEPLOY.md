# DEPLOY.md: Demo_App_HR

How the single image is built, provisioned and run, and what an external deployment needs. Real
Ratio1 WAR / Deeploy deployment, tunnel setup and a reviewed `release` branch are **out of scope
for this repository's development process** (operator decisions D3 and D4). This file states the
facts an external deployer needs and does not claim that any WAR path was tested.

## TLS terminates at Cloudflare; the app speaks plain HTTP (D10)

In production, Cloudflare terminates TLS in front of the app (operator decision D10, 2026-09-22).
The container itself serves **plain HTTP** on `0.0.0.0:3000`. There is no TLS terminator in the
image, and the app does **not** emit `Strict-Transport-Security`: HSTS for the public name is
Cloudflare's, and a header sent over plain HTTP is ignored by browsers anyway. D10 is about web
ingress only. The **database** connection keeps TLS with chain and hostname verification (see
"The CA bundle" below).

## The public origin: the browser's scheme and authority, not a wish

The application never uses `PORT`, `APP_URL` or a signing secret. The one setting that decides
how sessions work is the **public origin**, stored in the database and set once with
`manage set-origin` (or during `manage bootstrap`). Every mutating request is checked against it
with exact string equality (`checkOrigin`). The session and CSRF cookies are minted
`__Host-`/`Secure`, and browsers refuse to store those outside a secure context.

**The value you store must be exactly the scheme and authority the browser sends**, because
`checkOrigin` compares byte-for-byte:

- **Loopback** (`http://127.0.0.1:3001`, `http://localhost:3001`): `http://` works. Browsers
  treat loopback as a secure context, so `__Host-`/`Secure` cookies are still stored. This is the
  local, single-container run below.
- **Behind a TLS-terminating proxy** (production: Cloudflare terminates TLS in front of the app,
  operator decision D10): the application itself still speaks plain HTTP
  (`validatePublicOrigin` accepts `http://` for any host on purpose, and
  `Strict-Transport-Security` is deliberately not emitted; Cloudflare owns both). **But the
  stored origin must be the `https://` address the browser actually has open**, e.g.
  `https://hr.example.test`. The proxy terminates TLS *in front of* the app; the origin setting
  describes what the browser sees, not what the app's own listener speaks.
- **A non-loopback `http://` origin is a silent footgun.** `validatePublicOrigin` no longer
  refuses it (D10 removed that guard on purpose, because a plain-HTTP production origin behind
  Cloudflare is now a supported case). But no real browser stores the `__Host-`/`Secure`
  session and CSRF cookies outside a secure context. The result is an instance nobody can sign
  in to, with no validation error anywhere: `set-origin` accepts the value, the app starts,
  `/health/ready` reports `ready`, and every login attempt simply fails to keep a session.
  **Do not store a non-loopback `http://` origin.**
- The app never derives its origin from `Host` or `X-Forwarded-*`, and must not be changed to.
  It does **compare** `Host`: every mutation's `Host` header must equal the host (and port, if
  any) of the stored origin exactly, or the request is refused with `403` (`checkHost`;
  `SECURITY.md`, S5). `X-Forwarded-Host` is never read.
- **The ingress must forward the public hostname as `Host`.** That is believed to be
  Cloudflare's and `cloudflared`'s default. A tunnel `httpHostHeader` override, or any proxy
  that rewrites `Host` to the container's own address, leaves pages loading but makes every
  sign-in and every change fail with `403`. Keep the container port private as well.

## Building and running the single image, locally

One image serves the app and runs the maintenance CLI. Its `ENTRYPOINT` is `["node"]` and its
default `CMD` is `["--max-old-space-size=512", "server.js"]`, so a `manage.mjs <command>`
argument replaces the server with the CLI. There is no second image, no sidecar and no compose
stack (operator decision D4). The CA certificate must be in the build context first:

```bash
cp "$(../_tools/pgsql/pg ca)" certs/dev-ca.crt   # from the Demo_app_HR directory of the meta-repo
docker build -t demo-hr:local .

# Migrate, then bootstrap the first HR administrator (hidden password prompts; nothing echoed).
docker run --rm --env-file <owner-env-file> demo-hr:local manage.mjs migrate
docker run --rm -it --env-file <owner-env-file> demo-hr:local manage.mjs bootstrap

# Serve, read-only and capped, on the loopback port this app owns (spec §8's envelope).
docker run -d --name demo-hr-live --restart unless-stopped --read-only \
  --cpus=0.5 --memory=1g --memory-swap=1g \
  -p 127.0.0.1:3001:3000 --env-file <app-env-file> demo-hr:local
```

`<owner-env-file>`/`<app-env-file>` are written only by `_tools/pgsql/pg env hr[_test]
[--role owner] --server host.docker.internal:5432 --write <file>`: never typed or pasted by hand,
never committed. Both `.env*` forms are git-ignored and excluded from the build context by
`.dockerignore`. The five `DB_*` variables are the **only** operator-supplied application
environment variables (operator decision D3): `DB_SERVER`, `DB_PORT` (optional), `DB_USER`,
`DB_PASSWORD`, `DB_NAME`. There is no `DATABASE_URL`, no `APP_URL`, no `PORT` and no signing
secret. `PORT=3000`, `HOSTNAME=0.0.0.0`, `NODE_ENV=production` and
`NEXT_TELEMETRY_DISABLED=1` are baked into the image; they are not operator settings. A source
build that bypasses the Dockerfile sets them inline in its start command (`README.md`, "Ratio1
WAR (source build)").

`README.md` has the full pipeline-driven sequence, including `seed-demo`.

### Migrate before serve, on every upgrade

Migrations run **once, outside serving, with the owner role** (`…_owner`); the server runs with
the DML-only runtime role (`…_app`) and never runs DDL. On every new image, run `manage.mjs
migrate` with the owner credentials **before** starting the new server. `/health/ready` requires
the newest migration the image ships (`REQUIRED_MIGRATION_ID`, currently `0002_tighten_grants`)
to be journalled, so a new image in front of an unmigrated database answers `503 not_ready`
until `migrate` has run. A database that has already applied a newer migration stays ready.
`migrate` verifies the seven tables and the runtime role's exact grants after it applies
anything, and exits non-zero if either is wrong.

### The container envelope (spec §8)

`--cpus=0.5 --memory=1g --memory-swap=1g --read-only`, **zero volumes** (the Dockerfile declares
no `VOLUME`, and the pinned base declares none), no writable cache or temp mount, the
unprivileged `node` user, one Node process (`--max-old-space-size=512` limits old-space only, not
total memory), and the listener `0.0.0.0:3000` published only on `127.0.0.1:3001`. The
read-only root filesystem and these limits are applied by the run command above; the image does
not enforce them itself. The only load check is slice 5's 5-minute local-Docker smoke, which ran
on 2026-09-23; its result is in `RESOURCE_TESTS.md`, and this file does not restate it. The spec
§8 20-minute resource gate was **not** run: NOT VERIFIED.

## Health checks

- `GET /health/live`: process only; no database, no session. `200 {"status":"ok"}`.
- `GET /health/ready`: the pool reaches the database over TLS, `schema_migrations` contains
  the newest migration this image ships (`0002_tighten_grants`), and the `settings` singleton
  exists (i.e. `bootstrap` has run). `200
  {"status":"ready"}`, otherwise `503 {"status":"not_ready"}`, with the same body for every cause
  and no SQLSTATE, host, role or migration list. A five-variable configuration error is raised
  outside that check and surfaces as a generic server error, not as `503` (known, deferred).

Both carry `Cache-Control: no-store`. Neither needs a session.

## The CA bundle (dev-CA build)

The pool connects with `ssl: { ca, rejectUnauthorized: true, servername: <DB host> }`: chain
and hostname verification against a CA **bundled in the image**, never a mounted file and never a
certificate fetched at run time. The code reads it from `certs/dev-ca.crt` relative to the working
directory (`/app` in the image). `certs/*.crt` is git-ignored. The file is copied into the build
context before `docker build`.

A source build (WAR) has no Dockerfile step to place it. The file must be in the checkout:
committed with `git add -f certs/dev-ca.crt` on the branch WAR clones, or written there by a build
command. It must also be copied to `.next/standalone/certs/dev-ca.crt`, because the generated
standalone `server.js` changes its working directory to `.next/standalone/`
(`process.chdir(__dirname)`). The `manage` CLI keeps the directory it is started in and reads
`certs/dev-ca.crt` and `migrations/` there.

**Every image built from this repository so far is a dev-CA build.** The bundled certificate is
the machine-local CA of the shared development server (`demo-apps-pg`). It proves "local fixtures
also use TLS" and it is **not** a production trust root. A build for another database must
place that database's CA bundle at `certs/dev-ca.crt` (the path is fixed in code whatever the
file is called). For R1DB, that means its private CA, reviewed and included before the artefact
is published. The server certificate must name the host used in `DB_SERVER`. The dev server's
certificate covers `localhost` and `host.docker.internal`.

## External deployment hand-off (facts only)

| Item | Value |
|---|---|
| Application / deployment name | `Demo_App_HR` |
| Artefact | Either the Docker image built from this repository's `Dockerfile` (two stages), or a WAR source build of this repository (`README.md`, "Ratio1 WAR (source build)") |
| Base image | `node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6` in the `Dockerfile`; WAR `image="node:24-bookworm-slim"` (a digest in WAR's `image` is NOT VERIFIED) |
| Build | Docker: `docker build -t <tag> .` with the target database's CA at `certs/dev-ca.crt`. WAR: commands 1-5 below. Neither needs a database or reads a `DB_*` variable; the WAR commands strip them. |
| Start (serve) | Image default: `node --max-old-space-size=512 server.js` in `/app`. WAR: command 6 below, from `/app` |
| Maintenance | `node manage.mjs <command>` in `/app` (same image), or `node dist/cli/manage.mjs <command>` from the root of a built checkout; owner credentials; never in the serving container |
| Port | `3000` inside the container, bound on `0.0.0.0`; plain HTTP; keep it private behind the TLS-terminating ingress (WAR `port=3000`) |
| Environment | `DB_SERVER`, `DB_PORT` (optional), `DB_USER`, `DB_PASSWORD`, `DB_NAME`, and nothing else (WAR `env`: the runtime role). The listener settings come from the image's `ENV`, or inline in the WAR start command. |
| Order | `migrate` (owner role) -> `bootstrap` once, interactively, with the public `https://` origin (owner role) -> serve (runtime role); `migrate` again after every upgrade, before the new version serves |
| Health | `GET /health/live`, `GET /health/ready` (`503` until the newest migration is applied and `bootstrap` has run) |
| Ingress | TLS-terminating; forwards the public hostname as `Host` (mutations with any other `Host` get `403`) |
| Envelope | Docker run path: 0.5 CPU, 1 GiB, no swap, read-only root filesystem, no volumes, non-root `node` user. WAR sets only `container_resources` (documented `{"cpu": 1, "memory": "1g"}`; fractional CPU NOT VERIFIED) and `volumes`/`file_volumes` (`{}`). |
| State | All durable state is in the database; the container can be deleted and recreated |

WAR `build_and_run_commands`, identical to `README.md`, run in order in `/app` of the cloned
branch:

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

The CA is copied into `.next/standalone/` because the generated `server.js` changes its working
directory to its own. `NODE_ENV` stays out of WAR's `env`: set there, it would make `npm ci` skip
the build's dev dependencies. `bootstrap` needs an interactive terminal, so it runs from a
machine that reaches the database, not inside WAR. This path has **not** been run (operator
decision D3): NOT VERIFIED.

Not provided, and why:

- **`scripts/war-build.sh`, `scripts/war-start.sh`, `scripts/manage`**: dropped by operator
  decision D8. The Dockerfile (for a source build, the `build_and_run_commands` list above) and
  `node manage.mjs` are the source of the build, start and maintenance commands.
- **A reviewed `release` branch, CI-prebuilt artefacts, registry push**: not created. The operator
  owns release promotion (D3/D4).
- **Build id from the reviewed commit**: `next.config.ts` derives it from `git rev-parse HEAD`,
  but `.git` is excluded from the Docker build context, so image builds use the constant `local`.
  A source build from a git clone, as WAR does, would take the commit SHA instead.
  Asset consistency across replicas or versions was not tested: NOT VERIFIED.
- **Two replicas, SIGTERM drain, database outage/recovery, clean redeploy**: not tested in this
  repository. NOT VERIFIED (see `REVIEW.md`).
- **WAR isolation, CPU quota, memory limit and absence of mounts on a real node**: OUT OF SCOPE
  (D3). The limits above were measured only on local Docker.
