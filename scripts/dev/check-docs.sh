#!/usr/bin/env bash
# scripts/dev/check-docs.sh - Validates markdown link/section integrity, env var coverage, and benchmark citations

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  cat << 'EOF'
Usage: scripts/dev/check-docs.sh

Validates:
  1. Internal Markdown link & section anchor integrity in docs/ and README.md
  2. Environment variable reference coverage in docs/limits.md (verifies every env var in config.js and compose files)
  3. Benchmark numbers citation integrity (ensures no VM capacity claims exist without citation to docs/benchmarks/ or a 'TODO: not measured' marker)
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

# ── 1. Check Internal Markdown Links & Section Anchors ────────────────────────
echo "• [1/3] Verifying internal markdown links and section anchors..."
LINK_FAILURES=0

while IFS= read -r md_file; do
  dir=$(dirname "$md_file")
  # Find all markdown links [text](target) excluding external http/https/mailto
  links=$(grep -oE '\[[^]]+\]\([^)]+\)' "$md_file" || true)
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    raw_target=$(echo "$match" | sed -E 's/.*\]\(([^) ]+).*/\1/')
    [ -z "$raw_target" ] && continue

    # Skip external or special protocol links
    if [[ "$raw_target" =~ ^https?:// ]] || [[ "$raw_target" =~ ^mailto: ]] || [[ "$raw_target" =~ ^file:/// ]] || [[ "$raw_target" =~ ^conversation:// ]]; then
      continue
    fi

    target_file=$(echo "$raw_target" | cut -d'#' -f1)
    target_anchor=$(echo "$raw_target" | grep '#' | cut -d'#' -f2- || true)

    # Determine resolved file
    if [ -z "$target_file" ]; then
      resolved_file="$md_file"
    elif [[ "$target_file" == /* ]]; then
      resolved_file="$PROJECT_DIR$target_file"
    else
      resolved_file="$dir/$target_file"
    fi

    # Check file existence
    if [ ! -e "$resolved_file" ]; then
      echo "  ✗ Broken file link in $md_file: target '$target_file' not found"
      LINK_FAILURES=$((LINK_FAILURES + 1))
      continue
    fi

    # Check anchor if specified
    if [ -n "$target_anchor" ] && [[ "$resolved_file" == *.md ]]; then
      # Convert markdown headings to slugs:
      # e.g. "## 1. Automated Deployment" -> "1-automated-deployment"
      slug_found=false
      while IFS= read -r line; do
        heading=$(echo "$line" | sed -E 's/^#+[[:space:]]*//' | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9-' '-' | sed -E 's/^-+|-+$//g')
        if [ "$heading" = "$target_anchor" ]; then
          slug_found=true
          break
        fi
      done < <(grep -E '^#+[[:space:]]+' "$resolved_file" || true)

      if [ "$slug_found" = false ]; then
        echo "  ✗ Broken section anchor in $md_file: '#$target_anchor' not found in $resolved_file"
        LINK_FAILURES=$((LINK_FAILURES + 1))
      fi
    fi
  done <<< "$links"
done < <(find "$PROJECT_DIR/docs" "$PROJECT_DIR/README.md" -name "*.md" 2>/dev/null)

if [ "$LINK_FAILURES" -eq 0 ]; then
  echo "  ✓ All internal markdown links and section anchors valid"
else
  echo "  ✗ Found $LINK_FAILURES broken internal links or section anchors"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── 2. Check Environment Variable Documentation in limits.md ─────────────────
echo "• [2/3] Verifying environment variable coverage in docs/limits.md reference table..."
ENV_FAILURES=0

CONFIG_VARS=$(grep -oE 'process\.env\.[A-Z0-9_]+' "$PROJECT_DIR/src/utils/config.js" | sed 's/process.env.//' | sort -u)
COMPOSE_VARS=$(grep -oE '\$\{([A-Z0-9_]+)' "$PROJECT_DIR/docker-compose.prod.yml" "$PROJECT_DIR/docker-compose.hub.yml" 2>/dev/null | sed 's/.*{//' | sort -u)
ALL_VARS=$(echo -e "${CONFIG_VARS}\n${COMPOSE_VARS}" | sort -u | grep -v '^$')

LIMITS_DOC="$PROJECT_DIR/docs/limits.md"

for var in $ALL_VARS; do
  if ! grep -qE "\|[[:space:]]*\`?${var}\`?[[:space:]]*\|" "$LIMITS_DOC"; then
    echo "  ✗ Missing documentation in docs/limits.md: variable '${var}'"
    ENV_FAILURES=$((ENV_FAILURES + 1))
  fi
done

if [ "$ENV_FAILURES" -eq 0 ]; then
  echo "  ✓ All configuration and compose environment variables documented in docs/limits.md"
else
  echo "  ✗ Found $ENV_FAILURES undocumented environment variables in docs/limits.md"
  ERRORS=$((ERRORS + 1))
fi
echo ""

# ── 3. Check Benchmark Citation Integrity ────────────────────────────────────
echo "• [3/3] Verifying benchmark citation integrity in capacity tables..."
CITE_FAILURES=0

# Scan the Sizing Table in docs/limits.md
# Any row with a VM tier must either cite docs/benchmarks/ or be marked "TODO: not measured" / "Untested"
in_table=false
while IFS= read -r line; do
  if [[ "$line" =~ \|[[:space:]]*\*\*.*vCPU.*RAM\*\* ]]; then
    # This is a VM tier row
    # Check if the row contains an unverified numeric RPS claim without citation or TODO
    if echo "$line" | grep -qE '[0-9]+\.?[0-9]*[[:space:]]*req/s'; then
      if ! echo "$line" | grep -q "benchmarks/"; then
        echo "  ✗ Uncited capacity number found without benchmark link: $line"
        CITE_FAILURES=$((CITE_FAILURES + 1))
      fi
    fi
  fi
done < "$LIMITS_DOC"

if [ "$CITE_FAILURES" -eq 0 ]; then
  echo "  ✓ Sizing table adheres strictly to verified citations and TODO markers"
else
  echo "  ✗ Found $CITE_FAILURES capacity claims missing benchmark citations"
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
