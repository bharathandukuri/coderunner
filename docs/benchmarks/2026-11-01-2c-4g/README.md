# Benchmark Report: 2c-4g (2026-11-01)

- **Date**: 2026-11-01
- **VM Size**: `2c-4g` (2 vCPU, 3915 MB RAM)
- **Host Hardware**:
  - CPU: 12th Gen Intel(R) Core(TM) i5-12500H
  - Pinning: P-cores 0, 2
  - Frequency: ~4200 MHz | Governor: `performance` | Temp: 58–65°C
  - Power: AC Connected
- **VM Environment**:
  - Kernel: Linux 6.8.0-147-generic x86_64
  - Docker: Docker version 29.1.3, build 29.1.3-0ubuntu3~24.04.2
  - Isolate: The process isolator 2.7
- **Configuration (.env)**:
```env
PORT=3000
NODE_ENV=production
WORKER_CONCURRENCY=4
POSTGRES_POOL_SIZE=4
MYSQL_POOL_SIZE=4
MAX_QUEUE_DEPTH=100
RATE_LIMIT_SUBMISSIONS_MAX=120
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
| **Python (Isolate)** | 30 | 30 | 30 | **30 req/s** | 21 ms | 24 ms | 31 ms | None (reached max ramp test limit) |
| **PostgreSQL 16 (Warm Pool)** | 1 | 1 | 2 | **1 req/s** | 172 ms | 256 ms | 1778 ms | p95 latency spike (> 2500 ms) & load1 > 4.0 |
| **MySQL 8.4 (Warm Pool)** | 1 | 1 | 1 | **1 req/s** | 182 ms | 200 ms | 223 ms | p95 latency spike (> 20 s) & load1 > 4.0 |
| **Mix (Python / PG / MySQL)** | 2 | 1 | 2 | **2 req/s** | 172 ms | 202 ms | 213 ms | p95 latency spike (> 15 s) & load1 > 4.0 |

---

## 2x Overload Degradation Verification

| Workload | Overload Target | Dispatched | Status 201 (OK) | Status 503 (Backpressure) | Status 429 (Rate Limit) | Other Errors | SSH Responsive | Containers Running |
|---|---|---|---|---|---|---|---|---|
| **Python (Isolate)** | 60 req/s | 3600 | 3600 | 0 | 0 | 0 | ✓ Yes | 20 |
| **PostgreSQL 16 (Warm Pool)** | 2 req/s | 120 | 120 | 0 | 0 | 0 | ✓ Yes | 20 |
| **MySQL 8.4 (Warm Pool)** | 2 req/s | 120 | 120 | 0 | 0 | 0 | ✓ Yes | 20 |
| **Mix (Python / PG / MySQL)** | 4 req/s | 241 | 241 | 0 | 0 | 0 | ✓ Yes | 13 |

---

## Operational Notes
- Sizing strictly adheres to `docs/limits.md` memory and CPU formulas.
- All runs were preceded by an idle cooldown ensuring `load1 < 1.0`.
- Python (Isolate) demonstrates exceptional efficiency on 2 vCPUs with 30 req/s sustained at ~21 ms median latency.
- Database container recycling on 2 vCPUs becomes resource-constrained above 1 req/s per engine due to CPU overhead of container initialization, leading to queueing and p95 latency growth beyond the 2.5s pass criteria.
- Under 2x overload, zero container crashes occurred and the host remained fully responsive over SSH.
