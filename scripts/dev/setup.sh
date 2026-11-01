#!/usr/bin/env bash
# scripts/dev/setup.sh - Local development environment setup for CodeRunner

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: scripts/dev/setup.sh"
  echo "Sets up local development environment: checks Docker, cgroups v2, isolate, creates .env, and builds images."
  exit 0
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo "========================================"
echo "  CodeRunner Setup Script"
echo "========================================"
echo ""

OS=$(uname -s)
ARCH=$(uname -m)
echo "Detected OS: $OS ($ARCH)"
echo ""

# ── 1. Docker ────────────────────────────────────────────────────────────────
echo -e "${BOLD}[1/5] Checking Docker...${NC}"
if ! command -v docker &> /dev/null; then
    echo -e "${RED}✗ Docker is not installed.${NC}"
    echo "  Install Docker: https://docs.docker.com/engine/install/"
    exit 1
fi
echo -e "${GREEN}✓ Docker binary found${NC}"

if ! docker info &> /dev/null; then
    echo -e "${RED}✗ Docker daemon is not running.${NC}"
    echo "  Start it with: sudo systemctl start docker"
    exit 1
fi
echo -e "${GREEN}✓ Docker daemon is running${NC}"
echo ""

# ── 2. cgroups v2 ────────────────────────────────────────────────────────────
echo -e "${BOLD}[2/5] Checking cgroups v2 (required for isolate)...${NC}"
CGROUP_V2=false
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
    CGROUP_V2=true
    echo -e "${GREEN}✓ cgroups v2 unified hierarchy detected${NC}"
else
    echo -e "${YELLOW}⚠ cgroups v2 not found — isolate requires it.${NC}"
    echo "  On systemd hosts: add 'systemd.unified_cgroup_hierarchy=1' to kernel cmdline and reboot."
fi
echo ""

# ── 3. Isolate ───────────────────────────────────────────────────────────────
echo -e "${BOLD}[3/5] Checking isolate...${NC}"
ISOLATE_COMPATIBLE=false
if command -v isolate &> /dev/null; then
    ISOLATE_COMPATIBLE=true
    ISOLATE_VER=$(isolate --version 2>&1 | head -1 || echo "unknown version")
    echo -e "${GREEN}✓ isolate is installed ($ISOLATE_VER)${NC}"
    if [ "$CGROUP_V2" = "false" ]; then
        echo -e "${YELLOW}  ⚠ isolate found but cgroups v2 is absent — it will not function correctly.${NC}"
        ISOLATE_COMPATIBLE=false
    fi
else
    echo -e "${YELLOW}ℹ isolate not found.${NC}"
    echo "  Install guide: https://github.com/ioi/isolate"
    echo "  Without it the worker falls back to Docker-mode execution (safe, slightly slower)."
fi
echo ""

# ── 4. gVisor (runsc) ────────────────────────────────────────────────────────
echo -e "${BOLD}[4/5] Checking gVisor (runsc)...${NC}"
GVISOR_AVAILABLE=false
if command -v runsc &> /dev/null; then
    GVISOR_AVAILABLE=true
    RUNSC_VER=$(runsc --version 2>&1 | head -1 || echo "unknown version")
    echo -e "${GREEN}✓ gVisor runsc is installed ($RUNSC_VER)${NC}"
    # Verify Docker knows about the runtime
    if docker info 2>/dev/null | grep -q "runsc"; then
        echo -e "${GREEN}✓ Docker recognises 'runsc' runtime${NC}"
    else
        echo -e "${YELLOW}  ⚠ runsc found but Docker does not list it as a runtime.${NC}"
        echo "  Add to /etc/docker/daemon.json:"
        echo '    { "runtimes": { "runsc": { "path": "/usr/local/bin/runsc" } } }'
        echo "  Then restart Docker: sudo systemctl restart docker"
        GVISOR_AVAILABLE=false
    fi
else
    echo -e "${YELLOW}ℹ gVisor (runsc) not found — containers will run with the default runc runtime.${NC}"
    echo "  Install guide: https://gvisor.dev/docs/user_guide/install/"
    echo "  After installing, set DOCKER_RUNTIME=runsc in .env to enable it."
fi
echo ""

# ── 5. .env + images ─────────────────────────────────────────────────────────
echo -e "${BOLD}[5/5] Creating .env and building Docker images...${NC}"
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ Created .env from .env.example${NC}"
else
    echo -e "${YELLOW}  .env already exists — skipping copy${NC}"
fi

# Patch DOCKER_RUNTIME if gVisor is fully available
if [ "$GVISOR_AVAILABLE" = "true" ]; then
    if ! grep -q "^DOCKER_RUNTIME=" .env; then
        echo "DOCKER_RUNTIME=runsc" >> .env
        echo -e "${GREEN}✓ Set DOCKER_RUNTIME=runsc in .env${NC}"
    else
        echo -e "${GREEN}✓ DOCKER_RUNTIME already set in .env${NC}"
    fi
fi

echo ""
echo "Building Docker images..."
./scripts/build-images.sh
echo -e "${GREEN}✓ Docker images built${NC}"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "========================================"
echo -e "  ${GREEN}Setup Complete!${NC}"
echo "========================================"
echo ""

# Show capability matrix
printf "  %-28s %s\n" "Docker daemon:"       "$(docker --version | cut -d' ' -f3 | tr -d ',')"
if [ "$ISOLATE_COMPATIBLE" = "true" ]; then
    printf "  ${GREEN}%-28s %s${NC}\n" "Isolate (fast sandbox):" "✓ available  →  WORKER_TYPE=isolate in prod"
else
    printf "  ${YELLOW}%-28s %s${NC}\n" "Isolate (fast sandbox):" "✗ not available  →  Docker fallback"
fi
if [ "$GVISOR_AVAILABLE" = "true" ]; then
    printf "  ${GREEN}%-28s %s${NC}\n" "gVisor (runsc):" "✓ active  →  DOCKER_RUNTIME=runsc set"
else
    printf "  ${YELLOW}%-28s %s${NC}\n" "gVisor (runsc):" "✗ not active  →  default runc"
fi
if [ "$CGROUP_V2" = "true" ]; then
    printf "  ${GREEN}%-28s %s${NC}\n" "cgroups v2:" "✓ present"
else
    printf "  ${YELLOW}%-28s %s${NC}\n" "cgroups v2:" "✗ absent  (needed for isolate)"
fi
echo ""
echo "Next steps:"
echo "  1. Review .env and adjust limits / tokens"
echo "  2. Run: docker compose up -d"
echo "  3. Test: curl http://localhost:3000/health"
echo ""
