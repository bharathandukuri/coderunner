#!/usr/bin/env bash
# scripts/build-images.sh - Builds container images for CodeRunner runtime sandboxes

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: scripts/build-images.sh"
  echo "Builds all container runtime images (postgres, mysql, multi, python, gcc, java, etc.)."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "Building images from: $PROJECT_DIR"
echo ""

if [ -d "$PROJECT_DIR/docker/images/python" ]; then
  echo "Building Python 3.8 image..."
  docker build -t coderunner/python:3.8 "$PROJECT_DIR/docker/images/python/"
fi

if [ -d "$PROJECT_DIR/docker/images/node" ]; then
  echo "Building Node.js 18 image..."
  docker build -t coderunner/node:18 "$PROJECT_DIR/docker/images/node/"
fi

if [ -d "$PROJECT_DIR/docker/images/gcc" ]; then
  echo "Building GCC 9 image..."
  docker build -t coderunner/gcc:9 "$PROJECT_DIR/docker/images/gcc/"
fi

if [ -d "$PROJECT_DIR/docker/images/java" ]; then
  echo "Building Java 17 image..."
  docker build -t coderunner/java:17 "$PROJECT_DIR/docker/images/java/"
fi

if [ -d "$PROJECT_DIR/docker/images/typescript" ]; then
  echo "Building TypeScript 5 image..."
  docker build -t coderunner/typescript:5 "$PROJECT_DIR/docker/images/typescript/"
fi

if [ -d "$PROJECT_DIR/docker/images/sqlite" ]; then
  echo "Building SQLite 3 image..."
  docker build -t coderunner/sqlite:3 "$PROJECT_DIR/docker/images/sqlite/"
fi

if [ -d "$PROJECT_DIR/docker/images/postgres" ]; then
  echo "Building PostgreSQL 16 image..."
  docker build -t coderunner/postgres:16 "$PROJECT_DIR/docker/images/postgres/"
fi

if [ -d "$PROJECT_DIR/docker/images/mysql" ]; then
  echo "Building MySQL 8.4 LTS image..."
  docker build -t coderunner/mysql:8.4 "$PROJECT_DIR/docker/images/mysql/"
fi

if [ -d "$PROJECT_DIR/docker/images/multi" ]; then
  echo "Building Multi-runtime image..."
  docker build -t coderunner/multi:latest "$PROJECT_DIR/docker/images/multi/"
fi

echo ""
echo "All requested container images built successfully."
