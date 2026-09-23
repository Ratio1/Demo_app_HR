#!/usr/bin/env bash
# scripts/smoke-capped.sh — slice 5 Part S local resource smoke.
#
# This is a **5-minute local-Docker smoke**, not the spec §8 resource gate (200 employees /
# 2,000 leave requests / five sessions / 2 req/s aggregate / 20 minutes / an external load
# generator). That gate is out of scope here and stays NOT VERIFIED; see RESOURCE_TESTS.md.
#
# What this script does, against the app's own `hr_test` database (never `hr`):
#   1. drops every table in `hr_test` so the run starts from a genuinely clean database;
#   2. builds `demo-hr:smoke`;
#   3. runs `manage.mjs migrate`, then `manage.mjs bootstrap` (hidden-prompt, paced pty, a
#      freshly generated throw-away password — never an argument, never printed, never logged),
#      then `manage.mjs seed-demo`;
#   4. starts the image **read-only**, capped at 0.5 CPU / 1 GiB, on 127.0.0.1:3101;
#   5. logs in once, then loops ~1 request/second over `/`, `/directory`, `/leave`,
#      `/approvals` for ~5 minutes, recording every HTTP status;
#   6. records peak container memory (`/sys/fs/cgroup/memory.peak`) and any 5xx;
#   7. tears everything down.
#
# The bootstrap prompt needs a real pty: `docker run -it` refuses when its own stdin is not a
# terminal, so this drives it through `script` (which allocates one), fed by a named FIFO one
# field at a time with real delays between writes — bulk-feeding a pty defeats its per-field
# raw-mode toggle and can echo a password to the container's own log (see go-live-report.md's
# attempt 1). Every check below reads the secret only into a shell variable or a 0600 file, and
# every log is searched with a bash string match, never a `grep` invocation that would put the
# secret on a child process's own command line. The 0600 file is kept until the server-log check
# at the end has compared against it, then shredded; `cleanup` shreds it on every other exit. A
# leak check with nothing to compare against fails instead of passing (slice 5 R, I-3).
#
# `cleanup` also deletes the two hr_test credential files this script writes (slice 5 R, m3).
#
# Run from anywhere; paths are resolved from this file's location.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$ROOT/Demo_app_HR"
PG="$ROOT/_tools/pgsql/pg"
SCRATCH="$(mktemp -d)"
IMAGE="demo-hr:smoke"
CONTAINER="demo-hr-smoke"
PORT="3101"
ORIGIN="http://127.0.0.1:${PORT}"
DURATION_SECONDS="${SMOKE_DURATION_SECONDS:-300}"
ADMIN_EMAIL="smoke.admin@example.test"
FAIL=0

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker rm -f "${CONTAINER}-bootstrap" >/dev/null 2>&1 || true
  if [ -e "$SCRATCH/smoke.pw" ]; then
    shred -u "$SCRATCH/smoke.pw" 2>/dev/null || rm -f "$SCRATCH/smoke.pw"
  fi
  rm -rf "$SCRATCH"
  rm -f "$APP_DIR/.env.smoke.local" "$APP_DIR/.env.smoke.owner.local"
}
trap cleanup EXIT

fail() {
  echo "smoke: FAIL — $1" >&2
  FAIL=1
}

echo "smoke: resetting hr_test to a clean database"
"$PG" psql hr_test --role owner -- -c \
  "DROP TABLE IF EXISTS leave_requests, employees, sessions, audit_events, settings, accounts, schema_migrations CASCADE" \
  >/dev/null || { fail "could not reset hr_test"; exit 1; }

echo "smoke: copying the dev CA into the build context"
mkdir -p "$APP_DIR/certs"
cp "$("$PG" ca)" "$APP_DIR/certs/dev-ca.crt"

echo "smoke: writing container-facing hr_test env files"
"$PG" env hr_test --server host.docker.internal:5432 --write "$APP_DIR/.env.smoke.local" >/dev/null
"$PG" env hr_test --role owner --server host.docker.internal:5432 --write "$APP_DIR/.env.smoke.owner.local" >/dev/null
if ! git -C "$APP_DIR" check-ignore .env.smoke.local .env.smoke.owner.local >/dev/null; then
  fail "the smoke env files are not git-ignored — aborting before any secret could be committed"
  exit 1
fi

echo "smoke: building $IMAGE"
if ! docker build -t "$IMAGE" "$APP_DIR" >"$SCRATCH/build.log" 2>&1; then
  fail "docker build failed — see $SCRATCH/build.log"
  cat "$SCRATCH/build.log" >&2
  exit 1
fi

echo "smoke: manage.mjs migrate"
docker run --rm --env-file "$APP_DIR/.env.smoke.owner.local" "$IMAGE" manage.mjs migrate \
  || { fail "migrate failed"; exit 1; }

echo "smoke: manage.mjs bootstrap (paced pty, generated password)"
SMOKE_PW="$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9')Aa1!"
FIFO="$SCRATCH/bootstrap.fifo"
mkfifo "$FIFO"
(
  exec 3<>"$FIFO" # keeps a writer open so the reader below never sees a premature EOF
  script -qec "docker run --rm -i -t --env-file $APP_DIR/.env.smoke.owner.local --name ${CONTAINER}-bootstrap $IMAGE manage.mjs bootstrap" \
    /dev/null <"$FIFO" >"$SCRATCH/bootstrap.log" 2>&1
) &
BOOTSTRAP_PID=$!
sleep 2
printf '%s\n' "$ADMIN_EMAIL" >"$FIFO"
sleep 2
printf '%s\n' "$SMOKE_PW" >"$FIFO"
sleep 2
printf '%s\n' "$SMOKE_PW" >"$FIFO"
sleep 2
printf '%s\n' "$ORIGIN" >"$FIFO"
wait "$BOOTSTRAP_PID"
BOOTSTRAP_STATUS=$?

BOOTSTRAP_LOG_TEXT="$(cat "$SCRATCH/bootstrap.log" 2>/dev/null || true)"
if [[ "$BOOTSTRAP_LOG_TEXT" == *"$SMOKE_PW"* ]]; then
  fail "the generated password appeared in bootstrap.log"
else
  echo "smoke: 0 secret bytes in bootstrap.log"
fi
if [ "$BOOTSTRAP_STATUS" -ne 0 ]; then
  fail "bootstrap exited $BOOTSTRAP_STATUS"
  exit 1
fi
echo "smoke: bootstrap ok (exit 0)"

install -m 600 /dev/null "$SCRATCH/smoke.pw"
printf '%s' "$SMOKE_PW" >"$SCRATCH/smoke.pw"
unset SMOKE_PW BOOTSTRAP_LOG_TEXT

echo "smoke: manage.mjs seed-demo"
docker run --rm --env-file "$APP_DIR/.env.smoke.owner.local" "$IMAGE" manage.mjs seed-demo \
  || { fail "seed-demo failed"; exit 1; }

echo "smoke: starting the capped, read-only server on $ORIGIN"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" --read-only --cpus=0.5 --memory=1g --memory-swap=1g \
  -p "127.0.0.1:${PORT}:3000" --env-file "$APP_DIR/.env.smoke.local" "$IMAGE" >/dev/null

echo "smoke: waiting for /health/ready"
COLD_START_BEGIN=$(date +%s%N)
READY=0
for _ in $(seq 1 60); do
  if curl -fs "$ORIGIN/health/ready" >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
COLD_START_END=$(date +%s%N)
if [ "$READY" -ne 1 ]; then
  fail "/health/ready never returned 200 within 60s"
  exit 1
fi
echo "smoke: cold start to first /health/ready 200 = $(( (COLD_START_END - COLD_START_BEGIN) / 1000000 ))ms"

echo "smoke: logging in as $ADMIN_EMAIL"
COOKIES="$SCRATCH/cookies.txt"
curl -fs -c "$COOKIES" "$ORIGIN/login" -o "$SCRATCH/login.html"
LOGIN_CSRF="$(grep -o 'name="csrf" value="[^"]*"' "$SCRATCH/login.html" | head -1 | sed -E 's/.*value="([^"]*)"/\1/')"
LOGIN_STATUS="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" -c "$COOKIES" \
  -H "Origin: $ORIGIN" \
  --data-urlencode "email=$ADMIN_EMAIL" \
  --data-urlencode "csrf=$LOGIN_CSRF" \
  --data-urlencode "password@$SCRATCH/smoke.pw" \
  "$ORIGIN/api/login")"
# smoke.pw is deliberately kept: the server-log leak check at the end compares against it.
if [ "$LOGIN_STATUS" != "303" ]; then
  fail "login returned $LOGIN_STATUS, expected 303"
  exit 1
fi
echo "smoke: login ok (303)"

echo "smoke: ${DURATION_SECONDS}s of light traffic (~1 req/s over 4 routes)"
ROUTES=("/" "/directory" "/leave" "/approvals")
STATUS_LOG="$SCRATCH/status.log"
: >"$STATUS_LOG"
START=$(date +%s)
END=$((START + DURATION_SECONDS))
i=0
while [ "$(date +%s)" -lt "$END" ]; do
  ROUTE="${ROUTES[$((i % 4))]}"
  CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "$COOKIES" "$ORIGIN$ROUTE" || echo "000")"
  echo "$CODE" >>"$STATUS_LOG"
  i=$((i + 1))
  sleep 1
done

TOTAL_REQUESTS=$(wc -l <"$STATUS_LOG")
FIVE_XX=$(awk '/^5/{c++} END{print c+0}' "$STATUS_LOG")
NON_200=$(awk '$1!="200"{c++} END{print c+0}' "$STATUS_LOG")
echo "smoke: traffic done — $TOTAL_REQUESTS requests, $NON_200 not-200, $FIVE_XX with a 5xx status"
if [ "$FIVE_XX" -ne 0 ]; then
  fail "$FIVE_XX requests returned a 5xx status"
fi

echo "smoke: peak memory"
MEM_PEAK_BYTES="$(docker exec "$CONTAINER" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo unknown)"
docker stats --no-stream "$CONTAINER" | tee "$SCRATCH/stats.txt"
echo "smoke: memory.peak = ${MEM_PEAK_BYTES} bytes"

echo "smoke: container posture"
docker inspect "$CONTAINER" \
  --format 'ReadonlyRootfs={{.HostConfig.ReadonlyRootfs}} NanoCpus={{.HostConfig.NanoCpus}} Memory={{.HostConfig.Memory}} MemorySwap={{.HostConfig.MemorySwap}} RestartCount={{.RestartCount}} OOMKilled={{.State.OOMKilled}}'
DIFF="$(docker diff "$CONTAINER")"
if [ -n "$DIFF" ]; then
  fail "docker diff is not empty on a --read-only container: $DIFF"
else
  echo "smoke: docker diff empty (no filesystem writes)"
fi

echo "smoke: server log leak check"
docker logs "$CONTAINER" >"$SCRATCH/server.log" 2>&1
SERVER_LOG_TEXT="$(cat "$SCRATCH/server.log")"
ADMIN_PW_CHECK="$(cat "$SCRATCH/smoke.pw" 2>/dev/null || true)"
shred -u "$SCRATCH/smoke.pw" 2>/dev/null || rm -f "$SCRATCH/smoke.pw"
if [ -z "$ADMIN_PW_CHECK" ]; then
  fail "server log leak check has no comparison value (the password file is missing or empty)"
elif [[ "$SERVER_LOG_TEXT" == *"$ADMIN_PW_CHECK"* ]]; then
  fail "the password appeared in the server log"
else
  echo "smoke: 0 secret bytes in server log"
fi
unset SERVER_LOG_TEXT ADMIN_PW_CHECK

if [ "$FAIL" -ne 0 ]; then
  echo "smoke: FAILED — see messages above"
  exit 1
fi
echo "smoke: PASSED"
