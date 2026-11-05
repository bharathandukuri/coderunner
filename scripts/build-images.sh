#!/usr/bin/env bash
# scripts/build-images.sh - Builds container images for CodeRunner runtime sandboxes

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: scripts/build-images.sh [all]"
  echo "Builds container runtime images needed by enabled languages (or all if 'all' passed)."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Building images from: $PROJECT_DIR"
echo ""

BUILD_ALL=false
if [ "${1:-}" = "all" ]; then
  BUILD_ALL=true
fi

# Determine needed images via language-config.mjs
NEEDED_IMAGES=""
if [ "$BUILD_ALL" = false ]; then
  NEEDED_IMAGES=$(node "$SCRIPT_DIR/dev/language-config.mjs" images 2>/dev/null || true)
fi

should_build() {
  local image="$1"
  if [ "$BUILD_ALL" = true ]; then
    return 0
  fi
  if echo "$NEEDED_IMAGES" | grep -qw "$image"; then
    return 0
  fi
  return 1
}

if [ -d "$PROJECT_DIR/docker/images/python" ] && should_build "coderunner/python:3.8"; then
  echo "Building Python 3.8 image..."
  docker build -t coderunner/python:3.8 "$PROJECT_DIR/docker/images/python/"
fi

if [ -d "$PROJECT_DIR/docker/images/node" ] && should_build "coderunner/node:18"; then
  echo "Building Node.js 18 image..."
  docker build -t coderunner/node:18 "$PROJECT_DIR/docker/images/node/"
fi

if [ -d "$PROJECT_DIR/docker/images/gcc" ] && should_build "coderunner/gcc:9"; then
  echo "Building GCC 9 image..."
  docker build -t coderunner/gcc:9 "$PROJECT_DIR/docker/images/gcc/"
fi

if [ -d "$PROJECT_DIR/docker/images/java" ] && should_build "coderunner/java:17"; then
  echo "Building Java 17 image..."
  docker build -t coderunner/java:17 "$PROJECT_DIR/docker/images/java/"
fi

if [ -d "$PROJECT_DIR/docker/images/typescript" ] && should_build "coderunner/typescript:5"; then
  echo "Building TypeScript 5 image..."
  docker build -t coderunner/typescript:5 "$PROJECT_DIR/docker/images/typescript/"
fi

if [ -d "$PROJECT_DIR/docker/images/sqlite" ] && should_build "coderunner/sqlite:3"; then
  echo "Building SQLite 3 image..."
  docker build -t coderunner/sqlite:3 "$PROJECT_DIR/docker/images/sqlite/"
fi

if [ -d "$PROJECT_DIR/docker/images/postgres" ] && should_build "coderunner/postgres:16"; then
  echo "Building PostgreSQL 16 image..."
  docker build -t coderunner/postgres:16 "$PROJECT_DIR/docker/images/postgres/"
fi

if [ -d "$PROJECT_DIR/docker/images/mysql" ] && should_build "coderunner/mysql:8.4"; then
  echo "Building MySQL 8.4 LTS image..."
  docker build -t coderunner/mysql:8.4 "$PROJECT_DIR/docker/images/mysql/"
fi

if [ -d "$PROJECT_DIR/docker/images/mongodb" ] && should_build "coderunner/mongodb:8.0"; then
  echo "Building MongoDB 8.0 image..."
  docker build -t coderunner/mongodb:8.0 "$PROJECT_DIR/docker/images/mongodb/"
fi

echo ""
echo "All requested container images built successfully."
