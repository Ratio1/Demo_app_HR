# Demo_App_HR - one image, two entry points: the Next.js standalone server and the `manage`
# CLI (spec §8).
#
#  - the base image is pinned by digest (D6); nothing floats;
#  - the build stage needs no database: `next build` and `tsc` run with every DB_* variable
#    absent, and the build fails rather than connects if that ever changes;
#  - the runtime stage carries only what serving needs - the standalone server, the static
#    assets, the migrations, the compiled CLI and the CA bundle;
#  - it runs as the unprivileged `node` user on a read-only root filesystem with no volumes
#    (ruling R-I, spike S5): no VOLUME here and none inherited, no writable cache, no log file;
#  - ENTRYPOINT is set explicitly because the base image ships `docker-entrypoint.sh`
#    (ruling R-J), so `docker run <image> manage.mjs migrate` reaches the CLI while the
#    default CMD starts the server.
#
# The CA certificate must be in the build context before `docker build`:
#   cp "$(_tools/pgsql/pg ca)" Demo_app_HR/certs/dev-ca.crt
ARG BASE=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

# ---------------------------------------------------------------- build ----
FROM ${BASE} AS build
WORKDIR /app

# Dependencies first, so a source-only change does not reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# `npm run build` is `next build` followed by the CLI compile (tsc -p tsconfig.cli.json plus
# the ESM finalizer). No DB_* variable is set in this stage and none is read.
COPY . .
RUN npm run build

# -------------------------------------------------------------- runtime ----
FROM ${BASE} AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000

# The standalone server and the assets it serves itself (no CDN, spec §6).
COPY --from=build --chown=root:root /app/.next/standalone ./
COPY --from=build --chown=root:root /app/.next/static ./.next/static
COPY --from=build --chown=root:root /app/public ./public

# Maintenance: the compiled CLI keeps its own directory layout because tsc emits
# dist/cli/manage.mjs alongside the dist/server/** modules it shares with the server, plus a
# dist/package.json that marks that tree as ESM.
COPY --from=build --chown=root:root /app/dist ./dist
COPY --from=build --chown=root:root /app/migrations ./migrations

# ... and the brief's entry point, `node manage.mjs <command>`, is that layout's entry file
# linked at /app. The link is created at build time, so it is part of the image and needs no
# writable filesystem at run time; Node resolves the main module to its real path, so the CLI
# still sees dist/package.json ("type": "module") and its own relative imports.
RUN ln -s dist/cli/manage.mjs manage.mjs

# The reviewed CA bundle, used with rejectUnauthorized: true (spec §4). It is a public
# certificate, never a key.
COPY --chown=root:root certs/dev-ca.crt ./certs/dev-ca.crt

# Nothing in /app is writable by the runtime user; the filesystem is read-only anyway.
USER node

EXPOSE 3000

ENTRYPOINT ["node"]
CMD ["--max-old-space-size=512", "server.js"]
