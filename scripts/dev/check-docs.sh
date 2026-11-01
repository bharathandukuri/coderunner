#!/usr/bin/env bash
# scripts/dev/check-docs.sh - Validates internal markdown links and environment variable documentation

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat << 'EOF'
Usage: scripts/dev/check-docs.sh

Validates:
  1. Internal Markdown link integrity in docs/ and README.md (no broken relative links or missing files)
  2. Completeness of environment variable documentation (verifies every env var used in config.js or compose files is documented in markdown tables in docs/)
EOF
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

ERRORS=0

echo "================================================="
echo "  CodeRunner Documentation Quality Checker"
echo "================================================="
echo ""

# ── 1. Check Internal Markdown Links ──────────────────────────────────────────
echo "• [1/2] Verifying internal markdown links..."
LINK_FAILURES=0

while IFS= read -r md_file; do
  dir=$(dirname "$md_file")
  # Find all markdown links [text](target) excluding external http/https/mailto
  # Also ignore file:/// links which are local to specific editor artifacts
  links=$(grep -oE '\[[^]]+\]\([^)]+\)' "$md_file" || true)
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    target=$(echo "$match" | sed -E 's/.*\]\(([^)# ]+).*/\1/')
    [ -z "$target" ] && continue

    # Skip external or protocol links
    if [[ "$target" =~ ^https?:// ]] || [[ "$target" =~ ^mailto: ]] || [[ "$target" =~ ^file:/// ]] || [[ "$target" =~ ^conversation:// ]]; then
      continue
    fi

    # Resolve target path relative to current md file or project root
    if [[ "$target" == /* ]]; then
      resolved="$PROJECT_DIR$target"
    else
      resolved="$dir/$target"
    fi

    # Check existence
    if [ ! -e "$resolved" ] && [ ! -e "$PROJECT_DIR/$target" ]; then
      echo "  ✗ Broken link in $md_file: target '$target' not found"
      LINK_FAILURES=$((LINK_FAILURES + 1))
    fi
  done <<< "$links"
done < <(find "$PROJECT_DIR/docs" "$PROJECT_DIR/README.md" -name "*.md" 2>/dev/null)

if [ "$LINK_FAILURES" -eq 0 ]; then
  echo "  ✓ All internal markdown links valid"
else
  echo "  ✗ Found $LINK_FAILURES broken internal links"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── 2. Check Environment Variable Documentation ──────────────────────────────
echo "• [2/2] Verifying environment variable coverage in docs tables..."
ENV_FAILURES=0

# Extract env vars from src/utils/config.js
CONFIG_VARS=$(grep -oE 'process\.env\.[A-Z0-9_]+' "$PROJECT_DIR/src/utils/config.js" | sed 's/process.env.//' | sort -u)

# Extract env vars from docker-compose.prod.yml and docker-compose.hub.yml
COMPOSE_VARS=$(grep -oE '\$\{([A-Z0-9_]+)' "$PROJECT_DIR/docker-compose.prod.yml" "$PROJECT_DIR/docker-compose.hub.yml" 2>/dev/null | sed 's/.*{//' | sort -u)

ALL_VARS=$(echo -e "${CONFIG_VARS}\n${COMPOSE_VARS}" | sort -u | grep -v '^$')

# Collect all documented variables from docs markdown tables (lines containing `| \`VAR\` |` or `| `VAR` |` or `| VAR |`)
DOCS_CONTENT=$(cat "$PROJECT_DIR"/docs/*.md "$PROJECT_DIR/README.md" 2>/dev/null || true)

for var in $ALL_VARS; do
  # Check if var is present in table format in docs
  if ! echo "$DOCS_CONTENT" | grep -qE "\|[[:space:]]*\`?${var}\`?[[:space:]]*\|"; then
    echo "  ✗ Missing documentation: variable '${var}' not found in docs tables"
    ENV_FAILURES=$((ENV_FAILURES + 1))
  fi
done

if [ "$ENV_FAILURES" -eq 0 ]; then
  echo "  ✓ All configuration and compose environment variables documented in docs tables"
else
  echo "  ✗ Found $ENV_FAILURES undocumented environment variables in docs tables"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── Summary ──────────────────────────────────────────────────────────────────
if [ "$ERRORS" -eq 0 ]; then
  echo "================================================="
  echo "✓ Documentation checks PASSED! Zero issues found."
  echo "================================================="
  exit 0
else
  echo "================================================="
  echo "✗ Documentation checks FAILED with $ERRORS error categories."
  echo "================================================="
  exit 1
fi
