# CodeRunner Operations Runbook

This document is the standard operational guide for deploying, maintaining, updating, rolling back, and troubleshooting a production CodeRunner cluster.

---

## 1. First-Time Deployment

On a fresh Linux host (Ubuntu 22.04+ or 24.04+ with cgroups v2):

### Step 1: Preflight Verification

Verify that the host has Docker, Compose v2, and meets RAM/disk sizing requirements:

```bash
./scripts/preflight.sh --install-isolate
```

### Step 2: Initialize Environment

Generate `.env` with secure randomized tokens (`AUTH_TOKEN`, `METRICS_TOKEN`, `GRAFANA_PASSWORD`):

```bash
./scripts/deploy.sh init
```

Review `.env` and set optional variables if using a custom domain or custom concurrency:

- `DOMAIN=coderunner.example.com` (for automatic HTTPS via Let's Encrypt)
- `WORKER_CONCURRENCY=4` (default: 2)
- `WORKER_DB_CONCURRENCY=2` (default: 2)

### Step 3: Build Container Images

Build the database daemon runners (`coderunner/postgres:16`, `coderunner/mysql:8.4`), sandbox images, and CodeRunner services:

```bash
./scripts/deploy.sh build
```

### Step 4: Start Services

Start the full stack with configuration validation and healthcheck verification:

```bash
./scripts/deploy.sh up
```

### Step 5: Verify Deployment

Run the automated end-to-end smoke test suite:

```bash
./scripts/smoke-test.sh
```

---

## 2. Deploying Updates

Code updates are committed locally and pulled on the production server:

```bash
# 1. On production server, pull latest changes
git pull origin main

# 2. Build updated application images (automatically records rollback tag)
./scripts/deploy.sh build

# 3. Start updated services with zero-downtime container transition
./scripts/deploy.sh up

# 4. Verify with smoke tests
./scripts/smoke-test.sh
```

---

## 3. Rollback Procedure

If a deployed update fails smoke tests or encounters elevated error rates:

```bash
# Revert to the previously built image tag and restart containers
./scripts/deploy.sh rollback

# Verify health
./scripts/smoke-test.sh
```

---

## 4. Backups and Disaster Recovery

### Create a Backup

Snapshots `.env`, Grafana dashboard/user volume, and Prometheus TSDB data with 7-day retention:

```bash
./scripts/backup.sh backup
```

Backups are saved to `./backups/coderunner-backup-YYYYMMDD_HHMMSS.tar.gz`.

### List Backups

```bash
./scripts/backup.sh list
```

### Restore from Backup

```bash
./scripts/backup.sh restore ./backups/coderunner-backup-YYYYMMDD_HHMMSS.tar.gz
```

---

## 5. Troubleshooting & Diagnostics

### View Status & Running Containers

```bash
./scripts/deploy.sh status
```

### Follow Container Logs

```bash
# All services
./scripts/deploy.sh logs

# Specific service
./scripts/deploy.sh logs api
./scripts/deploy.sh logs worker-db
./scripts/deploy.sh logs caddy
```

### Resource Leak Verification

Verify zero orphaned pool containers or dangling anonymous volumes:

```bash
# When stack is active (allows healthy warm pool containers)
./scripts/leak-check.sh --allow-warm-pool

# When stack is stopped (asserts 0 pool containers remain)
./scripts/leak-check.sh
```

### Verify Docker Socket Proxy Security

Verify that the unprivileged internal socket proxy allows legitimate container operations while denying Docker network/swarm escape calls:

```bash
./scripts/verify-docker-proxy.sh
```

### Accessing Internal Monitoring

Prometheus is deliberately not exposed to the public internet. Access it via SSH tunnel:

```bash
# From local workstation:
ssh -N -L 9090:localhost:9090 -L 3001:localhost:3001 -i coderunner-key.pem ubuntu@<SERVER_IP>
```

Then visit:

- Grafana: `http://localhost:3001` (login: `admin` / password from `.env`)
- Prometheus: `http://localhost:9090`
- Alertmanager: `http://localhost:9093`
