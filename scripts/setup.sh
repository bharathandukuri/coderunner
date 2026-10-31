#!/bin/bash

# CodeRunner Setup Script
# Detects system capabilities and sets up the appropriate execution environment

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo "========================================"
echo "  CodeRunner Setup Script"
echo "========================================"
echo ""

# Detect OS
OS=$(uname -s)
ARCH=$(uname -m)

echo "Detected OS: $OS"
echo "Detected Architecture: $ARCH"
echo ""

# Check for isolate compatibility
ISOLATE_COMPATIBLE=false
if command -v isolate &> /dev/null; then
    ISOLATE_COMPATIBLE=true
    echo -e "${GREEN}✓ Isolate is installed${NC}"
else
    echo -e "${YELLOW}ℹ Isolate not found (optional for production sandbox, Docker fallback available)${NC}"
fi
echo ""

# Check Docker
echo "Checking Docker..."
if command -v docker &> /dev/null; then
    echo -e "${GREEN}✓ Docker is installed${NC}"
    if docker info &> /dev/null; then
        echo -e "${GREEN}✓ Docker daemon is running${NC}"
    else
        echo -e "${RED}✗ Docker daemon is not running${NC}"
        echo "  Please start Docker and run this script again"
        exit 1
    fi
else
    echo -e "${RED}✗ Docker is not installed${NC}"
    echo "  Docker is required. Please install Docker and run this script again"
    exit 1
fi
echo ""

# Create .env file
echo "Creating .env file..."
if [ ! -f .env ]; then
    cp .env.example .env
    echo -e "${GREEN}✓ Created .env file${NC}"
else
    echo -e "${YELLOW}  .env already exists, skipping${NC}"
fi
echo ""

echo "Setting up Docker..."
echo "Building Docker images..."
./scripts/build-images.sh

echo -e "${GREEN}✓ Docker setup complete${NC}"

echo ""
echo "========================================"
echo "  Setup Complete!"
echo "========================================"
echo ""
echo -e "Executor: ${YELLOW}Docker${NC} (database pool & container isolation)"
echo ""
echo "Next steps:"
echo "  1. Review .env file and adjust settings"
echo "  2. Run: docker compose up -d"
echo "  3. Test: curl http://localhost:3000/health"
echo ""
