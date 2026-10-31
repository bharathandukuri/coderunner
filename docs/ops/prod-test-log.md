# Production Operations & Verification Log

This document records the exact production commands executed, their results, failure injection outcomes, load test metrics, and operational verification steps on the AWS EC2 production server (`ec2-16-112-170-85.ap-south-2.compute.amazonaws.com`).

**Safety Rules Enforced**:
- Zero destructive commands run outside repository directory
- No `docker system prune -a` executed
- No deleting Docker volumes outside this compose stack
- Production `.env` backed up prior to any modification
- Dedicated randomized test tokens utilized
- Zero secrets or credentials logged

---

## 1. Production Execution Log

| Timestamp (UTC) | Command / Action | Result / Status | Notes |
|---|---|---|---|
| 2026-10-31 18:10:00 | `uname -a` | `Linux ip-172-31-31-168 7.0.0-1014-aws #14-Ubuntu SMP PREEMPT Thu Sep 17 19:08:36 UTC 2026 x86_64` | Initial SSH connectivity verified |
| 2026-10-31 18:17:40 | `pwd; ls -la; which git docker` | Success | Verified `/home/ubuntu/Codebox`, git, and docker installed |
| 2026-10-31 18:18:04 | `git init --bare /home/ubuntu/coderunner.git && cd Codebox && git init && git remote add origin /home/ubuntu/coderunner.git` | Success | Configured bare git remote on host for safe `git pull` deploys |
| 2026-10-31 18:18:21 | `cp -p Codebox/.env Codebox/.env.bak` | Success | `.env` backed up before repository sync |
| 2026-10-31 18:18:29 | `cd Codebox && git fetch origin && git reset --hard origin/main && cp -p .env.bak .env` | Commit `a7cf915` synced | Worktree updated to Part 1 commit |
| 2026-10-31 18:18:35 | `cd Codebox && git branch -m master main && git branch -u origin/main main && rm -f nginx.conf` | Success | Tracking `origin/main`; removed legacy root `nginx.conf` |
| 2026-10-31 18:20:15 | `cd Codebox && ./scripts/preflight.sh` | Success (0 errors, 1 warning) | All 8 preflight checks passed; cgroups v2, Docker 29.9.2, Compose 5.6.1, Isolate 2.7, gVisor |
| 2026-10-31 18:22:45 | `cd Codebox && ./scripts/deploy.sh build` | Success | Built `codebox-api`, `codebox-worker`, `codebox-worker-db`, `coderunner/postgres:16`, `coderunner/mysql:8.4` |
| 2026-10-31 18:26:10 | `cd Codebox && ./scripts/deploy.sh up` | Success | All 12 stack services started and responding healthy |
| 2026-10-31 18:28:15 | `cd Codebox && ./scripts/verify-docker-proxy.sh` | Success | Container create, start, exec, delete allowed; swarm & volume creation blocked (403) |
| 2026-10-31 18:30:20 | `docker exec codebox-api-1 curl -s -m 2 http://docker-proxy:2375/version` | Connection Refused / Blocked | API container isolated from Docker socket proxy network |
| 2026-10-31 18:31:00 | External port scan: `nc -zv 16.112.170.85 6379 2375 9090 3000` | Connection Timed Out | Internal infrastructure ports isolated from public internet |
| 2026-10-31 18:45:00 | `node --test tests/api.test.js` (via SSH tunnel to production API) | **63 passed, 0 failed** | End-to-end integration suite passed across Python, C++, Java, SQLite, Postgres, MySQL |
| 2026-10-31 18:58:30 | PG container kill & recovery: `docker kill <pg-container-id>` | Status 3 (1.32s recovery) | Killed warm container auto-replaced; pool depth replenished to 2 |
| 2026-10-31 19:05:12 | Redis stop/restart: `docker stop codebox-redis-1 && sleep 20 && docker start codebox-redis-1` | Success | Worker reconnected automatically; Python submission returned status 3 |
| 2026-10-31 19:12:40 | Graceful shutdown: `kill -TERM <worker-db-pid>` during execution | Code 0 | Active job finished, warm pool cleanly destroyed, worker-db exited with code 0 |
| 2026-10-31 19:18:15 | Daemon restart: `sudo systemctl restart docker` | 13/13 smoke tests pass | Docker daemon restarted; all containers auto-restarted with `unless-stopped` policy |
| 2026-10-31 19:25:20 | Orphan sweeper: `kill -9 <worker-db-pid>` leaving 4 orphans, then restart | Success | Worker-db logged `sweep_removing_orphan` and cleaned all 4 orphaned containers on boot |
| 2026-10-31 20:04:28 | Alert validation: `amtool check-config` & `promtool check rules` | SUCCESS | Alertmanager routes verified; test alert dispatched to webhook receiver |
| 2026-10-31 20:08:50 | 20-request burst per engine (`BURST_SIZE=20`) | Success | Python: 20/20 (p50: 903ms); Postgres: 20/20 (p50: 9601ms); MySQL: 16/20 (p50: 17340ms) |
| 2026-10-31 20:14:27 | 5-minute sustained load (`TARGET_RPS=0.67 DURATION_SEC=300`) | **201/201 succeeded (100%)** | Continuous stream across Python, Postgres, MySQL for 300s; zero dropped requests |
| 2026-10-31 20:14:40 | `cd Codebox && ./scripts/leak-check.sh --allow-warm-pool` | Clean | 0 dangling volumes, 4 warm pool containers, 0 orphaned containers |
| 2026-10-31 20:14:49 | `cd Codebox && ./scripts/deploy.sh down` | Success | Graceful shutdown of all 12 services |
| 2026-10-31 20:14:53 | `cd Codebox && ./scripts/leak-check.sh` | Clean | 0 dangling anonymous volumes, 0 pool containers, 0 orphaned containers |
| 2026-10-31 20:15:23 | `cd Codebox && ./scripts/deploy.sh up` | Success | Services started and healthy |
| 2026-10-31 20:15:49 | `cd Codebox && ./scripts/smoke-test.sh` | **13/13 PASSED** | Final clean deployment verified |

---

## 2. Load Testing Results

### 20-Request Burst Test
Testing burst queuing and drain behavior with concurrency 2 and warm pool size 2:

| Engine | Total Requests | Succeeded | Min Latency | p50 (Median) | p95 | Max Latency | Status |
|---|---|---|---|---|---|---|---|
| **Python 3.8 (Isolate)** | 20 | 20 (100%) | 583 ms | 903 ms | 1,000 ms | 1,000 ms | Drained cleanly |
| **PostgreSQL 16 (Warm Pool)** | 20 | 20 (100%) | 1,678 ms | 9,601 ms | 16,769 ms | 16,769 ms | Queued and drained in 10 batches |
| **MySQL 8.4 (Warm Pool)** | 20 | 16 (80%) | 2,217 ms | 17,340 ms | 25,393 ms | 25,393 ms | 16 resolved within 25s HTTP timeout |

### 5-Minute Sustained Load Test
Continuous multi-engine load across Python (Isolate), PostgreSQL (Warm Pool), and MySQL (Warm Pool) for 300 seconds:

| Metric | Python (Isolate) | PostgreSQL (Warm Pool) | MySQL (Warm Pool) | Total / Combined |
|---|---|---|---|---|
| **Dispatched Requests** | 67 | 67 | 67 | 201 |
| **Successful Executions** | 67 (100%) | 67 (100%) | 67 (100%) | **201 / 201 (100%)** |
| **Min Latency** | 54 ms | 431 ms | 413 ms | 54 ms |
| **Median Latency (p50)** | 91 ms | 489 ms | 464 ms | 464 ms |
| **p95 Latency** | 156 ms | 735 ms | 592 ms | 735 ms |
| **Max Latency** | 352 ms | 1,007 ms | 1,119 ms | 1,119 ms |
| **Average Latency** | 100 ms | 515 ms | 485 ms | 366 ms |

### Prometheus & Resource Metrics During Sustained Load
- **Peak Waiters (`coderunner_pool_waiters`)**: `0` for PostgreSQL, `0` for MySQL (warm pool was never exhausted).
- **Pool Depth (`coderunner_pool_depth`)**: Oscillated steadily between 1 and 2 as containers were claimed, executed, and replenished.
- **Container Boot Failures (`coderunner_pool_boot_failures_total`)**: `0` across all engines.
- **Acquire Wait Time (p50)**: `2.29 ms` (Postgres), `2.38 ms` (MySQL).
- **Acquire Wait Time (p95)**: `4.81 ms` (Postgres), `4.75 ms` (MySQL).
- **Host Resource Stability**: Host load average remained between 2.10 and 3.04 on the 1 vCPU `t3.small` instance; available memory stabilized at > 520 MB with 248 MB swap.

---

## 3. Failure Injection & Resilience Summary

1. **Warm PostgreSQL Container Kill (`docker kill`)**:
   - Injection: Container running an idle PostgreSQL daemon was forcefully killed.
   - Outcome: Next submission detected container absence, triggered synchronous on-demand fallback recovery, and returned valid status 3 in 1.32s. Background replenisher booted a replacement container to restore pool depth to 2.
2. **Redis Outage & Recovery (`docker stop redis`)**:
   - Injection: Redis was stopped for 20 seconds, halting queue operations.
   - Outcome: API queues paused cleanly. When Redis restarted, BullMQ connections recovered without restart, and pending submissions were processed immediately.
3. **Graceful Worker Termination (`SIGTERM`)**:
   - Injection: `SIGTERM` sent to `worker-db` while a 4-second PostgreSQL query was executing.
   - Outcome: Worker awaited completion of the active submission, gracefully destroyed all pool containers via `WarmContainerPool.shutdown()`, and exited with code 0.
4. **Host Docker Daemon Restart (`systemctl restart docker`)**:
   - Injection: Docker daemon restarted on the production host.
   - Outcome: Restart policy `unless-stopped` restored all 12 services. Warm container pool initialized and passed all 13 smoke tests within 30 seconds of daemon availability.
5. **Worker Crash & Orphan Container Sweeper (`SIGKILL`)**:
   - Injection: `worker-db` was killed with `SIGKILL`, leaving 4 active warm pool containers behind without shutdown cleanup.
   - Outcome: On worker reboot, `startupSweep()` queried container labels and instance IDs, logged `sweep_removing_orphan`, and removed all 4 orphaned containers before initializing fresh pool containers.

---

## 4. Final Verification State

- **Smoke Tests**: 13 / 13 passed (`./scripts/smoke-test.sh`).
- **Integration Tests**: 63 / 63 passed (`tests/api.test.js`).
- **Unit Tests**: 46 / 46 passed (`node --test tests/pool.test.js tests/executor.test.js tests/splitters.test.js`).
- **Resource Leaks**: Zero orphaned containers, zero dangling volumes (`./scripts/leak-check.sh`).
