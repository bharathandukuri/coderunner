# Production Deployment & Operations Guide

This guide covers deploying, maintaining, and troubleshooting CoderRunner in a production environment.

For hardware sizing, resource formulas, and capacity tiers, see [Capacity & Limits Reference](limits.md).

---

## 1. Automated Deployment with `scripts/deploy.sh`

Deployments are orchestrated using `scripts/deploy.sh`. The deployment lifecycle consists of four discrete phases:

```bash
# Full automated deployment
./scripts/deploy.sh
```

Or execute phases individually:

```bash
./scripts/deploy.sh init
./scripts/deploy.sh preflight
./scripts/deploy.sh build
./scripts/deploy.sh up
```

### Deployment Phases

1. **`init`**:
   - Creates required host mount directories (`certs/`, `data/`, `caddy_data/`, `caddy_config/`).
   - Generates `.env` from `.env.example` if no `.env` exists.
   - Enforces secure POSIX permissions (e.g., `chmod 600 .env`).
2. **`preflight`**:
   - Executes `scripts/preflight.sh` to validate system prerequisites before touching containers.
   - Checks Linux cgroups v2 availability, Docker Engine version, and Compose plugin.
   - Calculates dynamic memory and vCPU requirements based on configured pool sizes and worker concurrency, comparing against actual host capacity.
   - Verifies sandboxing tooling (Linux Isolate and gVisor `runsc`).
3. **`build`**:
   - Compiles application images (`coderunner-api`, `coderunner-worker`, `coderunner-worker-db`).
   - Builds isolated execution images for PostgreSQL 16 and MySQL 8.4 via `scripts/build-images.sh`.
4. **`up`**:
   - Launches services using Docker Compose. If `ENABLE_MONITORING=true`, includes the `monitoring` profile (Prometheus, Grafana, Alertmanager, exporters).
   - Polls healthcheck endpoints until all services report healthy.
   - Automatically executes `scripts/verify-docker-proxy.sh` to confirm the Docker socket proxy blocks privileged operations.

To inspect deployment status or tear down:

```bash
./scripts/deploy.sh status
./scripts/deploy.sh down
```

---

## 2. Production Secrets & Security Hardening

The following variables in `.env` contain sensitive secrets and must be configured with secure random values before launching in production:

| Variable            | Description                                          | Security Requirement                                                                      |
| ------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `AUTH_TOKEN`        | Space-separated list of authorized API bearer tokens | Generate high-entropy strings (e.g. `openssl rand -hex 32`). Reject default `test-token`. |
| `GRAFANA_PASSWORD`  | Admin password for the Grafana dashboard             | Use strong credential. Do not leave as default `admin`.                                   |
| `ALERT_WEBHOOK_URL` | Webhook URL for Alertmanager incident notifications  | Valid Discord webhook URL. Required unless `--no-alerts` is passed to `deploy.sh`.        |

All credentials must be stored solely in `.env` (which is excluded via `.gitignore`). Back up `.env` securely before upgrades.

### Setting Up Discord Alert Delivery

Alertmanager v0.27 sends incident notifications directly to Discord using native `discord_configs`:

1. In Discord, open your server and navigate to **Server Settings** → **Integrations** → **Webhooks**.
2. Click **New Webhook**.
3. Choose your designated operational channel (e.g. `#ops-alerts`), assign a name (e.g. `CodeRunner Alerts`), and click **Copy Webhook URL**.
4. On your server, place this URL in `.env`:
   ```bash
   ALERT_WEBHOOK_URL=https://discord.com/api/webhooks/123456789/abcdef...
   ```
5. Deploy or reload the production stack:
   ```bash
   ./scripts/deploy.sh up
   ```
   *(If deploying temporarily without alerts, pass `./scripts/deploy.sh up --no-alerts`)*.
6. Verify alert delivery:
   ```bash
   ./scripts/deploy.sh alert-test
   ```
   This executes `amtool alert add TestAlert severity=test` inside the Alertmanager container and outputs `check your Discord channel now`. You should immediately see the alert in your Discord channel.

---

## 3. Caddy Reverse Proxy & Automatic TLS

CoderRunner uses [Caddy](https://caddyserver.com/) as the edge reverse proxy. Caddy handles automatic HTTPS certificate provisioning via Let's Encrypt / ZeroSSL, terminates TLS, and enforces rate limiting.

### Domain Configuration

In `.env`:

```bash
DOMAIN=judge.example.com
```

### Ingress Rules

- Port `80`: Automatically redirects all HTTP traffic to HTTPS (port `443`).
- Port `443`: Public API endpoints (`/submissions`, `/batch`, `/multi`, `/health`, `/metrics`).
- Internal services (Redis, Docker socket proxy, Prometheus, Grafana, Alertmanager) are **never** exposed to the public internet. They bind exclusively to the private Docker bridge network.

---

## 4. Secure Access to Grafana and Prometheus

Prometheus and Grafana bind only to internal loopback / container networks. To access web interfaces, establish an SSH tunnel from your local machine:

```bash
# Tunnel Prometheus (9090) and Grafana (3001) over SSH
ssh -N -L 9090:127.0.0.1:9090 -L 3001:127.0.0.1:3001 user@your-server-ip
```

Then open in your local browser:

- **Grafana**: [http://localhost:3001](http://localhost:3001) (User: `admin`, Password: `${GRAFANA_PASSWORD}`)
- **Prometheus**: [http://localhost:9090](http://localhost:9090)

---

## 5. Alert Definitions & Operator Runbooks

Alerts are monitored continuously by Prometheus and dispatched via Alertmanager (`alertrules.yml`). When an alert triggers, execute the corresponding runbook action:

| Alert Name                          | Severity | Condition                                         | Operator Runbook Command / Mitigation                                                                                                                                                                                                      |
| ----------------------------------- | -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DatabasePoolDepthDepleted`         | Warning  | `coderunner_pool_depth == 0` for 1m               | Warm pool is starved. Check worker logs: `docker compose logs -f worker-db`. If boots are hanging, restart the database worker: `docker compose restart worker-db`.                                                                        |
| `DatabasePoolWaitersHigh`           | Warning  | `coderunner_pool_waiters > 5` for 1m              | Query queue is backlogged. Check if long-running queries are saturating concurrency. If host memory permits, increase `POSTGRES_POOL_SIZE` or `MYSQL_POOL_SIZE` in `.env` and run `./scripts/deploy.sh up`.                                |
| `DatabasePoolBootSlow`              | Warning  | p95 boot duration > 3s for 2m                     | High host I/O or CPU pressure during container creation. Inspect host load via `uptime` and `iostat -xz 1`. Check disk space.                                                                                                              |
| `DatabasePoolBootFailuresSpike`     | Critical | Boot failure rate > 0.1/s for 1m                  | Docker daemon cannot boot containers. Check Docker daemon logs (`journalctl -u docker -n 100`) and test manual container run: `docker run --rm alpine echo ok`.                                                                            |
| `DatabasePoolAcquireWaitHigh`       | Warning  | p95 acquire wait > 2s for 2m                      | Pool capacity is insufficient for current query arrival rate. Increase pool depth or enable API backpressure by tuning `MAX_QUEUE_DEPTH`.                                                                                                  |
| `DatabasePoolCircuitBreakerTripped` | Critical | Circuit breaker tripped (> 0) for 30s             | 3 consecutive container boot failures occurred. Worker has temporarily paused container replenishment. Inspect root cause in `docker compose logs worker-db`, verify Docker socket proxy, and restart: `docker compose restart worker-db`. |
| `LeakedPoolContainers`              | Warning  | Untracked containers > 0 or total containers > 25 | Orphaned containers detected. Run `./scripts/leak-check.sh` to view orphans. Clean them up with `docker container prune` or restart worker-db which executes `startupSweep()`.                                                             |
| `TargetDown`                        | Critical | Scrape target unreachable for 2m                  | A core service or exporter crashed. Check service status: `docker compose ps`. Restart failing container: `docker compose restart <service>`.                                                                                              |
| `QueueBacklogGrowing`               | Warning  | Submissions in BullMQ queue > 10 for 2m           | Worker throughput is lower than ingestion rate. Verify workers are consuming jobs: `docker compose logs worker worker-db`. Scale `WORKER_CONCURRENCY` if CPU headroom exists.                                                              |
| `InternalErrorRateHigh`             | Critical | Status 13 rate > 5% over 5m                       | Workers are encountering fatal system errors (permissions, runner crashes). Check logs: `docker compose logs --tail=100 worker`. Verify `/tmp` permissions and disk space.                                                                 |
| `HighTLERatio`                      | Warning  | Status 5 (TLE) > 20% over 2m                      | High volume of runaway user code or slow queries. Inspect if submissions are spamming infinite loops. Adjust `DEFAULT_WALL_TIME_LIMIT` or client rate limits.                                                                              |
| `HostMemoryHigh`                    | Warning  | Host MemAvailable < 15% for 2m                    | Host is nearing out-of-memory. Stop non-essential profiles (`ENABLE_MONITORING=false ./scripts/deploy.sh up`), reduce `WORKER_CONCURRENCY`, or upgrade host RAM.                                                                           |
| `RootDiskHigh`                      | Warning  | Host root disk usage > 80% for 2m                 | Disk partition filling up. Prune dangling Docker images and builder cache: `docker image prune -f && docker builder prune -f`. Rotate old logs in `/var/log`.                                                                              |
| `RedisDown`                         | Critical | Redis unreachable for 1m                          | Redis container crashed or port unresponsive. Check `docker compose logs redis`. Start or restart Redis: `docker compose up -d redis`.                                                                                                     |

---

## 6. Security Boundaries & Isolation Architecture

CoderRunner implements a defense-in-depth security model across five layers:

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 1: Ingress (Caddy Reverse Proxy)                      │
│ - TLS termination, IP rate limiting, trust proxy headers   │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Layer 2: API & Queue (Node.js Express + BullMQ / Redis)     │
│ - Token authentication, payload size caps, backpressure 503 │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│ Layer 3: Controlled Container Proxy (docker-socket-proxy)   │
│ - Strict whitelist: GET/POST containers, EXEC, DELETE       │
│ - BLOCKED: Swarm, volumes, host mounts, network changes     │
└──────────────────────────────┬──────────────────────────────┘
                               │
               ┌───────────────┴───────────────┐
               ▼                               ▼
┌─────────────────────────────┐ ┌─────────────────────────────┐
│ Layer 4: Isolate Sandbox    │ │ Layer 5: Database Containers│
│ - Linux cgroups v2          │ │ - gVisor (runsc) or runc    │
│ - Dedicated chroot box      │ │ - Read-only root filesystem │
│ - Network namespace: NONE   │ │ - tmpfs on /run, /tmp       │
│ - Memory, wall, CPU limits  │ │ - Internal bridge network   │
│ - Blocked syscalls / pids   │ │ - Non-root execution        │
└─────────────────────────────┘ └─────────────────────────────┘
```

1. **Linux Isolate**:
   - Isolates code inside user, mount, IPC, PID, and network namespaces.
   - Network namespace is completely unshared (`--share-net=false`), preventing outbound sockets or network access.
   - Resource limits (CPU time, wall clock, RAM, address space, open files, process count) enforced via cgroups v2.
2. **Docker Sandboxes**:
   - Containers run with a read-only root filesystem where possible. Temporary files exist strictly in ephemeral `tmpfs` mounts that are discarded after execution.
   - Process limits (`pids_limit: 100`) prevent fork bombs.
   - When gVisor is enabled (`DOCKER_RUNTIME=runsc`), the container kernel interface is intercepted by an application kernel written in Go, eliminating host kernel exploit surfaces.
3. **Docker Socket Proxy (`tecnativa/docker-socket-proxy`)**:
   - The worker does not access `/var/run/docker.sock` directly. It connects via an isolated HTTP proxy that strictly permits container lifecycle operations (`CONTAINERS=1`, `POST=1`, `DELETE=1`, `EXEC=1`).
   - Privileged Docker API operations—such as mounting host filesystems, modifying Docker swarm configurations, manipulating networks, or creating persistent host volumes—are rejected with HTTP 403 Forbidden.
4. **Network Isolation**:
   - Each submission container connects solely to an internal bridge network with zero inter-container communication allowed (`com.docker.network.bridge.enable_icc=false`).

---

## 7. Operational Procedures

### Health Verification

Run the 13-stage end-to-end smoke test suite:

```bash
./scripts/smoke-test.sh
```

### Resource Leak Detection

Verify that no dangling Docker volumes, orphaned containers, or stale network mounts remain:

```bash
./scripts/leak-check.sh
```

To run leak checks while the warm pool is active:

```bash
./scripts/leak-check.sh --allow-warm-pool
```

### Backups

Create a backup archive of `.env` configuration and persistent monitoring volumes:

```bash
./scripts/backup.sh backup
```

List existing backups:

```bash
./scripts/backup.sh list
```

### Restoring from Backup

Restore `.env` and monitoring volumes from an archive:

```bash
./scripts/backup.sh restore ./backups/coderunner-backup-YYYY-MM-DDTHH-MM-SS.tar.gz
```

### Rollback Procedure

If a deployment fails:

1. Revert code to the previous Git commit:
   ```bash
   git checkout <previous-commit-hash>
   ```
2. Re-deploy the stack:
   ```bash
   ./scripts/deploy.sh build
   ./scripts/deploy.sh up
   ```
3. Run smoke tests:
   ```bash
   ./scripts/smoke-test.sh
   ```

---

## Security Considerations: MongoDB Support

MongoDB (language ID 10) is **opt-in and disabled by default** (`ENABLE_MONGODB=false`). When enabled:
- **Sandbox Boundaries**: MongoDB queries execute inside an ephemeral, hardened container (`mongo:8.0`) under unprivileged user `mongodb` (uid 999).
- **Hardening Flags**: `NetworkMode: none` (completely air-gapped), `CapDrop: ALL` (all Linux capabilities dropped), `ReadonlyRootfs: true`, `no-new-privileges: true`, and strict memory (`512MB`) and pids (`64`) ceilings.
- **Node.js Environment**: Because `mongosh` is implemented in Node.js, user scripts have access to Node globals (`process.env`, `require('fs')`). User code can read files within the container's isolated rootfs (such as `/etc/passwd`), identical to untrusted Python or Node.js submissions. Subprocesses via `child_process.execSync` are blocked by the pids ceiling (`EAGAIN`) and lack system capabilities. Administrative commands (`shutdownServer`, `shutdown`) are blocked by CodeRunner's static analyzer before execution.
- If running untrusted multi-tenant workloads, keep `ENABLE_MONGODB=false` unless MongoDB query execution is explicitly required.
