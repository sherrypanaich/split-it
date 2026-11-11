#!/usr/bin/env bash
# Release check: does the Docker image work on a real Docker host?
# Builds the image, starts it with a fresh volume, adds a person with the laptop command, signs in,
# saves something, restarts the container and checks that the sign-in and the data are still there.
#   scripts/smoke-docker.sh            (from the repo root; needs docker and curl)
# Leaves nothing behind unless KEEP=1. SMOKE_PORT picks the port on this computer (default 18080).
set -euo pipefail
cd "$(dirname "$0")/.."

TAG="split-it-smoke-$$"
PORT="${SMOKE_PORT:-18080}"
URL="http://127.0.0.1:${PORT}"
JAR="$(mktemp)"
PASS="smoke-test-password"

step() { printf '\n== %s\n' "$*"; }
fail() { printf '\nFAILED: %s\n' "$*" >&2; docker logs "$TAG" 2>&1 | tail -40 >&2 || true; exit 1; }
cleanup() {
  rm -f "$JAR"
  if [ "${KEEP:-}" = 1 ]; then echo "Kept container, volume and image named $TAG"; return; fi
  docker rm -f "$TAG" >/dev/null 2>&1 || true
  docker volume rm "$TAG" >/dev/null 2>&1 || true
  docker image rm "$TAG" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_up() {
  for _ in $(seq 1 60); do curl -fsS "$URL/manifest.webmanifest" >/dev/null 2>&1 && return 0; sleep 1; done
  fail "the app did not answer on $URL"
}
# api METHOD PATH [JSON]: prints the body, then the status code on its own last line
api() { curl -sS -b "$JAR" -c "$JAR" -X "$1" ${3:+-H 'Content-Type: application/json' --data "$3"} -w '\n%{http_code}' "$URL$2"; }
code() { tail -n1 <<<"$1"; }
body() { sed '$d' <<<"$1"; }

step "Build the image"
docker build -q -t "$TAG" . >/dev/null

step "Start it with an empty volume"
docker volume create "$TAG" >/dev/null
docker run -d --name "$TAG" -p "127.0.0.1:${PORT}:8080" -v "$TAG:/data" \
  --cap-drop ALL --security-opt no-new-privileges:true "$TAG" >/dev/null
wait_up
[ "$(docker exec "$TAG" id -u)" != 0 ] || fail "the app runs as root inside the container"

step "Add a person with the laptop command"
out="$(printf '%s\n' "$PASS" | docker exec -i "$TAG" node server.js add-user Smoke)"
echo "$out"
grep -q 'Added' <<<"$out" || fail "add-user did not add anyone"

step "Sign in and save something"
r="$(api POST /api/login "{\"name\":\"Smoke\",\"password\":\"$PASS\"}")"
[ "$(code "$r")" = 200 ] || fail "sign-in answered $(code "$r"): $(body "$r")"
r="$(api GET /api/me)"
uid="$(body "$r" | grep -o '"uid":"[^"]*"' | cut -d'"' -f4)"
[ -n "$uid" ] || fail "no uid after sign-in: $(body "$r")"
r="$(api POST /api/write "{\"ops\":[{\"op\":\"set\",\"path\":\"people/$uid\",\"data\":{\"nickname\":\"Smokey\",\"joinedAt\":1}}]}")"
[ "$(code "$r")" = 200 ] || fail "saving answered $(code "$r"): $(body "$r")"
r="$(api GET /)"
[ "$(code "$r")" = 200 ] || fail "the app page answered $(code "$r")"
r="$(api GET /vendor/tesseract/worker.min.js)"
[ "$(code "$r")" = 200 ] || fail "the receipt reader is missing from the image ($(code "$r"))"

step "Restart the container"
docker restart "$TAG" >/dev/null
wait_up

step "Still signed in, and the data is still there"
r="$(api GET "/api/doc?path=people/$uid")"
[ "$(code "$r")" = 200 ] || fail "after the restart, reading answered $(code "$r") (signed out?)"
grep -q '"nickname":"Smokey"' <<<"$(body "$r")" || fail "the saved nickname is gone after the restart: $(body "$r")"
rm -f "$JAR"; JAR="$(mktemp)"
r="$(api POST /api/login "{\"name\":\"Smoke\",\"password\":\"$PASS\"}")"
[ "$(code "$r")" = 200 ] || fail "signing in again after the restart answered $(code "$r")"

printf '\nDocker smoke test passed.\n'
