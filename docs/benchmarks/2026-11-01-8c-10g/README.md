# Benchmark Report: 8c-10g (2026-11-01)

- **Date**: 2026-11-01
- **VM Size**: `8c-10g` (8 vCPU, 9943 MB RAM)
- **Host Hardware**:
  - CPU: 12th Gen Intel(R) Core(TM) i5-12500H
  - Pinning: P-cores 0, 1, 2, 3, 4, 5, 6, 7 (all 8 hyperthreads)
  - Frequency: ~4200 MHz | Governor: `performance` | Temp: 57–64°C
  - Power: AC Connected
- **VM Environment**:
  - Kernel: Linux 6.8.0-147-generic x86_64
  - Docker: Docker version 29.1.3, build 29.1.3-0ubuntu3~24.04.2
  - Isolate: The process isolator 2.7
- **Configuration (.env)**:
```env
PORT=3000
NODE_ENV=production
WORKER_CONCURRENCY=16
POSTGRES_POOL_SIZE=10
MYSQL_POOL_SIZE=10
MAX_QUEUE_DEPTH=400
RATE_LIMIT_SUBMISSIONS_MAX=500
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
| **Python (Isolate)** | 70 | 70 | 70 | **70 req/s** | 23 ms | 25 ms | 118 ms | None (reached max ramp test limit) |
| **PostgreSQL 16 (Warm Pool)** | 2 | 1 | 2 | **2 req/s** | 167 ms | 178 ms | 193 ms | p95 latency spike (> 16.6 s) |
| **MySQL 8.4 (Warm Pool)** | 2 | 2 | 2 | **2 req/s** | 164 ms | 183 ms | 188 ms | p95 latency spike (> 13.4 s) |
| **Mix (Python / PG / MySQL)** | 2 | 3 | 3 | **3 req/s** | 161 ms | 187 ms | 198 ms | p95 latency spike (> 20.8 s) |

---

## 2x Overload Degradation Verification

| Workload | Overload Target | Dispatched | Status 201 (OK) | Status 503 (Backpressure) | Status 429 (Rate Limit) | Other Errors | SSH Responsive | Containers Running |
|---|---|---|---|---|---|---|---|---|
| **Python (Isolate)** | 140 req/s | 8401 | 8295 | 106 | 0 | 0 | ✓ Yes | 32 |
| **PostgreSQL 16 (Warm Pool)** | 4 req/s | 241 | 241 | 0 | 0 | 0 | ✓ Yes | 30 |
| **MySQL 8.4 (Warm Pool)** | 4 req/s | 224 | 182 | 0 | 0 | 42 | ✓ Yes | 25 |
| **Mix (Python / PG / MySQL)** | 6 req/s | 360 | 360 | 0 | 0 | 0 | ✓ Yes | 13 |

---

## Operational Notes
- Sizing strictly adheres to `docs/limits.md` memory and CPU formulas.
- All runs were preceded by an idle cooldown ensuring `load1 < 1.0`.
- Python (Isolate) demonstrates exceptional scaling on 8 vCPUs, sustaining 70 req/s with ~23 ms median turnaround.
- Under 140 req/s (2x overload) on Python, BullMQ backpressure triggered cleanly, rejecting 106 excess requests with HTTP 503 while successfully completing 8,295 submissions without worker crash or process leak.
- Database pools of depth 10 achieved 2 req/s sustainably for both PostgreSQL and MySQL, and 3 req/s under mixed load.
- Across all overload tests, the host remained fully responsive over SSH and zero daemons or kernel OOM events occurred.
