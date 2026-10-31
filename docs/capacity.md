# Capacity Planning & Sizing Reference

This document provides capacity planning guidelines and empirical benchmark data for CodeRunner worker instances running warm container pools.

Raw benchmark output is committed and available at [docs/benchmarks/benchmark.json](benchmarks/benchmark.json).

---

## Worker Sizing Formula

To size a CodeRunner worker running warm database container pools (`WORKER_TYPE=db` or standalone Docker workers), use the following formula:

$$\text{RAM} = (\text{concurrency} \times \text{Per\_Container\_RAM}) + \text{worker\_overhead} + \text{safety\_margin}$$

### Parameters

| Variable | Description | Recommended Default |
|---|---|---|
| `concurrency` | Number of concurrent execution slots (`WORKER_CONCURRENCY`) | `4` (configured default in `src/utils/config.js`) |
| `Per_Container_RAM` | Memory allocated per container. Database daemon containers (`PostgreSQL`, `MySQL`) have a cgroup memory limit of **512 MB** (`effectiveMemoryKb = 512000`). Empirical peak usage is ~63 MB for PostgreSQL and ~251 MB for MySQL. | **512 MB** (limit) or empirical peak (~63–251 MB) |
| `tmpfs` mounts | In-memory filesystem mounts per container configured in `src/executor/containerConfig.js`:<br>- **Database containers (`isDaemon=true`)**: `/box` is **256 MB** (`size=256m`) + `/tmp` is **64 MB** (`size=64m`) = **320 MB** total tmpfs ceiling.<br>- **Language pool containers**: `/box` is computed from memory (`boxSize = Math.max(Math.ceil(effectiveMemoryKb / 1024), 128)` MB) + `/tmp` is **64 MB** + `/home` is **16 MB**. | **320 MB** ceiling for DB; `boxSize` + 80 MB for languages |
| `worker_overhead` | Node.js worker runtime and BullMQ queue management | ~256 MB |
| `safety_margin` | Host OS, Docker daemon, buffer cache, and transient spikes | ~512 MB to 1 GB |

> [!IMPORTANT]
> **Tmpfs Accounting & Avoiding Double-Counting**:
> Under Linux cgroups (both v1 and v2), dirty pages on `tmpfs` filesystem mounts (`shmem`) are charged against the container's cgroup memory accounting (`memory.current` / `stats.memory_stats.usage`). Consequently, the empirical container memory measurements (reported below) **already include** actively used tmpfs pages.
> - When sizing based on **measured peak cgroup RAM**, do NOT add the full tmpfs mount limit on top, as that would double-count memory already in use.
> - When sizing for **worst-case burst isolation**, use the configured container memory limit (512 MB per DB container), which guarantees that containers can fill their `/box` (256 MB) and `/tmp` (64 MB) tmpfs quotas without triggering the cgroup OOM killer.

### Example Calculations

#### Example 1: Concurrency = 4 (Default High-Throughput Worker)
For `WORKER_TYPE=db` running both PostgreSQL (pool size=4) and MySQL (pool size=4) with default `WORKER_CONCURRENCY=4`:
- **Worst-case Limit Sizing (guaranteed OOM-safe under full tmpfs fill)**:
  - PostgreSQL Pool (4 containers @ 512 MB): $4 \times 512\text{ MB} = 2,048\text{ MB}$
  - MySQL Pool (4 containers @ 512 MB): $4 \times 512\text{ MB} = 2,048\text{ MB}$
  - Worker Process Overhead: $256\text{ MB}$
  - Safety Margin: $1,024\text{ MB}$
  - **Total Recommended RAM**: $2,048 + 2,048 + 256 + 1,024 = 5,376\text{ MB} \approx \mathbf{5.5\text{ to }6\text{ GB}}$
- **Empirical Peak Sizing (typical production queries)**:
  - PostgreSQL Pool (4 containers @ ~63 MB peak): $4 \times 63\text{ MB} = 252\text{ MB}$
  - MySQL Pool (4 containers @ ~251 MB peak): $4 \times 251\text{ MB} = 1,004\text{ MB}$
  - Worker Process Overhead: $256\text{ MB}$
  - Safety Margin: $1,024\text{ MB}$
  - **Total Recommended RAM**: $252 + 1,004 + 256 + 1,024 = 2,536\text{ MB} \approx \mathbf{2.5\text{ to }3\text{ GB}}$

#### Example 2: Concurrency = 2 (Budget Database Worker)
For `WORKER_TYPE=db` with PostgreSQL (pool size=2) and MySQL (pool size=2):
- **Worst-case Limit Sizing**: $(2 \times 512\text{ MB}) + (2 \times 512\text{ MB}) + 256\text{ MB} + 512\text{ MB} = 2,816\text{ MB} \approx \mathbf{3\text{ GB}}$
- **Empirical Peak Sizing**: $(2 \times 63\text{ MB}) + (2 \times 251\text{ MB}) + 256\text{ MB} + 512\text{ MB} = 126 + 502 + 256 + 512 = 1,396\text{ MB} \approx \mathbf{1.5\text{ to }2\text{ GB}}$

---

## Empirical Benchmark Results

The following benchmark figures are **unmodified, real measurements** produced directly by `scripts/bench-pool.mjs` (5 iterations) on an active CodeRunner instance.

Raw benchmark JSON: [`docs/benchmarks/benchmark.json`](benchmarks/benchmark.json).

### Benchmark Environment

| Property | Value |
|---|---|
| **CPU Model** | 12th Gen Intel(R) Core(TM) i5-12500H |
| **CPU Cores** | 16 |
| **Total RAM** | 15.23 GB |
| **Kernel Version** | 7.2.13-200.fc44.x86_64 |
| **Docker Version** | 29.9.2 |
| **Storage Driver** | overlayfs |
| **Commit Hash** | `e9329e6338cb68541ed70ecba810bf840c121772` |
| **Date** | 2026-10-31T17:18:49.463Z |

---

### 1. Container Boot Times

Measures total time to invoke Docker create, start container, and verify daemon socket readiness (`/box/.ready`):

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `e9329e6`, 2026-10-31.

| Container / Engine | p50 (ms) | p95 (ms) | p99 (ms) | Min (ms) | Max (ms) | Avg (ms) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **PostgreSQL 16** | **331** | 392 | 392 | 280 | 392 | 330 |
| **MySQL 8.4** | **750** | 924 | 924 | 706 | 924 | 793 |
| **Python 3.8 (Cold on-demand)** | **127** | 139 | 139 | 117 | 139 | 126 |
| **Python 3.8 (Warm hit)** | **1** | 2 | 3 | 0 | 4 | 1 |

> [!NOTE]
> Warm hits for language pools provide a **~100x speedup strictly for container acquisition** (reducing sandbox acquisition from ~127ms down to ~1ms). This speedup applies to the container boot/acquisition phase only; see Table 4 for end-to-end API latency analysis.

---

### 2. Idle RAM Usage

Measured via Docker container stats (`MemoryStats.usage` net of buffer cache):

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `e9329e6`, 2026-10-31.

| Container / Engine | Net Usage (MB) | Total Usage with Cache (MB) |
|---|:---:|:---:|
| **PostgreSQL 16** | 57.81 MB | 57.81 MB |
| **MySQL 8.4** | 242.02 MB | 242.28 MB |
| **Python 3.8 (Cold)** | 1.37 MB | 1.37 MB |

---

### 3. Peak Resource Usage Under Heavy Queries

Measured during execution of high-row synthetic benchmarks:
- **PostgreSQL**: `SELECT count(*) FROM generate_series(1, 1000000);`
- **MySQL**: `WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 500000) SELECT count(*) FROM cte;`

Peak memory sampled via cgroup `memory.peak` (and polled at <=25 ms during execution):

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `e9329e6`, 2026-10-31.

| Engine | Peak RAM (MB) | tmpfs Mount Usage (`/box`) |
|---|:---:|:---:|
| **PostgreSQL 16** | 62.97 MB | 45.12 MB |
| **MySQL 8.4** | 250.43 MB | 99.61 MB |

*Note: Sampling cgroup `memory.peak` accurately reflects peak memory reached during the workload, ensuring peak RAM (62.97 MB for PG, 250.43 MB for MySQL) >= idle RAM (57.81 MB and 242.02 MB).*

---

### 4. End-to-End API Execution Latency

Measured across HTTP API roundtrips (`POST /submissions?wait=true`) with auth validation, queue transit, sandbox execution, and result collection:

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `e9329e6`, 2026-10-31.

| Language / Engine | Warm p50 (ms) | Warm p95 (ms) | Cold Avg (ms) |
|---|:---:|:---:|:---:|
| **PostgreSQL 16** | 306 ms | 308 ms | 240 ms |
| **MySQL 8.4** | 305 ms | 307 ms | 340 ms |
| **Python 3.8** | 306 ms | 308 ms | 306 ms |

> [!NOTE]
> **End-to-End Latency Analysis & Observations**:
> - End-to-end execution measures total client-perceived roundtrip time over HTTP (`POST /submissions?wait=true`). This incorporates Express routing, authentication validation, BullMQ job serialization, Redis pub/sub wait, worker dequeue, container acquisition/exec, output capture, and JSON response serialization.
> - **Database Daemons**: For MySQL 8.4, warm pool execution achieves p50 of 305 ms vs cold average of 340 ms (cold peak 407 ms). Because cold database boots require initializing the full DBMS server daemon (~750 ms), running with warm daemons avoids queue congestion and startup latency spikes.
> - **Python (3.8)**: In standard worker configurations, `ENABLE_LANGUAGE_POOL` defaults to `false`. As a result, Python submissions execute on-demand in both test runs, yielding identical baseline latencies (~306 ms). The ~100x speedup observed in Table 1 applies strictly to container acquisition (1 ms warm vs 127 ms cold); once enqueued through HTTP and BullMQ, queue transit and IPC overhead account for the majority of the wall-clock duration.

---

## Tuning Recommendations

1. **Global Concurrent Boot Cap (`WARM_POOL_MAX_CONCURRENT_BOOTS`)**:
   - Default is `3`. On multi-core bare-metal hosts with fast NVMe disks, this can be increased to `concurrency` (e.g. 4–8) to replenish drained pools faster after high-load bursts.
2. **Dedicated Worker Segmentation (`WORKER_TYPE=db`)**:
   - Isolate workers (`WORKER_TYPE=isolate`) run CPU-bound untrusted code in lightweight cgroups.
   - Database workers (`WORKER_TYPE=db`) run the long-lived warm PostgreSQL and MySQL daemon pools. Keep them separated in production via Docker Compose or Kubernetes pods to avoid cross-tenant CPU/memory starvation.
3. **Tmpfs Sizing**:
   - Database daemons store their temporary WAL, tables, and Unix sockets in memory (`tmpfs`). Sizing `/box` to 256 MB and `/tmp` to 64 MB (as configured in `src/executor/containerConfig.js`) ensures complex subqueries and sorting operations execute in RAM without disk I/O bottlenecks.
