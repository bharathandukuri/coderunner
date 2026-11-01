#!/usr/bin/env bash
# scripts/preflight.sh - Preflight verification for CodeRunner production hosts
# Idempotent, safe, and validates host readiness against capacity requirements.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

AUTO_INSTALL_ISOLATE=false

show_help() {
  cat << 'EOF'
Usage: scripts/preflight.sh [OPTIONS]

Performs pre-deployment host system checks for CodeRunner:
  - Docker & Docker Compose v2 versions
  - Linux cgroup v2 unified hierarchy
  - Isolate sandbox availability (auto-installs if requested)
  - Optional gVisor runtime availability
  - RAM & disk capacity requirements against docs/capacity.md
  - Network ports (80/443) and external firewall isolation (2375, 6379)
  - DNS resolution for configured DOMAIN

Options:
  --install-isolate   Automatically run scripts/install-isolate.sh if isolate is missing
  --help, -h          Show this help message and exit
EOF
}

for arg in "$@"; do
  case "$arg" in
    --install-isolate)
      AUTO_INSTALL_ISOLATE=true
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown option: $arg" >&2
      show_help
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "================================================="
echo "  CodeRunner Production Preflight Verification"
echo "================================================="
echo ""

ERRORS=0
WARNINGS=0

# 1. Docker & Docker Compose
echo -n "[1/8] Checking Docker installation... "
if command -v docker >/dev/null 2>&1; then
  DOCKER_VER=$(docker version --format '{{.Server.Version}}' 2>/dev/null || docker --version | awk '{print $3}' | tr -d ',')
  echo -e "${GREEN}✓ (Docker $DOCKER_VER)${NC}"
else
  echo -e "${RED}✗ Docker not installed${NC}"
  ERRORS=$((ERRORS + 1))
fi

echo -n "[2/8] Checking Docker Compose v2... "
if docker compose version >/dev/null 2>&1; then
  COMPOSE_VER=$(docker compose version --short 2>/dev/null || echo "v2+")
  echo -e "${GREEN}✓ (Compose $COMPOSE_VER)${NC}"
else
  echo -e "${RED}✗ Docker Compose v2 plugin missing${NC}"
  ERRORS=$((ERRORS + 1))
fi

# 2. cgroup v2
echo -n "[3/8] Checking Linux cgroup v2 hierarchy... "
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  echo -e "${GREEN}✓ (Unified cgroup v2 active)${NC}"
else
  echo -e "${RED}✗ cgroup v2 not active (/sys/fs/cgroup/cgroup.controllers missing)${NC}"
  echo "      Isolate sandbox requires cgroup v2. Add systemd.unified_cgroup_hierarchy=1 to kernel boot."
  ERRORS=$((ERRORS + 1))
fi

# 3. KVM Check (Not required)
echo -n "[4/8] Checking KVM virtualization... "
if [ -e /dev/kvm ]; then
  echo -e "${GREEN}✓ (KVM detected; hardware virtualization available)${NC}"
else
  echo -e "${YELLOW}ℹ (KVM not detected; optional, CodeRunner uses Docker/cgroups/isolate)${NC}"
fi

# 4. Isolate Sandbox
echo -n "[5/8] Checking Isolate sandbox... "
if command -v isolate >/dev/null 2>&1; then
  ISOLATE_VER=$(isolate --version 2>&1 | head -n 1 || echo "installed")
  echo -e "${GREEN}✓ ($ISOLATE_VER)${NC}"
else
  if [ "$AUTO_INSTALL_ISOLATE" = true ] && [ -f "$SCRIPT_DIR/install-isolate.sh" ]; then
    echo -e "${YELLOW}Missing. Invoking scripts/install-isolate.sh...${NC}"
    bash "$SCRIPT_DIR/install-isolate.sh"
  else
    echo -e "${YELLOW}✗ Isolate binary missing (/usr/local/bin/isolate). Run scripts/install-isolate.sh or pass --install-isolate${NC}"
    WARNINGS=$((WARNINGS + 1))
  fi
fi

# 5. gVisor (Optional)
echo -n "[6/8] Checking gVisor (runsc) runtime... "
if command -v runsc >/dev/null 2>&1; then
  RUNSC_VER=$(runsc --version 2>&1 | head -n 1 || echo "installed")
  echo -e "${GREEN}✓ ($RUNSC_VER)${NC}"
else
  echo -e "${YELLOW}ℹ Optional: gVisor (runsc) not found. Fallback to runc sandbox.${NC}"
fi

# 6. Capacity: RAM & Disk against docs/limits.md formula
echo -n "[7/8] Checking Host RAM and CPU Sizing (docs/limits.md formula)... "
TOTAL_MEM_MB=$(free -m | awk '/^Mem:/{print $2}')
AVAIL_MEM_MB=$(free -m | awk '/^Mem:/{print $7}')
DISK_AVAIL_MB=$(df -m "$PROJECT_DIR" | awk 'NR==2{print $4}')
HOST_VCPUS=$(nproc || echo 1)

# Read sizing parameters from .env if present
W_CONCURRENCY=2
W_DB_CONCURRENCY=2
PG_POOL=2
MY_POOL=2
MONGO_POOL=0
MONITORING_ACTIVE=true

if [ -f "$PROJECT_DIR/.env" ]; then
  W_CONCURRENCY=$(grep '^WORKER_CONCURRENCY=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || echo 2)
  W_DB_CONCURRENCY=$(grep '^WORKER_DB_CONCURRENCY=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || echo 2)
  PG_POOL=$(grep '^POSTGRES_POOL_SIZE=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || echo 2)
  MY_POOL=$(grep '^MYSQL_POOL_SIZE=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || echo 2)
  MONGO_POOL=$(grep '^MONGODB_POOL_SIZE=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"' | tr -d "'" || echo 0)
  if grep -q '^ENABLE_MONITORING=false' "$PROJECT_DIR/.env" 2>/dev/null; then
    MONITORING_ACTIVE=false
  fi
fi

# Fallback defaults for empty values
W_CONCURRENCY=${W_CONCURRENCY:-2}
W_DB_CONCURRENCY=${W_DB_CONCURRENCY:-2}
PG_POOL=${PG_POOL:-2}
MY_POOL=${MY_POOL:-2}
MONGO_POOL=${MONGO_POOL:-0}

# Formula derived in docs/limits.md:
# Base services: 150MB core (360MB with monitoring)
# OS reserve: 350MB
# PostgreSQL: (pool_size + db_concurrency) * 75MB
# MySQL: (pool_size + db_concurrency) * 280MB
# MongoDB: (pool_size > 0 ? (pool_size + db_concurrency) * 250MB : 0)
# Worker Isolate: concurrency * 250MB
BASE_MEM=360
if [ "$MONITORING_ACTIVE" = "false" ]; then
  BASE_MEM=150
fi
OS_RESERVE=350
PG_MEM=$(( (PG_POOL + W_DB_CONCURRENCY) * 75 ))
MY_MEM=$(( (MY_POOL + W_DB_CONCURRENCY) * 280 ))
MONGO_MEM=0
if [ "$MONGO_POOL" -gt 0 ]; then
  MONGO_MEM=$(( (MONGO_POOL + W_DB_CONCURRENCY) * 250 ))
fi
ISO_MEM=$(( W_CONCURRENCY * 250 ))
MEM_MIN_RECOMMENDED=$(( BASE_MEM + OS_RESERVE + PG_MEM + MY_MEM + MONGO_MEM + ISO_MEM ))

# Minimum vCPUs: 1 vCPU for budget concurrency 2, 2 vCPUs for higher concurrency
MIN_VCPUS_RECOMMENDED=1
if [ "$(( W_CONCURRENCY + W_DB_CONCURRENCY ))" -gt 3 ]; then
  MIN_VCPUS_RECOMMENDED=2
fi

DISK_MIN_RECOMMENDED=3072 # 3GB free disk

if [ "$TOTAL_MEM_MB" -ge "$MEM_MIN_RECOMMENDED" ] && [ "$HOST_VCPUS" -ge "$MIN_VCPUS_RECOMMENDED" ]; then
  echo -e "${GREEN}✓ RAM: ${TOTAL_MEM_MB}MB total (min recommended: ${MEM_MIN_RECOMMENDED}MB) | vCPUs: ${HOST_VCPUS} (min: ${MIN_VCPUS_RECOMMENDED})${NC}"
else
  echo -e "${YELLOW}⚠ Sizing warning: Host has ${TOTAL_MEM_MB}MB RAM, ${HOST_VCPUS} vCPUs. Sizing formula recommends >= ${MEM_MIN_RECOMMENDED}MB RAM and >= ${MIN_VCPUS_RECOMMENDED} vCPU(s) for configured concurrency.${NC}"
  WARNINGS=$((WARNINGS + 1))
fi

if [ "$DISK_AVAIL_MB" -lt "$DISK_MIN_RECOMMENDED" ]; then
  echo -e "${YELLOW}⚠ Disk space low: ${DISK_AVAIL_MB}MB available (< ${DISK_MIN_RECOMMENDED}MB recommended)${NC}"
  WARNINGS=$((WARNINGS + 1))
fi

# 7. Ports & Firewall Verification
echo -n "[8/8] Checking Port Availability & Firewall Isolation... "
PORT_ISSUES=0

# Verify ports 80 and 443 are not taken by competing services (other than docker/caddy)
for port in 80 443; do
  local_listeners=$(sudo ss -tulpn 2>/dev/null || ss -tulpn 2>/dev/null || true)
  if echo "$local_listeners" | grep -E ":$port\s" | grep -qvE 'docker|caddy'; then
    # If process name couldn't be resolved or unprivileged, check if Docker is publishing the port
    if ! docker ps --format '{{.Ports}}' 2>/dev/null | grep -q ":$port->"; then
      echo -e "\n${RED}✗ Port $port is already bound by non-CodeRunner service:${NC}"
      echo "$local_listeners" | grep -E ":$port\s"
      PORT_ISSUES=$((PORT_ISSUES + 1))
    fi
  fi
done

# Check external isolation of internal services (Redis 6379 and Docker proxy 2375)
if ss -tulpn 2>/dev/null | grep -E '0\.0\.0\.0:6379|:::6379'; then
  echo -e "\n${RED}✗ Security Alert: Redis port 6379 is exposed on public interface!${NC}"
  PORT_ISSUES=$((PORT_ISSUES + 1))
fi

if ss -tulpn 2>/dev/null | grep -E '0\.0\.0\.0:2375|:::2375'; then
  echo -e "\n${RED}✗ Security Alert: Docker proxy port 2375 is exposed on public interface!${NC}"
  PORT_ISSUES=$((PORT_ISSUES + 1))
fi

if [ "$PORT_ISSUES" -eq 0 ]; then
  echo -e "${GREEN}✓ (Ports 80/443 ready, 2375 & 6379 isolated)${NC}"
else
  ERRORS=$((ERRORS + PORT_ISSUES))
fi

# Optional DOMAIN DNS check if configured in .env
if [ -f "$PROJECT_DIR/.env" ]; then
  CONFIG_DOMAIN=$(grep -E '^DOMAIN=' "$PROJECT_DIR/.env" | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
  if [ -n "$CONFIG_DOMAIN" ]; then
    echo -n "      Checking DNS resolution for DOMAIN=$CONFIG_DOMAIN... "
    if getent ahosts "$CONFIG_DOMAIN" >/dev/null 2>&1; then
      RESOLVED_IP=$(getent ahosts "$CONFIG_DOMAIN" | head -n 1 | awk '{print $1}')
      echo -e "${GREEN}✓ (resolves to $RESOLVED_IP)${NC}"
    else
      echo -e "${YELLOW}⚠ Could not resolve $CONFIG_DOMAIN via DNS${NC}"
      WARNINGS=$((WARNINGS + 1))
    fi
  fi
fi

echo ""
echo "================================================="
if [ "$ERRORS" -eq 0 ]; then
  echo -e "${GREEN}✓ Preflight checks passed successfully (${WARNINGS} warnings).${NC}"
  exit 0
else
  echo -e "${RED}✗ Preflight checks failed with ${ERRORS} error(s). Please address before deploy.${NC}"
  exit 1
fi
