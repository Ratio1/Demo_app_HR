# DEPLOY.md — Demo_App_HR

A focused seed, written in slice 4's fix round because D10 (plain HTTP ingress) introduced a
footgun that needed writing down before it shipped further. The full deliverable this file will
grow into — a reviewed `release` branch, a pinned base-image digest statement, CA-bundle
provenance, and the external-deployment ("→ WAR") hand-off paragraph — belongs to a later
documentation slice; this file states only what is true today and does not anticipate that work.

## The public origin: the browser's scheme and authority, not a wish

The application never uses `PORT`, `APP_URL` or a signing secret; the one setting that decides
how sessions work is the **public origin**, stored in the database and set once with
`manage set-origin` (or during `manage bootstrap`). Every mutating request is checked against it
with exact string equality (`checkOrigin`), and the session/CSRF cookies are minted
`__Host-`/`Secure`, which every browser refuses to store outside a secure context.

**The value you store must be exactly the scheme and authority the browser sends**, because
`checkOrigin` compares byte-for-byte:

- **Loopback** (`http://127.0.0.1:3001`, `http://localhost:3001`) — `http://` works: browsers
  treat loopback as a secure context, so `__Host-`/`Secure` cookies are still stored. This is the
  local, single-container run below.
- **Behind a TLS-terminating proxy** (production: Cloudflare terminates TLS in front of the app,
  operator decision D10) — the application itself still speaks plain HTTP
  (`validatePublicOrigin` accepts `http://` for any host on purpose, and
  `Strict-Transport-Security` is deliberately not emitted; Cloudflare owns both), **but the
  stored origin must be the `https://` address the browser actually has open**, e.g.
  `https://hr.example.test`. The proxy terminates TLS *in front of* the app; the origin setting
  describes what the browser sees, not what the app's own listener speaks.
- **A non-loopback `http://` origin is a silent footgun.** `validatePublicOrigin` no longer
  refuses it (D10 removed that guard on purpose, because a plain-HTTP production origin behind
  Cloudflare is now a supported case), but the `__Host-`/`Secure` session and CSRF cookies will
  not be stored by any real browser outside a secure context. The result is an instance nobody
  can sign in to, with no validation error anywhere: `set-origin` accepts the value, the app
  starts, `/health/ready` reports `ready`, and every login attempt simply fails to keep a
  session. **Do not store a non-loopback `http://` origin.**

## Building and running the single image, locally

One image serves the app and runs the maintenance CLI (`ENTRYPOINT ["node"]`, so a subcommand
overrides the default `server.js` CMD); there is no second image, no sidecar, no compose stack
(operator decision D4). The CA certificate must be in the build context first:

```bash
cp "$(_tools/pgsql/pg ca)" certs/dev-ca.crt   # from the Demo_app_HR directory
docker build -t demo-hr:local .

# Migrate, then bootstrap the first HR administrator (hidden password prompts; nothing echoed).
docker run --rm --env-file <owner-env-file> demo-hr:local manage.mjs migrate
docker run --rm -it --env-file <owner-env-file> demo-hr:local manage.mjs bootstrap

# Serve, read-only and capped, on the loopback port this app owns (spec §8's envelope).
docker run -d --name demo-hr-live --read-only \
  --cpus=0.5 --memory=1g --memory-swap=1g \
  -p 127.0.0.1:3001:3000 --env-file <app-env-file> demo-hr:local
```

`<owner-env-file>`/`<app-env-file>` are written only by `_tools/pgsql/pg env hr[_test]
[--role owner] --write <file>` — never typed or pasted by hand, never committed. The five
`DB_*` variables (`.env.example` lists them) are the **only** operator-supplied application
environment variables (operator decision D3): `DB_SERVER`, `DB_PORT` (optional), `DB_USER`,
`DB_PASSWORD`, `DB_NAME`. There is no `DATABASE_URL`, no `APP_URL`, no `PORT` and no signing
secret.

## Health checks

- `GET /health/live` — process-only, no database, no internals in the body.
- `GET /health/ready` — database reachability, migration-journal check and provisioning; `503
  db_unavailable` (sanitized) on any failure, including while unprovisioned.

## Resource envelope (spec §8)

`--cpus=0.5 --memory=1g --memory-swap=1g --read-only`, zero volumes, listener `0.0.0.0:3000`
inside the container, published only on `127.0.0.1:3001`. `RESOURCE_TESTS.md` (when written)
records the measured p95 latency, peak memory and error counts under the spec's exact workload;
this file states the envelope the container is capped to, not that measurement.

## What this file does not yet cover

The reviewed `release` branch, a pinned base-image digest, the CA-bundle provenance statement,
and the external-deployment ("→ WAR") hand-off paragraph are slice 5's, not written here, so as
not to collide with that ownership. Real WAR/Cloudflare-tunnel deployment is out of scope for
this repository's development process (operator decision D3).
