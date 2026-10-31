#!/bin/bash

# CodeRunner Production Setup Script
# Usage: ./scripts/setup-production.sh [domain]
#
#   With a domain:    ./scripts/setup-production.sh api.coderunner.example.com
#                     Caddy obtains a Let's Encrypt certificate and serves HTTPS.
#                     Requires an A record already pointing at this server.
#
#   Without a domain: ./scripts/setup-production.sh
#                     Serves plain HTTP on the server's IP. No DNS, no SSL.

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# Domain is optional. Without it, CodeRunner serves plain HTTP on this server's IP.
DOMAIN="${1:-}"

if [ -n "$DOMAIN" ]; then
    MODE="domain"
    # Detect the server IP anyway, for the closing summary.
    SERVER_IP="${SERVER_IP:-$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}"
    BASE_URL="https://${DOMAIN}"
else
    MODE="ip"
    SERVER_IP="${SERVER_IP:-$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')}"
    if [ -z "$SERVER_IP" ]; then
        echo -e "${RED}Error: could not determine this server's IP address.${NC}"
        echo "Pass a domain explicitly, or set SERVER_IP before running:"
        echo "  SERVER_IP=203.0.113.10 $0"
        exit 1
    fi
    BASE_URL="http://${SERVER_IP}"
fi

echo "========================================"
echo "  CodeRunner Production Setup"
echo "========================================"
echo ""
if [ "$MODE" = "domain" ]; then
    echo -e "Mode:   ${GREEN}domain + automatic HTTPS${NC}"
    echo -e "Domain: ${GREEN}$DOMAIN${NC}"
else
    echo -e "Mode:   ${YELLOW}IP only, plain HTTP (no domain, no SSL)${NC}"
    echo -e "Address:${GREEN} $SERVER_IP${NC}"
fi
echo ""

# Check if running as root
if [ "$EUID" -eq 0 ]; then
    echo -e "${YELLOW}Warning: Running as root. Consider using a non-root user with sudo.${NC}"
fi

# Detect OS
if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS=$NAME
else
    OS=$(uname -s)
fi

echo "Detected OS: $OS"
echo ""

# Step 1: System updates
echo -e "${GREEN}[1/7] Updating system packages...${NC}"
if command -v apt-get &> /dev/null; then
    sudo apt-get update
    sudo apt-get upgrade -y
elif command -v yum &> /dev/null; then
    sudo yum update -y
fi

# Step 2: Install Docker
echo -e "${GREEN}[2/7] Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com -o get-docker.sh
    sudo sh get-docker.sh
    rm get-docker.sh
    sudo usermod -aG docker $USER
    echo -e "${GREEN}✓ Docker installed${NC}"
else
    echo -e "${GREEN}✓ Docker already installed${NC}"
fi

# Start Docker
sudo systemctl enable docker
sudo systemctl start docker

# Step 3: Install Docker Compose
echo -e "${GREEN}[3/7] Installing Docker Compose...${NC}"
if ! command -v docker-compose &> /dev/null && ! docker compose version &> /dev/null; then
    sudo apt-get install -y docker-compose-plugin || {
        COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/')
        sudo curl -L "https://github.com/docker/compose/releases/download/${COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
    }
    echo -e "${GREEN}✓ Docker Compose installed${NC}"
else
    echo -e "${GREEN}✓ Docker Compose already installed${NC}"
fi

# Step 4: Configure firewall
echo -e "${GREEN}[4/7] Configuring firewall...${NC}"
if command -v ufw &> /dev/null; then
    sudo ufw allow 22/tcp    # SSH
    sudo ufw allow 80/tcp    # HTTP
    sudo ufw allow 443/tcp   # HTTPS
    sudo ufw --force enable
    echo -e "${GREEN}✓ Firewall configured (SSH, HTTP, HTTPS)${NC}"
else
    echo -e "${YELLOW}UFW not found, skipping firewall setup${NC}"
fi

# Step 5: Build database images for worker-db
echo -e "${GREEN}[5/7] Building database runner images (PostgreSQL & MySQL)...${NC}"
if [ -f "./scripts/build-images.sh" ]; then
    ./scripts/build-images.sh postgres mysql
    echo -e "${GREEN}✓ Database images built${NC}"
fi

# Step 6: Create .env file
echo -e "${GREEN}[6/7] Creating configuration...${NC}"
AUTH_TOKEN=$(openssl rand -hex 32)
GRAFANA_PASSWORD=$(openssl rand -hex 16)
METRICS_TOKEN=$(openssl rand -hex 16)

cat > .env << EOF
# Production Configuration
NODE_ENV=production
# Blank => Caddy serves plain HTTP on this server's IP (no SSL).
DOMAIN=${DOMAIN}

# Authentication
AUTH_TOKEN=${AUTH_TOKEN}

# Worker
WORKER_CONCURRENCY=4

# Grafana
GRAFANA_PASSWORD=${GRAFANA_PASSWORD}

# Guards /metrics/* at the proxy. Must be non-empty or Caddy will not start.
METRICS_TOKEN=${METRICS_TOKEN}

# Redis
REDIS_URL=redis://redis:6379
EOF

echo -e "${GREEN}✓ Configuration created${NC}"

# Caddyfile reads SITE_ADDRESS, which docker-compose derives from DOMAIN:
# blank DOMAIN becomes ":80" (plain HTTP on the server IP), a set DOMAIN
# becomes the hostname and Caddy provisions a certificate for it.

# Step 7: Build and start services
echo -e "${GREEN}[7/7] Building and starting services...${NC}"

# Build language images
echo "Building language runtime images..."
./scripts/build-images.sh

# Build and start with docker-compose
echo "Starting services..."
docker compose -f docker-compose.prod.yml build
docker compose -f docker-compose.prod.yml up -d

echo ""
echo "========================================"
echo -e "  ${GREEN}Setup Complete!${NC}"
echo "========================================"
echo ""
if [ "$MODE" = "domain" ]; then
    echo -e "URL:           ${GREEN}${BASE_URL}${NC}"
    echo -e "TLS:           ${GREEN}automatic (Let's Encrypt)${NC}"
else
    echo -e "URL:           ${GREEN}${BASE_URL}${NC}"
    echo -e "TLS:           ${YELLOW}none - traffic and API token travel in cleartext${NC}"
    echo -e "               To add HTTPS later: set DOMAIN in .env, point an A"
    echo -e "               record at ${SERVER_IP}, then re-run:"
    echo -e "                 docker compose -f docker-compose.prod.yml up -d"
fi
echo ""
echo -e "API Token:     ${YELLOW}${AUTH_TOKEN}${NC}"
echo -e "               (save this - you'll need it for API requests)"
echo ""
echo -e "Grafana:       http://localhost:3001 (via SSH tunnel)"
echo -e "Grafana Pass:  ${YELLOW}${GRAFANA_PASSWORD}${NC}"
echo -e "Metrics Token: ${YELLOW}${METRICS_TOKEN}${NC}"
echo ""
echo "Prometheus:    http://localhost:9090 (via SSH tunnel)"
echo ""
echo "========================================"
echo "  Quick Test"
echo "========================================"
echo ""
echo "curl ${BASE_URL}/health"
echo ""
echo "curl -X POST ${BASE_URL}/submissions?wait=true \\"
echo "  -H 'Content-Type: application/json' \\"
echo "  -H 'X-Auth-Token: ${AUTH_TOKEN}' \\"
echo "  -d '{\"source_code\": \"print(1+1)\", \"language_id\": 71}'"
echo ""
echo "========================================"
echo "  Access Grafana via SSH Tunnel"
echo "========================================"
echo ""
echo "ssh -L 3001:localhost:3001 user@${SERVER_IP}"
echo "Then open: http://localhost:3001"
echo ""
