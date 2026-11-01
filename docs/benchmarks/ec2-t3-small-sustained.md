# Load Benchmark & Degradation Report: AWS EC2 t3.small

- **Date**: 2026-10-31T20:14:27Z
- **Git Commit**: `a7cf91549d47c4709d0cb4f62e8486f481c97a80`
- **Hardware**: AWS EC2 `t3.small`
  - vCPU: 1 (Intel Xeon Platinum 8259CL @ 2.50GHz)
  - RAM: 1.9 GiB physical RAM + 1.5 GiB swap
  - OS: Ubuntu 24.04 LTS (Linux 7.0.0-1014-aws x86_64)
  - Storage: 20 GB gp3 EBS (Docker storage-driver: overlayfs)
- **Configuration**:
  - `WORKER_CONCURRENCY=2`
  - `POSTGRES_POOL_SIZE=2`
  - `MYSQL_POOL_SIZE=2`
  - `ENABLE_MONITORING=true` (Full stack with Prometheus, Grafana, Alertmanager, cAdvisor, node-exporter, redis-exporter)

---

## Operational Note: Instability & Degradation Under Higher Load

The test on the 1 vCPU / 2 GB `t3.small` host was **not a clean pass**:
1. **Initial Overload & Host Lockup**:
   - Initial load tests at higher arrival rates (1.0 to 2.0 req/s) exhausted available host RAM and CPU capacity.
   - The instance stopped responding over SSH and HTTP for over 15 minutes. Prometheus scraping and queries stalled.
   - Recovery required a hard server reboot from the cloud console.
   - The request arrival rate was subsequently stepped down until reaching 0.67 req/s (1 request every 1.5 seconds across 3 engines). The 0.67 req/s figure is the **highest rate the host survived**, not a reliable headroom sizing target.
2. **Burst Test Degradation**:
   - In a 20-request burst test per engine with concurrency 2 and warm pool size 2:
     - **Python (Isolate)**: 20/20 passed (p50: 903 ms, max: 1,000 ms).
     - **PostgreSQL (Warm Pool)**: 20/20 passed, but with severely degraded latency: p50 reached 9,601 ms, and max latency stretched to 16,769 ms as requests queued waiting for container recycling.
     - **MySQL (Warm Pool)**: Only 16 of 20 resolved within the 25 s HTTP timeout (**80% success, degraded**). 4 requests timed out as pool replenish and execution latency reached 25,393 ms.

---

## Highest Sustained Rate Survived (0.67 req/s)

Continuous cyclic load across three engines for 300 seconds (total 201 requests):
```bash
node scripts/dev/load-test.mjs --target-rps 0.67 --duration-sec 300 --api-url http://127.0.0.1:3000 --prom-url http://127.0.0.1:9090
```

1. **Python 3.8 (Isolate)**: Fibonacci sequence computation and sort (`print([x**2 for x in range(100)])`).
2. **PostgreSQL 16 (Warm Pool)**: Schema creation, 1000 row batch insert, 3 queries (aggregation, filtering, window function).
3. **MySQL 8.4 (Warm Pool)**: Schema creation, 1000 row batch insert, 3 queries (aggregation, filtering, window function).

### Sustained Run Results

| Metric | Python 3.8 (Isolate) | PostgreSQL 16 (Warm Pool) | MySQL 8.4 (Warm Pool) | Combined |
|---|---|---|---|---|
| **Dispatched Requests** | 67 | 67 | 67 | 201 |
| **Successful Executions** | 67 (100%) | 67 (100%) | 67 (100%) | **201 / 201 (100%)** |
| **Failures / Errors** | 0 (0%) | 0 (0%) | 0 (0%) | **0 (0%)** |
| **Min Latency** | 54 ms | 431 ms | 413 ms | 54 ms |
| **Median (p50) Latency** | 91 ms | 489 ms | 464 ms | 464 ms |
| **p95 Latency** | 156 ms | 735 ms | 592 ms | 735 ms |
| **Max Latency** | 352 ms | 1,007 ms | 1,119 ms | 1,119 ms |
| **Average Latency** | 100 ms | 515 ms | 485 ms | 366 ms |

### Internal Timings & Prometheus Metrics
- **PostgreSQL Acquire Latency**: p50 = 2.29 ms, p95 = 4.81 ms
- **MySQL Acquire Latency**: p50 = 2.38 ms, p95 = 4.75 ms
- **Warm Pool Boot Failures (`coderunner_pool_boot_failures_total`)**: 0
- **Peak Pool Waiters (`coderunner_pool_waiters`)**: 0
- **Host MemAvailable**: Maintained at > 520 MB with 248 MB swap utilized
- **Host Load Average**: 2.10 - 3.04 (managed sustainably only within burst CPU credit limits)
