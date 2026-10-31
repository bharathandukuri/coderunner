# Capacity Planning & Sizing Reference

This document provides capacity planning guidelines and empirical benchmark data for CodeRunner worker instances running warm container pools.

---

## Worker Sizing Formula

To size a CodeRunner worker running warm database container pools (`WORKER_TYPE=db` or standalone Docker workers), use the following formula:

$$\text{RAM} = (\text{concurrency} \times (\text{DB\_container\_RAM} + \text{tmpfs})) + \text{worker\_overhead} + \text{safety\_margin}$$

### Parameters

| Variable | Description | Recommended Default |
|---|---|---|
| `concurrency` | Number of concurrent execution slots (`WORKER_CONCURRENCY`) | `2` (or host CPU count) |
| `DB_container_RAM` | Peak memory consumed per active database daemon container | **PostgreSQL**: ~64 MB<br>**MySQL**: ~256 MB |
| `tmpfs` | In-memory filesystem mounts per container (`/box` + `/tmp`) | **PostgreSQL**: 64 MB (`/box`) + 16 MB (`/tmp`) = 80 MB<br>**MySQL**: 128 MB (`/box`) + 16 MB (`/tmp`) = 144 MB |
| `worker_overhead` | Node.js worker runtime and BullMQ queue management | ~256 MB |
| `safety_margin` | OS, Docker daemon, buffer cache, and transient spikes | ~512 MB to 1 GB |

### Example Calculations

#### Example 1: Concurrency = 2 (Dedicated Database Worker)
For `WORKER_TYPE=db` running both PostgreSQL (size=2) and MySQL (size=2):
- **PostgreSQL Pool (2 containers)**: $2 \times (64\text{ MB} + 80\text{ MB}) = 288\text{ MB}$
- **MySQL Pool (2 containers)**: $2 \times (256\text{ MB} + 144\text{ MB}) = 800\text{ MB}$
- **Worker Process Overhead**: $256\text{ MB}$
- **Safety Margin**: $512\text{ MB}$
- **Total Recommended RAM**: $288 + 800 + 256 + 512 = 1,856\text{ MB} \approx \mathbf{2\text{ GB}}$

#### Example 2: Concurrency = 4 (High-Throughput Worker)
- **PostgreSQL Pool (4 containers)**: $4 \times (64\text{ MB} + 80\text{ MB}) = 576\text{ MB}$
- **MySQL Pool (4 containers)**: $4 \times (256\text{ MB} + 144\text{ MB}) = 1,600\text{ MB}$
- **Worker Process Overhead**: $256\text{ MB}$
- **Safety Margin**: $1,024\text{ MB}$
- **Total Recommended RAM**: $576 + 1,600 + 256 + 1,024 = 3,456\text{ MB} \approx \mathbf{3.5\text{ to }4\text{ GB}}$

---

## Empirical Benchmark Results

The following benchmark figures are **unmodified, real measurements** produced directly by `scripts/bench-pool.mjs` on an active CodeRunner instance.

### 1. Container Boot Times

Measures total time to invoke Docker create, start container, and verify daemon socket readiness (`/box/.ready`):

| Container / Engine | p50 (ms) | p95 (ms) | p99 (ms) | Min (ms) | Max (ms) | Avg (ms) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **PostgreSQL 16** | **306** | 337 | 337 | 297 | 337 | 310 |
| **MySQL 8.4** | **619** | 638 | 638 | 594 | 638 | 618 |
| **Python 3.8 (Cold on-demand)** | **117** | 147 | 147 | 113 | 147 | 122 |
| **Python 3.8 (Warm hit)** | **1** | 2 | 3 | 0 | 4 | 1 |

> [!NOTE]
> Warm hits for language pools provide a **~100x speedup** over cold container boots, reducing sandbox acquisition from ~120ms to 1ms.

### 2. Idle RAM Usage

Measured via Docker container stats (`MemoryStats.usage` net of buffer cache):

| Container / Engine | Net Usage (MB) | Total Usage with Cache (MB) |
|---|:---:|:---:|
| **PostgreSQL 16** | 57.76 MB | 57.76 MB |
| **MySQL 8.4** | 243.71 MB | 244.02 MB |
| **Python 3.8 (Idle)** | 1.55 MB | 1.55 MB |

### 3. Peak Resource Usage Under Heavy Queries

Measured during execution of high-row synthetic benchmarks:
- **PostgreSQL**: `SELECT count(*) FROM generate_series(1, 1000000);`
- **MySQL**: `WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 500000) SELECT count(*) FROM cte;`

| Engine | Peak RAM (MB) | tmpfs Mount Usage (`/box`) |
|---|:---:|:---:|
| **PostgreSQL 16** | 57.24 MB | 45.12 MB |
| **MySQL 8.4** | 242.88 MB | 99.61 MB |

### 4. End-to-End API Execution Latency

Measured across HTTP API roundtrips (`POST /submissions?wait=true`) with auth validation, queue transit, sandbox execution, and result collection:

| Language / Engine | Warm p50 (ms) | Warm p95 (ms) | Cold Avg (ms) |
|---|:---:|:---:|:---:|
| **PostgreSQL 16** | 205 ms | 226 ms | 205 ms |
| **MySQL 8.4** | 206 ms | 207 ms | 273 ms |
| **Python 3.8** | 306 ms | 306 ms | 204 ms |

---

## Tuning Recommendations

1. **Global Concurrent Boot Cap (`WARM_POOL_MAX_CONCURRENT_BOOTS`)**:
   - Default is `3`. On multi-core bare-metal hosts with fast NVMe disks, this can be increased to `concurrency` (e.g. 4–8) to replenish drained pools faster after high-load bursts.
2. **Dedicated Worker Segmentation (`WORKER_TYPE=db`)**:
   - Isolate workers (`WORKER_TYPE=isolate`) run CPU-bound untrusted code in lightweight cgroups.
   - Database workers (`WORKER_TYPE=db`) run the long-lived warm PostgreSQL and MySQL daemon pools. Keep them separated in production via Docker Compose or Kubernetes pods to avoid cross-tenant CPU/memory starvation.
3. **Tmpfs Sizing**:
   - Database daemons store their temporary WAL, tables, and Unix sockets in memory (`tmpfs`). Sizing `/box` to at least 64MB (PostgreSQL) and 128MB (MySQL) ensures complex subqueries and sorting operations execute in RAM without disk I/O bottlenecks.
