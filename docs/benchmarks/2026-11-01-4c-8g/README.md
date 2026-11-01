# Benchmark Report: 4c-8g (2026-11-01)

- **Date**: 2026-11-01
- **VM Size**: `4c-8g` (4 vCPU, 7941 MB RAM)
- **Host Hardware**:
  - CPU: 12th Gen Intel(R) Core(TM) i5-12500H
  - Pinning: P-cores 0, 2, 4, 6
  - Frequency: ~4200 MHz | Governor: `performance` | Temp: 59–67°C
  - Power: AC Connected
- **VM Environment**:
  - Kernel: Linux 6.8.0-147-generic x86_64
  - Docker: Docker version 29.1.3, build 29.1.3-0ubuntu3~24.04.2
  - Isolate: The process isolator 2.7
- **Configuration (.env)**:
```env
PORT=3000
NODE_ENV=production
WORKER_CONCURRENCY=8
POSTGRES_POOL_SIZE=6
MYSQL_POOL_SIZE=6
MAX_QUEUE_DEPTH=200
RATE_LIMIT_SUBMISSIONS_MAX=240
AUTH_TOKEN=test-token
DOMAIN=localhost
ENABLE_MONITORING=true
REDIS_URL=redis://redis:6379
ALERT_WEBHOOK_URL=http://localhost:5001/
```

---

## Capacity Ramp Results (3 Repeats, $\ge 60\text{ s}$ Steps)

| Workload | Run 1 Max RPS | Run 2 Max RPS | Run 3 Max RPS | **Median Max RPS** | p50 Latency | p95 Latency | p99 Latency | Failure Mode at +1 Step |
|---|---|---|---|---|---|---|---|---|
| **Python (Isolate)** | 50 | 50 | 50 | **50 req/s** | 19 ms | 21 ms | 27 ms | None (reached max ramp test limit) |
| **PostgreSQL 16 (Warm Pool)** | 1 | 1 | 1 | **1 req/s** | 154 ms | 200 ms | 206 ms | p95 latency spike (> 9.6 s) |
| **MySQL 8.4 (Warm Pool)** | 1 | 1 | 1 | **1 req/s** | 144 ms | 158 ms | 180 ms | p95 latency spike (> 15 s) |
| **Mix (Python / PG / MySQL)** | 2 | 2 | 2 | **2 req/s** | 139 ms | 157 ms | 184 ms | p95 latency spike (> 9.7 s) |

---

## 2x Overload Degradation Verification

| Workload | Overload Target | Dispatched | Status 201 (OK) | Status 503 (Backpressure) | Status 429 (Rate Limit) | Other Errors | SSH Responsive | Containers Running |
|---|---|---|---|---|---|---|---|---|
| **Python (Isolate)** | 100 req/s | 6000 | 6000 | 0 | 0 | 0 | ✓ Yes | 24 |
| **PostgreSQL 16 (Warm Pool)** | 2 req/s | 120 | 120 | 0 | 0 | 0 | ✓ Yes | 24 |
| **MySQL 8.4 (Warm Pool)** | 2 req/s | 120 | 120 | 0 | 0 | 0 | ✓ Yes | 22 |
| **Mix (Python / PG / MySQL)** | 4 req/s | 240 | 240 | 0 | 0 | 0 | ✓ Yes | 20 |

---

## Operational Notes
- Sizing strictly adheres to `docs/limits.md` memory and CPU formulas.
- All runs were preceded by an idle cooldown ensuring `load1 < 1.0`.
- Python (Isolate) scales linearly with additional vCPUs, sustaining 50 req/s with sub-25ms p95 latency.
- Dedicated database workloads on a single Docker host remain bound by container lifecycle recycling latency (~1.5–2.0 s per container destroy/boot sequence), maintaining 1 req/s sustainable limit for continuous single-database traffic before container queueing occurs.
- Under 2x overload, zero container crashes occurred and the host remained fully responsive over SSH.
