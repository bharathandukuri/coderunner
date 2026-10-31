#!/usr/bin/env bash
# scripts/leak-check.sh - Container and volume leak verification for CodeRunner
# Fails if pool containers leak or dangling anonymous volumes remain.

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

ALLOW_WARM_POOL=false
MAX_EXPECTED_WARM=16

show_help() {
  cat << 'EOF'
Usage: scripts/leak-check.sh [OPTIONS]

Checks Docker for leaked or unmanaged CodeRunner resources:
  - Verifies no dangling anonymous volumes exist
  - Verifies no orphaned or exited warm pool containers remain
  - When stack is stopped, verifies 0 warm pool containers remain

Options:
  --allow-warm-pool       Allow active warm pool containers while the stack is running
  --max-warm <N>          Maximum expected warm containers when allowed (default: 16)
  --help, -h              Show this help message and exit
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --allow-warm-pool)
      ALLOW_WARM_POOL=true
      shift
      ;;
    --max-warm)
      MAX_EXPECTED_WARM="$2"
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

echo "================================================="
echo "  CodeRunner Resource Leak Check"
echo "================================================="

LEAKS_DETECTED=0

# 1. Check Dangling Anonymous Docker Volumes (ignoring named persistent compose volumes)
echo -n "• Checking for dangling anonymous Docker volumes... "
DANGLING_VOLUMES=$(docker volume ls -qf dangling=true 2>/dev/null | grep -E '^[0-9a-f]{64}$' || true)

if [ -n "$DANGLING_VOLUMES" ]; then
  echo -e "${RED}✗ LEAK DETECTED${NC}"
  echo "Found dangling anonymous volumes:"
  echo "$DANGLING_VOLUMES"
  LEAKS_DETECTED=$((LEAKS_DETECTED + 1))
else
  echo -e "${GREEN}✓ Clean (0 dangling anonymous volumes)${NC}"
fi

# 2. Check Warm Pool Containers
echo -n "• Checking warm pool containers (label=com.coderunner.pool=true)... "
POOL_CONTAINERS=$(docker ps -a --filter "label=com.coderunner.pool=true" --format '{{.ID}} {{.Image}} {{.Status}}' 2>/dev/null || true)

if [ -z "$POOL_CONTAINERS" ]; then
  echo -e "${GREEN}✓ Clean (0 pool containers present)${NC}"
else
  TOTAL_COUNT=$(echo "$POOL_CONTAINERS" | wc -l)
  if [ "$ALLOW_WARM_POOL" = true ]; then
    # Check if any container is Exited / Dead
    DEAD_CONTAINERS=$(echo "$POOL_CONTAINERS" | grep -v 'Up ' || true)
    if [ -n "$DEAD_CONTAINERS" ]; then
      echo -e "${RED}✗ DEAD/EXITED POOL CONTAINERS DETECTED${NC}"
      echo "$DEAD_CONTAINERS"
      LEAKS_DETECTED=$((LEAKS_DETECTED + 1))
    elif [ "$TOTAL_COUNT" -gt "$MAX_EXPECTED_WARM" ]; then
      echo -e "${RED}✗ EXCESS POOL CONTAINERS DETECTED ($TOTAL_COUNT > $MAX_EXPECTED_WARM max expected)${NC}"
      echo "$POOL_CONTAINERS"
      LEAKS_DETECTED=$((LEAKS_DETECTED + 1))
    else
      echo -e "${GREEN}✓ OK ($TOTAL_COUNT active running warm containers within limit of $MAX_EXPECTED_WARM)${NC}"
    fi
  else
    echo -e "${RED}✗ LEAK DETECTED (Stack stopped but $TOTAL_COUNT pool container(s) remain)${NC}"
    echo "$POOL_CONTAINERS"
    LEAKS_DETECTED=$((LEAKS_DETECTED + 1))
  fi
fi

# 3. Check for any dead/orphaned runner containers
echo -n "• Checking for orphaned on-demand runner containers... "
ON_DEMAND_LEAKS=$(docker ps -a --filter "label=com.coderunner.token" --format '{{.ID}} {{.Image}} {{.Status}}' 2>/dev/null || true)
if [ -n "$ON_DEMAND_LEAKS" ]; then
  echo -e "${RED}✗ LEAK DETECTED: Untracked on-demand execution containers found:${NC}"
  echo "$ON_DEMAND_LEAKS"
  LEAKS_DETECTED=$((LEAKS_DETECTED + 1))
else
  echo -e "${GREEN}✓ Clean (0 orphaned execution containers)${NC}"
fi

echo ""
echo "================================================="
if [ "$LEAKS_DETECTED" -eq 0 ]; then
  echo -e "${GREEN}✓ Leak verification PASSED. Zero resource leaks detected.${NC}"
  exit 0
else
  echo -e "${RED}✗ Leak verification FAILED with $LEAKS_DETECTED leak issue(s).${NC}"
  exit 1
fi
