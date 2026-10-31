#!/usr/bin/env bash

# CodeRunner - Automated Isolate Sandbox Installer
# Builds and configures isolate with cgroups v2 support on Ubuntu/Debian hosts.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo "========================================"
echo "  CodeRunner - Install Isolate Sandbox"
echo "========================================"
echo ""

# Check cgroups v2
if [ ! -f /sys/fs/cgroup/cgroup.controllers ]; then
    echo -e "${RED}✗ cgroups v2 unified hierarchy not found.${NC}"
    echo "  Isolate requires cgroups v2. Add 'systemd.unified_cgroup_hierarchy=1' to kernel cmdline and reboot."
    exit 1
fi
echo -e "${GREEN}✓ cgroups v2 verified${NC}"

echo -e "${GREEN}[1/4] Installing build dependencies...${NC}"
sudo apt-get update -y
sudo apt-get install -y git build-essential libcap-dev libsystemd-dev libseccomp-dev pkg-config

echo -e "${GREEN}[2/4] Cloning and building isolate...${NC}"
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT
git clone https://github.com/ioi/isolate.git "$BUILD_DIR"
make -C "$BUILD_DIR" isolate

echo -e "${GREEN}[3/4] Installing binaries and systemd slice...${NC}"
sudo make -C "$BUILD_DIR" install

echo -e "${GREEN}[4/4] Setting up isolate user, subuid/subgid and cgroup keeper service...${NC}"
sudo useradd -r -s /usr/sbin/nologin isolate 2>/dev/null || true
if ! grep -q "^isolate:" /etc/subuid 2>/dev/null; then
    echo "isolate:100000:65536" | sudo tee -a /etc/subuid >/dev/null
fi
if ! grep -q "^isolate:" /etc/subgid 2>/dev/null; then
    echo "isolate:100000:65536" | sudo tee -a /etc/subgid >/dev/null
fi

sudo systemctl daemon-reload
sudo systemctl enable --now isolate.service

echo "Verifying isolate cgroups sandbox..."
if sudo isolate --cg -b 0 --init >/dev/null && \
   sudo isolate --cg -b 0 -p --run -- /bin/echo "isolate_sandbox_ok" >/dev/null && \
   sudo isolate --cg -b 0 --cleanup >/dev/null; then
    echo -e "${GREEN}✓ Isolate cgroups v2 sandbox verified and functional!${NC}"
else
    echo -e "${RED}Warning: isolate sandbox execution failed. Check isolate.service status.${NC}"
fi

echo ""
echo "========================================"
echo -e "${GREEN}  Isolate Installation Complete!${NC}"
echo "========================================"
echo "Version: $(isolate --version | head -1)"
echo ""

