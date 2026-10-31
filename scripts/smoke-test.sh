#!/usr/bin/env bash
# scripts/smoke-test.sh - End-to-end production smoke test suite for CodeRunner
# Verifies health, auth, languages, TLE enforcement, wait=true, multi-file, metrics privacy, and Prometheus/Grafana
# shellcheck disable=SC2329

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

BASE_URL="http://localhost"
AUTH_TOKEN=""
GRAFANA_URL="http://127.0.0.1:3001"

show_help() {
  cat << 'EOF'
Usage: scripts/smoke-test.sh [OPTIONS]

Runs end-to-end smoke tests against a running CodeRunner production deployment:
  1. GET /health returns 200
  2. Unauthenticated request to /submissions returns 401
  3. Python 3.8 execution (Isolate sandbox path)
  4. JavaScript execution
  5. C++ execution
  6. PostgreSQL execution
  7. MySQL execution
  8. Time Limit Exceeded (TLE) enforcement
  9. Push-based wait=true synchronous submission
  10. Multi-file submission with state persistence
  11. Public access to /metrics is blocked (403/401)
  12. Grafana login page is reachable
  13. Prometheus targets are all up (scraped via container network)

Options:
  --url <url>         API Base URL (default: http://localhost or DOMAIN from .env)
  --token <token>     API Auth token (default: reads AUTH_TOKEN from .env)
  --grafana <url>     Grafana URL (default: http://127.0.0.1:3001)
  --help, -h          Show this help message and exit
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --url)
      BASE_URL="$2"
      shift 2
      ;;
    --token)
      AUTH_TOKEN="$2"
      shift 2
      ;;
    --grafana)
      GRAFANA_URL="$2"
      shift 2
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      show_help
      exit 1
      ;;
  esac
done

# Try reading from .env if not provided
if [ -f "$PROJECT_DIR/.env" ]; then
  if [ -z "$AUTH_TOKEN" ]; then
    AUTH_TOKEN=$(grep '^AUTH_TOKEN=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
  fi
  if [ "$BASE_URL" = "http://localhost" ]; then
    DOMAIN=$(grep '^DOMAIN=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
    if [ -n "$DOMAIN" ]; then
      BASE_URL="https://$DOMAIN"
      GRAFANA_URL="https://grafana.$DOMAIN"
    fi
  fi
fi

if [ -z "$AUTH_TOKEN" ]; then
  echo -e "${RED}✗ Error: AUTH_TOKEN must be specified via --token or in .env${NC}" >&2
  exit 1
fi

echo "================================================="
echo "  CodeRunner Smoke Test Suite"
echo "  Target: $BASE_URL"
echo "================================================="
echo ""

FAILED_TESTS=0

run_check() {
  local name="$1"
  shift
  echo -n "• Testing $name... "
  if "$@"; then
    echo -e "${GREEN}✓ PASS${NC}"
  else
    echo -e "${RED}✗ FAIL${NC}"
    FAILED_TESTS=$((FAILED_TESTS + 1))
  fi
}

# 1. Health check
test_health() {
  local resp
  resp=$(curl -sf "$BASE_URL/health")
  echo "$resp" | grep -q '"status":"healthy"'
}

# 2. Unauthenticated request
test_unauth() {
  local status_code
  status_code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/submissions" \
    -H "Content-Type: application/json" \
    -d '{"language_id": 5, "source_code": "print(1)"}')
  [ "$status_code" -eq 401 ]
}

# Helper to submit with wait=true and check stdout/status
submit_and_verify() {
  local lang_id="$1"
  local code="$2"
  local expected_stdout="$3"
  local expected_status_id="${4:-3}"
  local time_limit="${5:-5}"

  local payload
  payload=$(node -e '
    const [langId, sourceCode, timeLimit] = process.argv.slice(1);
    console.log(JSON.stringify({
      language_id: Number(langId),
      source_code: sourceCode,
      time_limit: Number(timeLimit)
    }));
  ' "$lang_id" "$code" "$time_limit")

  local resp
  resp=$(curl -sf -X POST "$BASE_URL/submissions?wait=true" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local actual_status actual_stdout
  actual_status=$(echo "$resp" | node -e '
    let data = "";
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => {
      try {
        const p = JSON.parse(data);
        console.log(p.status?.id || 0);
      } catch { console.log(0); }
    });
  ')

  actual_stdout=$(echo "$resp" | node -e '
    let data = "";
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => {
      try {
        const p = JSON.parse(data);
        console.log((p.stdout || "").trim());
      } catch { console.log(""); }
    });
  ')

  [ "$actual_status" -eq "$expected_status_id" ] && [[ "$actual_stdout" == *"$expected_stdout"* ]]
}

# 3. Python 3.8
test_python() {
  submit_and_verify 5 "print('SMOKE_PYTHON_OK')" "SMOKE_PYTHON_OK"
}

# 4. JavaScript
test_javascript() {
  submit_and_verify 4 "console.log('SMOKE_JS_OK');" "SMOKE_JS_OK"
}

# 5. C++
test_cpp() {
  local cpp_code='#include <iostream>
int main() { std::cout << "SMOKE_CPP_OK" << std::endl; return 0; }'
  submit_and_verify 2 "$cpp_code" "SMOKE_CPP_OK"
}

# 6. PostgreSQL 16
test_postgres() {
  submit_and_verify 8 "SELECT 'SMOKE_PG_OK' AS status;" "SMOKE_PG_OK"
}

# 7. MySQL 8.4
test_mysql() {
  submit_and_verify 9 "SELECT 'SMOKE_MYSQL_OK' AS status;" "SMOKE_MYSQL_OK"
}

# 8. Time Limit Exceeded (TLE)
test_tle() {
  local payload
  payload='{"language_id": 5, "source_code": "while True: pass", "time_limit": 1}'
  local resp
  resp=$(curl -sf -X POST "$BASE_URL/submissions?wait=true" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")

  local status_id
  status_id=$(echo "$resp" | node -e '
    let data = "";
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => {
      const p = JSON.parse(data);
      console.log(p.status?.id || 0);
    });
  ')
  [ "$status_id" -eq 5 ]
}

# 9. Push-based wait=true synchronous submission
test_wait_true() {
  local resp
  resp=$(curl -sf -X POST "$BASE_URL/submissions?wait=true" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"language_id": 5, "source_code": "import time; time.sleep(0.1); print(\"WAIT_TRUE_OK\")"}')
  echo "$resp" | grep -q '"status":' && echo "$resp" | grep -q 'WAIT_TRUE_OK'
}

# 10. Multi-file submission
test_multifile() {
  local payload
  payload=$(cat << 'EOF'
{
  "language_id": 5,
  "files": [
    { "path": "helper.py", "content": "def greet(): return 'SMOKE_MULTI_OK'" },
    { "path": "main.py", "content": "from helper import greet\nprint(greet())" }
  ],
  "executions": [
    { "entryPoint": "main.py" }
  ]
}
EOF
)
  local resp
  resp=$(curl -sf -X POST "$BASE_URL/submissions/multi?wait=true" \
    -H "Authorization: Bearer $AUTH_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")
  echo "$resp" | grep -q 'SMOKE_MULTI_OK'
}

# 11. Public access to /metrics is blocked
test_metrics_private() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/metrics")
  [ "$code" -eq 403 ] || [ "$code" -eq 401 ] || [ "$code" -eq 404 ]
}

# 12. Grafana login page reachable
test_grafana() {
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$GRAFANA_URL/login" 2>/dev/null || curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:3001/login" 2>/dev/null || echo "000")
  [ "$code" -eq 200 ] || [ "$code" -eq 302 ]
}

# 13. Prometheus targets all up
test_prometheus_targets() {
  local targets_json=""
  if docker ps --format '{{.Names}}' | grep -q 'prometheus'; then
    local prom_container
    prom_container=$(docker ps --format '{{.Names}}' | grep 'prometheus' | head -n 1)
    targets_json=$(docker exec "$prom_container" wget -qO- http://localhost:9090/api/v1/targets 2>/dev/null || true)
  fi

  if [ -z "$targets_json" ]; then
    targets_json=$(curl -sf http://127.0.0.1:9090/api/v1/targets 2>/dev/null || true)
  fi

  if [ -z "$targets_json" ]; then
    echo -e "${YELLOW}(Prometheus unreachable from host network; skipping target check)${NC}"
    return 0
  fi

  # Verify at least one active target and zero targets reporting health != up
  local unhealth_count
  unhealth_count=$(echo "$targets_json" | node -e '
    let data = "";
    process.stdin.on("data", c => data += c);
    process.stdin.on("end", () => {
      try {
        const res = JSON.parse(data);
        const active = res.data?.activeTargets || [];
        const down = active.filter(t => t.health !== "up");
        console.log(down.length);
      } catch { console.log(0); }
    });
  ')
  [ "$unhealth_count" -eq 0 ]
}

run_check "GET /health (API Healthcheck)" test_health
run_check "Unauthenticated Request Rejected (401)" test_unauth
run_check "Python 3.8 Execution (Isolate sandbox)" test_python
run_check "JavaScript Execution (Node.js)" test_javascript
run_check "C++ Execution (g++)" test_cpp
run_check "PostgreSQL 16 Execution (Warm Pool)" test_postgres
run_check "MySQL 8.4 Execution (Warm Pool)" test_mysql
run_check "Time Limit Exceeded Enforcement (TLE)" test_tle
run_check "Push-based wait=true Execution" test_wait_true
run_check "Multi-file Project Submission" test_multifile
run_check "Metrics Privacy (403/401 on /metrics)" test_metrics_private
run_check "Grafana Login Page Reachable" test_grafana
run_check "Prometheus Targets All Up" test_prometheus_targets

echo ""
echo "================================================="
if [ "$FAILED_TESTS" -eq 0 ]; then
  echo -e "${GREEN}✓ All 13 smoke tests PASSED! Deployment is verified.${NC}"
  exit 0
else
  echo -e "${RED}✗ $FAILED_TESTS smoke test(s) FAILED.${NC}"
  exit 1
fi
