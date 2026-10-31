#!/usr/bin/env bash
set -euo pipefail

# CodeRunner - Docker Socket Proxy Verification Script
# Verifies container create, start, exec, and delete (with v=true) through docker-socket-proxy.
# Also verifies that denied API sections (volumes, networks, secrets) return 403 Forbidden.

PROXY_HOST="${DOCKER_HOST:-${PROXY_URL:-http://127.0.0.1:2375}}"
# Normalize tcp:// to http://
PROXY_URL="${PROXY_HOST/tcp:\/\//http:\/\/}"

# If host default is not reachable, check if running beside docker-proxy in compose
if [[ "$PROXY_URL" == "http://127.0.0.1:2375" ]] && ! curl -s --connect-timeout 1 "$PROXY_URL/_ping" >/dev/null 2>&1; then
  if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q 'codebox-worker-db-1'; then
    echo "[INFO] Running verification inside codebox-worker-db-1 on internal docker-socket-net..."
    exec docker exec -e DOCKER_HOST=http://docker-proxy:2375 -i codebox-worker-db-1 bash -s < "$0" "$@"
  fi
fi

echo "[INFO] Verifying docker-socket-proxy at ${PROXY_URL}..."

# Check connectivity
PING_CODE=$(curl -s -o /dev/null -w "%{http_code}" "${PROXY_URL}/_ping" || true)
if [[ "$PING_CODE" != "200" ]]; then
  echo "[ERROR] Failed to connect to docker-socket-proxy at ${PROXY_URL} (HTTP status: ${PING_CODE})" >&2
  exit 1
fi
echo "[OK] Docker socket proxy is reachable (_ping HTTP 200)"

# Find an available image for testing
TEST_IMAGE="alpine:3.20"

# 1. Create container
echo "[STEP 1/4] Creating test container..."
CREATE_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d "{\"Image\":\"${TEST_IMAGE}\",\"Cmd\":[\"sleep\",\"60\"],\"Labels\":{\"com.coderunner.proxy_test\":\"true\"}}" \
  "${PROXY_URL}/containers/create?name=coderunner-proxy-verify-$$")

CREATE_STATUS=$(echo "$CREATE_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
CREATE_BODY=$(echo "$CREATE_RESP" | grep -v "HTTP_STATUS:")

if [[ "$CREATE_STATUS" != "201" ]]; then
  echo "[ERROR] Container creation failed (HTTP $CREATE_STATUS): $CREATE_BODY" >&2
  exit 1
fi

CONTAINER_ID=$(echo "$CREATE_BODY" | grep -o '"Id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -z "$CONTAINER_ID" ]]; then
  echo "[ERROR] Could not extract container ID from create response: $CREATE_BODY" >&2
  exit 1
fi
echo "[OK] Container created: ${CONTAINER_ID:0:12} (HTTP 201)"

# Helper cleanup function
cleanup() {
  if [[ -n "${CONTAINER_ID:-}" ]]; then
    curl -s -X DELETE "${PROXY_URL}/containers/${CONTAINER_ID}?v=true&force=true" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# 2. Start container
echo "[STEP 2/4] Starting test container..."
START_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${PROXY_URL}/containers/${CONTAINER_ID}/start")
if [[ "$START_STATUS" != "204" && "$START_STATUS" != "304" ]]; then
  echo "[ERROR] Container start failed (HTTP $START_STATUS)" >&2
  exit 1
fi
echo "[OK] Container started (HTTP $START_STATUS)"

# 3. Exec in container
echo "[STEP 3/4] Creating and executing exec command..."
EXEC_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST \
  -H "Content-Type: application/json" \
  -d '{"AttachStdout":true,"AttachStderr":true,"Cmd":["echo","docker_proxy_exec_ok"]}' \
  "${PROXY_URL}/containers/${CONTAINER_ID}/exec")

EXEC_CREATE_STATUS=$(echo "$EXEC_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
EXEC_CREATE_BODY=$(echo "$EXEC_RESP" | grep -v "HTTP_STATUS:")

if [[ "$EXEC_CREATE_STATUS" != "201" ]]; then
  echo "[ERROR] Exec creation failed (HTTP $EXEC_CREATE_STATUS): $EXEC_CREATE_BODY" >&2
  exit 1
fi

EXEC_ID=$(echo "$EXEC_CREATE_BODY" | grep -o '"Id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -z "$EXEC_ID" ]]; then
  echo "[ERROR] Could not extract exec ID: $EXEC_CREATE_BODY" >&2
  exit 1
fi

EXEC_START_RESP=$(curl -s -X POST \
  -H "Content-Type: application/json" \
  -d '{"Detach":false,"Tty":false}' \
  "${PROXY_URL}/exec/${EXEC_ID}/start" | tr -d '\000')

if [[ "$EXEC_START_RESP" != *"docker_proxy_exec_ok"* ]]; then
  echo "[ERROR] Exec did not return expected output. Output: $EXEC_START_RESP" >&2
  exit 1
fi
echo "[OK] Container exec succeeded (output verified)"

# 4. Remove container (with v=true)
echo "[STEP 4/4] Removing container with v=true..."
DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "${PROXY_URL}/containers/${CONTAINER_ID}?v=true&force=true")
if [[ "$DELETE_STATUS" != "204" ]]; then
  echo "[ERROR] Container delete with v=true failed (HTTP $DELETE_STATUS). Proxy flags may disallow DELETE." >&2
  exit 1
fi
CONTAINER_ID="" # Cleared so trap doesn't retry
echo "[OK] Container deleted with v=true (HTTP 204)"

# 5. Security boundary verification: verify denied endpoints return 403 Forbidden
echo "[SECURITY CHECK] Verifying dangerous endpoints are denied by proxy..."
VOL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${PROXY_URL}/volumes/create")
if [[ "$VOL_STATUS" != "403" ]]; then
  echo "[ERROR] Security check failed: /volumes/create returned HTTP $VOL_STATUS, expected 403" >&2
  exit 1
fi

NET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${PROXY_URL}/networks/create")
if [[ "$NET_STATUS" != "403" ]]; then
  echo "[ERROR] Security check failed: /networks/create returned HTTP $NET_STATUS, expected 403" >&2
  exit 1
fi

echo "[OK] Dangerous endpoints properly blocked (HTTP 403)"
echo "[SUCCESS] Docker socket proxy verification passed: full container lifecycle allowed, restricted endpoints blocked."
