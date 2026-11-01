#!/usr/bin/env bash
# scripts/install-gvisor.sh - Installs gVisor (runsc) runtime and configures Docker daemon

set -euo pipefail

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo "Usage: scripts/install-gvisor.sh"
  echo "Installs gVisor (runsc) runtime and configures Docker daemon on Linux hosts."
  exit 0
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "========================================"
echo "  CodeRunner - Install gVisor (runsc)"
echo "========================================"
echo ""

ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ] && [ "$ARCH" != "aarch64" ]; then
    echo -e "${RED}Unsupported architecture: $ARCH. gVisor supports x86_64 and aarch64.${NC}" >&2
    exit 1
fi

if command -v apt-get &>/dev/null; then
    echo -e "${GREEN}[1/3] Setting up official gVisor apt repository...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y apt-transport-https ca-certificates curl gnupg

    sudo mkdir -p /etc/apt/keyrings /usr/share/keyrings
    curl -fsSL https://gvisor.dev/archive.key | sudo gpg --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg

    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" | sudo tee /etc/apt/sources.list.d/gvisor.list > /dev/null

    echo -e "${GREEN}[2/3] Installing runsc...${NC}"
    sudo apt-get update -y
    sudo apt-get install -y runsc
else
    echo -e "${GREEN}[1/3] Downloading gVisor release tarball for ${ARCH}...${NC}"
    URL="https://storage.googleapis.com/gvisor/releases/release/latest/${ARCH}"
    TEMP_DIR=$(mktemp -d)
    trap 'rm -rf "$TEMP_DIR"' EXIT

    curl -fsSL "${URL}/gvisor.tar.gz" -o "${TEMP_DIR}/gvisor.tar.gz" 2>/dev/null || \
    curl -fsSL "${URL}/gvisor.tar.bz2" -o "${TEMP_DIR}/gvisor.tar.bz2" 2>/dev/null || \
    wget -q "${URL}/gvisor.tar.zstd" -O "${TEMP_DIR}/gvisor.tar.zstd"

    echo -e "${GREEN}[2/3] Extracting binaries to /usr/local/bin...${NC}"
    if [ -f "${TEMP_DIR}/gvisor.tar.gz" ]; then
        sudo tar -xzf "${TEMP_DIR}/gvisor.tar.gz" -C /usr/local/bin
    elif [ -f "${TEMP_DIR}/gvisor.tar.bz2" ]; then
        sudo tar -xjf "${TEMP_DIR}/gvisor.tar.bz2" -C /usr/local/bin
    elif [ -f "${TEMP_DIR}/gvisor.tar.zstd" ]; then
        sudo tar --zstd -xf "${TEMP_DIR}/gvisor.tar.zstd" -C /usr/local/bin
    fi
fi

RUNSC_VERSION=$(runsc --version | head -n 1)
echo -e "${GREEN}✓ Installed: ${RUNSC_VERSION}${NC}"

echo -e "${GREEN}[3/3] Registering runsc with Docker...${NC}"
sudo runsc install

echo "Reloading Docker daemon configuration..."
sudo systemctl reload docker 2>/dev/null || sudo systemctl restart docker

# Verify Docker detects it
if docker info 2>/dev/null | grep -i "runsc" >/dev/null; then
    echo -e "${GREEN}✓ Docker successfully configured with 'runsc' runtime!${NC}"
else
    echo -e "${YELLOW}Testing runsc directly via Docker container...${NC}"
fi

echo "Smoke testing container with --runtime=runsc..."
if docker run --rm --runtime=runsc alpine echo "gVisor works!" >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Docker gVisor runtime verified and functional!${NC}"
else
    echo -e "${RED}Warning: smoke test container with --runtime=runsc failed. Check daemon.json and journalctl -u docker${NC}"
fi

echo ""
echo "========================================"
echo -e "${GREEN}  gVisor Installation Complete!${NC}"
echo "========================================"
echo "You can now run containers with gVisor using: --runtime=runsc"
echo "Or configure DOCKER_RUNTIME=runsc in CodeRunner .env"
echo ""
