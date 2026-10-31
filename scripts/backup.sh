#!/usr/bin/env bash
# scripts/backup.sh - Backup and restore for CodeRunner Grafana, Prometheus, and .env
# Supports automated retention, volume snapshots, and state recovery.

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKUP_DIR="$PROJECT_DIR/backups"
RETENTION_COUNT=7

show_help() {
  cat << 'EOF'
Usage: scripts/backup.sh <command> [options]

Commands:
  backup                  Create a timestamped backup of .env, Grafana, and Prometheus volumes
  restore <archive_file>  Restore .env and volumes from a backup archive
  list                    List available backups
  --help, -h              Show this help message

Options:
  --retention <N>         Number of backups to retain (default: 7)
  --dest <dir>            Backup destination directory (default: ./backups)
EOF
}

find_volume_name() {
  local pattern="$1"
  docker volume ls -q | grep -E "${pattern}" | head -n 1 || true
}

cmd_backup() {
  mkdir -p "$BACKUP_DIR"
  local timestamp
  timestamp=$(date +%Y%m%d_%H%M%S)
  local archive_name="coderunner-backup-${timestamp}.tar.gz"
  local temp_dir
  temp_dir=$(mktemp -d)
  trap 'rm -rf "$temp_dir"' EXIT

  echo "=== Creating CodeRunner Backup ($timestamp) ==="

  # 1. Back up .env
  if [ -f "$PROJECT_DIR/.env" ]; then
    echo "• Backing up .env..."
    cp -p "$PROJECT_DIR/.env" "$temp_dir/.env"
  else
    echo -e "${YELLOW}⚠ Warning: No .env found to back up.${NC}"
  fi

  # 2. Back up Grafana Volume
  local grafana_vol
  grafana_vol=$(find_volume_name "grafana_data")
  if [ -n "$grafana_vol" ]; then
    echo "• Backing up Grafana volume ($grafana_vol)..."
    docker run --rm -v "${grafana_vol}:/volume:ro" -v "${temp_dir}:/backup" alpine \
      tar -czf /backup/grafana_data.tar.gz -C /volume .
  else
    echo -e "${YELLOW}⚠ Notice: Grafana volume not found, skipping volume backup.${NC}"
  fi

  # 3. Back up Prometheus Volume
  local prom_vol
  prom_vol=$(find_volume_name "prometheus_data")
  if [ -n "$prom_vol" ]; then
    echo "• Backing up Prometheus volume ($prom_vol)..."
    docker run --rm -v "${prom_vol}:/volume:ro" -v "${temp_dir}:/backup" alpine \
      tar -czf /backup/prometheus_data.tar.gz -C /volume .
  else
    echo -e "${YELLOW}⚠ Notice: Prometheus volume not found, skipping volume backup.${NC}"
  fi

  # 4. Create final compressed tarball
  echo "• Creating bundle $archive_name..."
  tar -czf "$BACKUP_DIR/$archive_name" -C "$temp_dir" .

  local archive_size
  archive_size=$(du -h "$BACKUP_DIR/$archive_name" | cut -f 1)
  echo -e "${GREEN}✓ Backup created: $BACKUP_DIR/$archive_name ($archive_size)${NC}"

  # 5. Enforce retention (delete older than RETENTION_COUNT)
  local total_backups
  total_backups=$(find "$BACKUP_DIR" -name 'coderunner-backup-*.tar.gz' | wc -l)
  if [ "$total_backups" -gt "$RETENTION_COUNT" ]; then
    echo "• Enforcing retention (keeping last $RETENTION_COUNT backups)..."
    find "$BACKUP_DIR" -name 'coderunner-backup-*.tar.gz' | sort | head -n -"$RETENTION_COUNT" | xargs -r rm -f
  fi
}

cmd_restore() {
  local archive_path="$1"
  if [ ! -f "$archive_path" ]; then
    echo -e "${RED}✗ Error: Archive file not found: $archive_path${NC}" >&2
    exit 1
  fi

  echo "=== Restoring CodeRunner from $archive_path ==="
  local temp_dir
  temp_dir=$(mktemp -d)
  trap 'rm -rf "$temp_dir"' EXIT

  tar -xzf "$archive_path" -C "$temp_dir"

  # 1. Restore .env
  if [ -f "$temp_dir/.env" ]; then
    if [ -f "$PROJECT_DIR/.env" ]; then
      cp -p "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.pre-restore.$(date +%Y%m%d%H%M%S)"
      echo "• Backed up current .env before restore"
    fi
    cp -p "$temp_dir/.env" "$PROJECT_DIR/.env"
    echo -e "${GREEN}✓ Restored .env${NC}"
  fi

  # 2. Restore Grafana Volume
  if [ -f "$temp_dir/grafana_data.tar.gz" ]; then
    local grafana_vol
    grafana_vol=$(find_volume_name "grafana_data")
    if [ -n "$grafana_vol" ]; then
      echo "• Restoring Grafana volume ($grafana_vol)..."
      docker run --rm -v "${grafana_vol}:/volume" -v "${temp_dir}:/backup" alpine \
        sh -c "rm -rf /volume/* /volume/..?* /volume/.[!.]* 2>/dev/null || true; tar -xzf /backup/grafana_data.tar.gz -C /volume"
      echo -e "${GREEN}✓ Restored Grafana data volume${NC}"
    fi
  fi

  # 3. Restore Prometheus Volume
  if [ -f "$temp_dir/prometheus_data.tar.gz" ]; then
    local prom_vol
    prom_vol=$(find_volume_name "prometheus_data")
    if [ -n "$prom_vol" ]; then
      echo "• Restoring Prometheus volume ($prom_vol)..."
      docker run --rm -v "${prom_vol}:/volume" -v "${temp_dir}:/backup" alpine \
        sh -c "rm -rf /volume/* /volume/..?* /volume/.[!.]* 2>/dev/null || true; tar -xzf /backup/prometheus_data.tar.gz -C /volume"
      echo -e "${GREEN}✓ Restored Prometheus data volume${NC}"
    fi
  fi

  echo -e "${GREEN}✓ Restore completed successfully.${NC}"
}

cmd_list() {
  mkdir -p "$BACKUP_DIR"
  echo "Available backups in $BACKUP_DIR:"
  local count=0
  for f in "$BACKUP_DIR"/coderunner-backup-*.tar.gz; do
    if [ -f "$f" ]; then
      echo "  $(basename "$f") ($(du -h "$f" | cut -f 1))"
      count=$((count + 1))
    fi
  done
  if [ "$count" -eq 0 ]; then
    echo "  (No backups found)"
  fi
}

# Parse options
ACTION=""
RESTORE_FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    backup|list)
      ACTION="$1"
      shift
      ;;
    restore)
      ACTION="$1"
      RESTORE_FILE="${2:-}"
      if [ -z "$RESTORE_FILE" ]; then
        echo -e "${RED}✗ Error: restore requires archive file path${NC}" >&2
        show_help
        exit 1
      fi
      shift 2
      ;;
    --retention)
      RETENTION_COUNT="$2"
      shift 2
      ;;
    --dest)
      BACKUP_DIR="$2"
      shift 2
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      show_help
      exit 1
      ;;
  esac
done

if [ -z "$ACTION" ]; then
  show_help
  exit 1
fi

case "$ACTION" in
  backup)
    cmd_backup
    ;;
  restore)
    cmd_restore "$RESTORE_FILE"
    ;;
  list)
    cmd_list
    ;;
esac

