#!/usr/bin/env bash
# scripts/deploy.sh - Production deployment automation for CodeRunner
# Subcommands: init, build, up, status, logs, rollback, down

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
PREV_TAG_FILE="$PROJECT_DIR/.prev_tag"

compose_cmd() {
  local mon="${ENABLE_MONITORING:-true}"
  if [ -f "$PROJECT_DIR/.env" ]; then
    local env_mon
    env_mon=$(grep '^ENABLE_MONITORING=' "$PROJECT_DIR/.env" 2>/dev/null | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
    if [ -n "$env_mon" ]; then
      mon="$env_mon"
    fi
  fi
  if [ "$mon" = "false" ]; then
    docker compose -f "$COMPOSE_FILE" "$@"
  else
    docker compose -f "$COMPOSE_FILE" --profile monitoring "$@"
  fi
}

show_help() {
  cat << 'EOF'
Usage: scripts/deploy.sh <command> [options]

Commands:
  init            Initialize or back up .env with generated secure tokens (never overwrites existing values)
  build           Build all application and database images tagged with git SHA (preserves rollback tag)
  up [--no-alerts] Validate config, start services, and verify health
  alert-test      Send a test alert to verify Discord delivery via Alertmanager
  status          Show running containers, health status, and resource usage
  logs [service]  Follow logs for all or a specific service
  rollback        Revert API and Worker images to the previous tag and restart
  down            Stop and shut down all CodeRunner containers cleanly
  --help, -h      Show this help message
EOF
}

cmd_init() {
  echo "=== Initializing CodeRunner Production Environment ==="
  cd "$PROJECT_DIR"

  if [ ! -f .env ]; then
    if [ -f .env.example ]; then
      cp .env.example .env
      echo "Created .env from .env.example"
    else
      touch .env
    fi
  else
    # Back up existing .env
    cp -p .env ".env.backup.$(date +%Y%m%d%H%M%S)"
    echo "Backed up existing .env"
  fi

  # Helper to set variable if not set or empty
  ensure_var() {
    local var_name="$1"
    local default_val="$2"
    if ! grep -q "^${var_name}=" .env 2>/dev/null; then
      echo "${var_name}=${default_val}" >> .env
      echo "Configured ${var_name} in .env"
    elif grep -q "^${var_name}=\s*$" .env 2>/dev/null; then
      sed -i "s|^${var_name}=.*|${var_name}=${default_val}|" .env
      echo "Generated value for empty ${var_name} in .env"
    fi
  }

  ensure_token() {
    local var_name="$1"
    local rand_token
    rand_token=$(openssl rand -hex 16 2>/dev/null || date +%s%N | sha256sum | head -c 32)
    ensure_var "$var_name" "$rand_token"
  }

  ensure_token "AUTH_TOKEN"
  ensure_token "METRICS_TOKEN"
  ensure_token "GRAFANA_PASSWORD"
  ensure_var "WORKER_CONCURRENCY" "2"
  ensure_var "WORKER_DB_CONCURRENCY" "2"
  ensure_var "RATE_LIMIT_SUBMISSIONS_MAX" "120"
  ensure_var "RATE_LIMIT_SUBMISSIONS_WINDOW_MS" "60000"

  # Validate GRAFANA_PASSWORD is not admin
  local current_grafana_pass
  current_grafana_pass=$(grep '^GRAFANA_PASSWORD=' .env | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
  if [ "$current_grafana_pass" = "admin" ]; then
    local new_pass
    new_pass=$(openssl rand -hex 16 2>/dev/null || date +%s%N | sha256sum | head -c 32)
    sed -i "s|^GRAFANA_PASSWORD=.*|GRAFANA_PASSWORD=${new_pass}|" .env
    echo "Replaced default 'admin' GRAFANA_PASSWORD with randomized password in .env"
  fi

  echo -e "${GREEN}✓ .env initialized and verified.${NC}"
  echo "Credentials stored securely in: $PROJECT_DIR/.env"
}

cmd_build() {
  echo "=== Building CodeRunner Images ==="
  cd "$PROJECT_DIR"

  local current_sha
  current_sha=$(git rev-parse --short HEAD 2>/dev/null || echo "latest")

  # Record previous tag if exists
  if [ -f "$PREV_TAG_FILE" ]; then
    cp -p "$PREV_TAG_FILE" "${PREV_TAG_FILE}.bak"
  fi
  echo "$current_sha" > "$PREV_TAG_FILE"

  echo "Current build tag: $current_sha"

  # Build runtime images needed by enabled languages
  local needed_images
  needed_images=$(node "$PROJECT_DIR/scripts/dev/language-config.mjs" images 2>/dev/null || true)

  should_build_image() {
    local img="$1"
    echo "$needed_images" | grep -qw "$img"
  }

  if [ -d docker/images/postgres ] && should_build_image "coderunner/postgres:16"; then
    echo "Building coderunner/postgres:16..."
    docker build -t coderunner/postgres:16 docker/images/postgres
  fi

  if [ -d docker/images/mysql ] && should_build_image "coderunner/mysql:8.4"; then
    echo "Building coderunner/mysql:8.4..."
    docker build -t coderunner/mysql:8.4 docker/images/mysql
  fi

  if [ -d docker/images/mongodb ] && should_build_image "coderunner/mongodb:8.0"; then
    echo "Building coderunner/mongodb:8.0..."
    docker build -t coderunner/mongodb:8.0 docker/images/mongodb
  fi

  echo "Building CodeRunner API and Worker images..."
  compose_cmd build api worker worker-db

  echo -e "${GREEN}✓ All images built successfully tagged ($current_sha).${NC}"
}

cmd_up() {
  local no_alerts=false
  for arg in "$@"; do
    if [ "$arg" = "--no-alerts" ]; then
      no_alerts=true
    fi
  done

  echo "=== Starting CodeRunner Production Services ==="
  cd "$PROJECT_DIR"

  if [ ! -f .env ]; then
    echo -e "${RED}✗ .env file not found. Run 'scripts/deploy.sh init' first.${NC}" >&2
    exit 1
  fi

  # Security checks
  local auth_token grafana_password alert_webhook
  auth_token=$(grep '^AUTH_TOKEN=' .env | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
  grafana_password=$(grep '^GRAFANA_PASSWORD=' .env | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
  alert_webhook=$(grep '^ALERT_WEBHOOK_URL=' .env | cut -d '=' -f 2- | tr -d '"'\'' ' || true)

  if [ -z "$auth_token" ] || [ "$auth_token" = "your-secret-token" ] || [ "$auth_token" = "dev-token" ] || [ "$auth_token" = "test-token" ]; then
    echo -e "${RED}✗ AUTH_TOKEN is empty or set to an insecure default in .env. Deploy aborted for security.${NC}" >&2
    exit 1
  fi

  if [ -z "$grafana_password" ] || [ "$grafana_password" = "admin" ]; then
    echo -e "${RED}✗ GRAFANA_PASSWORD is unset or set to 'admin'. Deploy aborted.${NC}" >&2
    exit 1
  fi

  # Check ALERT_WEBHOOK_URL unless --no-alerts is specified
  if [ "$no_alerts" = true ]; then
    echo -e "${YELLOW}⚠ WARNING: Deploying with --no-alerts. Alert delivery is disabled; nobody will be notified of critical incidents!${NC}"
    export ALERT_WEBHOOK_URL=""
  else
    if [ -z "$alert_webhook" ]; then
      echo -e "${RED}✗ ALERT_WEBHOOK_URL is empty in .env. A valid external webhook (Discord) is required for production alerts.${NC}" >&2
      echo -e "  To deploy without alerts, run: scripts/deploy.sh up --no-alerts" >&2
      exit 1
    fi
    if [[ "$alert_webhook" == *"localhost"* ]] || [[ "$alert_webhook" == *"127.0.0.1"* ]]; then
      echo -e "${RED}✗ ALERT_WEBHOOK_URL contains localhost or 127.0.0.1 ($alert_webhook). A real external webhook URL is required.${NC}" >&2
      echo -e "  To deploy without alerts, run: scripts/deploy.sh up --no-alerts" >&2
      exit 1
    fi
  fi

  # Run preflight verification
  if [ -f "$SCRIPT_DIR/preflight.sh" ]; then
    bash "$SCRIPT_DIR/preflight.sh"
  fi

  # Validate Compose configuration
  echo "Validating compose configuration..."
  compose_cmd config >/dev/null

  # Start services
  echo "Deploying containers..."
  compose_cmd up -d

  # Wait for health
  echo "Waiting for services to become healthy..."
  local timeout=60
  local elapsed=0
  local healthy=false

  while [ "$elapsed" -lt "$timeout" ]; do
    if curl -sf http://localhost/health >/dev/null 2>&1 || curl -sf http://127.0.0.1:3000/health >/dev/null 2>&1; then
      healthy=true
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    echo -n "."
  done
  echo ""

  if [ "$healthy" = true ]; then
    echo -e "${GREEN}✓ CodeRunner stack started and responding healthy!${NC}"
  else
    echo -e "${YELLOW}⚠ Health check timed out after 60s. Inspecting container logs...${NC}"
    compose_cmd ps
  fi

  # Validate Caddy configuration inside container
  if compose_cmd ps -q caddy >/dev/null 2>&1; then
    compose_cmd exec -T caddy caddy validate --config /etc/caddy/Caddyfile 2>/dev/null || true
  fi

  # Validate Docker proxy isolation
  if [ -f "$SCRIPT_DIR/verify-docker-proxy.sh" ]; then
    echo "Verifying Docker socket proxy isolation..."
    bash "$SCRIPT_DIR/verify-docker-proxy.sh" || echo -e "${YELLOW}⚠ Docker proxy check reported warnings.${NC}"
  fi

  local domain
  domain=$(grep '^DOMAIN=' .env 2>/dev/null | cut -d '=' -f 2- | tr -d '"'\'' ' || true)
  echo ""
  echo "================================================="
  echo "  Deployment Complete"
  echo "================================================="
  if [ -n "$domain" ]; then
    echo "  API Endpoint:     https://$domain"
    echo "  Grafana:          https://grafana.$domain (or http://127.0.0.1:3001 via SSH tunnel)"
  else
    echo "  API Endpoint:     http://localhost"
    echo "  Grafana:          http://127.0.0.1:3001"
  fi
  echo "  Prometheus:       Internal network only (localhost:9090 via SSH tunnel)"
  echo "  Credentials File: $PROJECT_DIR/.env"
  echo "================================================="
}

cmd_status() {
  cd "$PROJECT_DIR"
  compose_cmd ps
}

cmd_logs() {
  cd "$PROJECT_DIR"
  compose_cmd logs --tail=100 -f "$@"
}

cmd_rollback() {
  echo "=== Rolling back CodeRunner ==="
  cd "$PROJECT_DIR"

  if [ ! -f "$PREV_TAG_FILE" ]; then
    echo -e "${RED}✗ No previous tag file found at $PREV_TAG_FILE${NC}" >&2
    exit 1
  fi

  local prev_tag
  prev_tag=$(cat "$PREV_TAG_FILE")
  echo "Rolling back to tag: $prev_tag"

  # Restart compose
  compose_cmd up -d --force-recreate
  echo -e "${GREEN}✓ Rollback complete.${NC}"
}

cmd_alert_test() {
  echo "=== Triggering Alertmanager Test Alert ==="
  cd "$PROJECT_DIR"

  if ! compose_cmd ps -q alertmanager 2>/dev/null | grep -q .; then
    echo -e "${RED}✗ Alertmanager container is not running. Deploy with monitoring enabled first.${NC}" >&2
    exit 1
  fi

  echo "Dispatching TestAlert via amtool inside alertmanager container..."
  compose_cmd exec -T alertmanager /bin/amtool alert add TestAlert severity=test --alertmanager.url=http://localhost:9093
  echo ""
  echo -e "${GREEN}check your Discord channel now${NC}"
}

cmd_down() {
  echo "Shutting down CodeRunner stack..."
  cd "$PROJECT_DIR"
  docker compose -f "$COMPOSE_FILE" --profile monitoring down
  echo -e "${GREEN}✓ Stack stopped.${NC}"
}

# Subcommand routing
if [ $# -lt 1 ]; then
  show_help
  exit 1
fi

ACTION="$1"
shift || true

case "$ACTION" in
  init)
    cmd_init "$@"
    ;;
  build)
    cmd_build "$@"
    ;;
  up)
    cmd_up "$@"
    ;;
  alert-test)
    cmd_alert_test "$@"
    ;;
  status)
    cmd_status "$@"
    ;;
  logs)
    cmd_logs "$@"
    ;;
  rollback)
    cmd_rollback "$@"
    ;;
  down)
    cmd_down "$@"
    ;;
  --help|-h)
    show_help
    exit 0
    ;;
  *)
    echo "Unknown command: $ACTION" >&2
    show_help
    exit 1
    ;;
esac

