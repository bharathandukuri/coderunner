# Capacity Planning & Sizing Reference

This document provides capacity planning guidelines and empirical benchmark data for CodeRunner worker instances running warm container pools.

Raw benchmark output is committed and available at [docs/benchmarks/benchmark.json](benchmarks/benchmark.json).

---

## Worker Sizing Formula

To size a CodeRunner worker running warm database container pools (`WORKER_TYPE=db` or standalone Docker workers), use the following formula.

Under sustained execution load, running jobs consume containers from the warm pool while the pool background worker actively replenishes them back to `targetPoolSize` (which defaults to `concurrency` per engine). Therefore, in the worst case under continuous traffic, the system holds both the **actively running containers** AND the **replenished warm idle containers** simultaneously (approximately $2 \times \text{concurrency}$ containers per engine):

$$\text{RAM} = \sum_{\text{engine}} \left( 2 \times \text{concurrency} \times \text{Per\_Container\_RAM}_{\text{engine}} \right) + \text{worker\_overhead} + \text{safety\_margin}$$

Or generalized for custom pool targets:

$$\text{RAM} = \sum_{\text{engine}} \left( (\text{Target\_Pool\_Size}_{\text{engine}} + \text{Active\_Concurrent\_Jobs}_{\text{engine}}) \times \text{Per\_Container\_RAM}_{\text{engine}} \right) + \text{worker\_overhead} + \text{safety\_margin}$$

### Parameters

| Variable | Description | Recommended Default |
|---|---|---|
| `concurrency` | Number of concurrent execution slots (`WORKER_CONCURRENCY`) | `4` (configured default in `src/utils/config.js`) |
| `2 * concurrency` | Total concurrent container capacity: `concurrency` actively executing jobs + `concurrency` idle containers replenished in the pool | $2 \times 4 = 8$ containers per active engine |
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
For `WORKER_TYPE=db` running both PostgreSQL and MySQL with default `WORKER_CONCURRENCY=4`:
- Container count: $2 \times 4 = 8$ PostgreSQL containers (4 executing + 4 warm idle) and $2 \times 4 = 8$ MySQL containers (4 executing + 4 warm idle).
- **Worst-case Limit Sizing (guaranteed OOM-safe under full tmpfs fill)**:
  - PostgreSQL Pool (8 containers @ 512 MB): $8 \times 512\text{ MB} = 4,096\text{ MB}$
  - MySQL Pool (8 containers @ 512 MB): $8 \times 512\text{ MB} = 4,096\text{ MB}$
  - Worker Process Overhead: $256\text{ MB}$
  - Safety Margin: $1,024\text{ MB}$
  - **Total Recommended RAM**: $4,096 + 4,096 + 256 + 1,024 = 9,472\text{ MB} \approx \mathbf{9.5\text{ to }10\text{ GB}}$
- **Empirical Peak Sizing (typical production queries)**:
  - PostgreSQL Pool (8 containers @ ~63 MB peak): $8 \times 63\text{ MB} = 504\text{ MB}$
  - MySQL Pool (8 containers @ ~251 MB peak): $8 \times 251\text{ MB} = 2,008\text{ MB}$
  - Worker Process Overhead: $256\text{ MB}$
  - Safety Margin: $1,024\text{ MB}$
  - **Total Recommended RAM**: $504 + 2,008 + 256 + 1,024 = 3,792\text{ MB} \approx \mathbf{4\text{ GB}}$

#### Example 2: Concurrency = 2 (Budget Database Worker)
For `WORKER_TYPE=db` with PostgreSQL and MySQL with `WORKER_CONCURRENCY=2`:
- Container count: $2 \times 2 = 4$ PostgreSQL containers and $2 \times 2 = 4$ MySQL containers.
- **Worst-case Limit Sizing**: $(4 \times 512\text{ MB}) + (4 \times 512\text{ MB}) + 256\text{ MB} + 512\text{ MB} = 2,048 + 2,048 + 256 + 512 = 4,864\text{ MB} \approx \mathbf{5\text{ GB}}$
- **Empirical Peak Sizing**: $(4 \times 63\text{ MB}) + (4 \times 251\text{ MB}) + 256\text{ MB} + 512\text{ MB} = 252 + 1,004 + 256 + 512 = 2,024\text{ MB} \approx \mathbf{2\text{ to }2.5\text{ GB}}$

---

## Empirical Benchmark Results

The following benchmark figures are **unmodified, real measurements** produced directly by `scripts/bench-pool.mjs` (200 iterations) on an active CodeRunner instance.

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
| **Commit Hash** | `70cdb739d7f0af37df9fb8b96ddcb904c07866a2` |
| **Date** | 2026-10-31T17:43:04.637Z |

---

### 1. Container Boot Times

Measures total time to invoke Docker create, start container, and verify daemon socket readiness (`/box/.ready`):

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `70cdb73`, 2026-10-31.

| Container / Engine | p50 (ms) | p95 (ms) | p99 (ms) | Min (ms) | Max (ms) | Avg (ms) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **PostgreSQL 16** | **308** | 1122 | 1569 | 248 | 1978 | 406 |
| **MySQL 8.4** | **664** | 1454 | 1723 | 571 | 2006 | 750 |
| **Python 3.8 (Cold on-demand)** | **114** | 994 | 1114 | 99 | 1281 | 242 |
| **Python 3.8 (Warm hit)** | **2** | 264 | 380 | 0 | 492 | 77 |

> [!NOTE]
> Warm hits for language pools provide a **~50x speedup strictly for median container acquisition** (reducing median sandbox acquisition from ~114 ms cold down to ~2 ms warm; however, p95 is 264 ms and p99 is 380 ms warm vs p95 994 ms and p99 1,114 ms cold). This 50x speedup applies to the **median acquisition phase only**; see Table 4 for end-to-end API latency analysis.
> 
> *Note on Hardware:* All empirical measurements reported in this document were conducted on a developer laptop (12th Gen Intel Core i5-12500H, 16 cores, 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64) and must be re-measured on production hardware.

---

### 2. Idle RAM Usage

Measured via Docker container stats (`MemoryStats.usage` net of buffer cache):

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `70cdb73`, 2026-10-31.

| Container / Engine | Net Usage (MB) | Total Usage with Cache (MB) |
|---|:---:|:---:|
| **PostgreSQL 16** | 57.08 MB | 57.08 MB |
| **MySQL 8.4** | 243.63 MB | 243.89 MB |
| **Python 3.8 (Cold)** | 1.70 MB | 1.70 MB |

---

### 3. Peak Resource Usage Under Heavy Queries

Measured during execution of high-row synthetic benchmarks:
- **PostgreSQL**: `SELECT count(*) FROM generate_series(1, 1000000);`
- **MySQL**: `WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 500000) SELECT count(*) FROM cte;`

Peak memory sampled via cgroup `memory.peak` (and polled at <=25 ms during execution):

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `70cdb73`, 2026-10-31.

| Engine | Peak RAM (MB) | tmpfs Mount Usage (`/box`) |
|---|:---:|:---:|
| **PostgreSQL 16** | 62.89 MB | 45.12 MB |
| **MySQL 8.4** | 251.39 MB | 99.61 MB |

*Note: Sampling cgroup `memory.peak` accurately reflects peak memory reached during the workload, ensuring peak RAM (62.89 MB for PG, 251.39 MB for MySQL) >= idle RAM (57.08 MB and 243.63 MB).*

---

### 4. End-to-End API Execution Latency

Measured across HTTP API roundtrips (`POST /submissions?wait=true`) with auth validation, queue transit, sandbox execution, and result collection:

> **Environment:** 12th Gen Intel(R) Core(TM) i5-12500H (16 cores), 15.23 GB RAM, Linux 7.2.13-200.fc44.x86_64, Docker 29.9.2 (overlayfs), commit `70cdb73`, 2026-10-31. *(Dev laptop environment — re-measurement on production server hardware required).*

| Language / Engine | Warm p50 (ms) | Warm p95 (ms) | Warm p99 (ms) | Cold / Baseline Avg (ms) | Server Warm p50 (p95 / p99) (ms) | Server Cold / Baseline Avg (ms) |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **PostgreSQL 16** | 161 ms | 1582 ms (~1.6 s) | 2800 ms (~2.8 s) | 159 ms (p50: 158 ms) | 157 ms (1536 / 2783 ms) | 155 ms |
| **MySQL 8.4** | 260 ms | 599 ms | 802 ms | 340 ms (p50: 213 ms) | 255 ms (595 / 798 ms) | 335 ms |
| **Python 3.8 (Run 1 / Run 2)** | 208 ms (Run 1) | 1344 ms | 1663 ms | 199 ms (Run 2 avg) | 204 ms (1333 / 1660 ms) | 195 ms |

> [!NOTE]
> **End-to-End Latency Analysis & Observations**:
> - End-to-end execution measures total client-perceived roundtrip time over HTTP (`POST /submissions?wait=true`). When clients request `wait=true`, the API implements a push-based wait over Redis Pub/Sub (`submission:<token>:done` channel) with an active 100 ms polling fallback, rather than pure periodic polling. This eliminates up to 100 ms of polling quantization jitter and immediately delivers results as soon as the worker completes execution and persists the output. Server-side execution duration (`finished_at - created_at`) directly captures queue transit, sandbox acquisition, code execution, and result persistence.
> - **Database Daemons (Invalidity of Cold vs Warm Comparison)**: For database languages (PostgreSQL and MySQL), the benchmark's "cold" test runs were executed against the same worker stack with warm pools enabled. Both test passes therefore acquired pre-warmed database daemon containers from the pool. As a result, **the comparison between cold and warm database latency in these test runs is invalid**; any claim that warm MySQL beats cold MySQL is unfounded from these numbers. True cold database boots without a warm pool require initializing the full DBMS server daemon from scratch (~664–750 ms boot time from Table 1).
> - **Tail Latency Under Load**: While median warm roundtrips are fast (p50 of 161 ms for PostgreSQL, 260 ms for MySQL), tail latency under high-concurrency bursts increases significantly: PostgreSQL warm p95 reaches 1,582 ms (~1.6 s) and p99 reaches 2,800 ms (~2.8 s), and MySQL warm p95 reaches 599 ms / p99 802 ms as queue transit and worker concurrency slots saturate.
> - **Python 3.8**: In standard worker configurations, `ENABLE_LANGUAGE_POOL` defaults to `false`. As a result, both test passes executed on-demand with the language pool disabled (relabelled as Run 1 and Run 2 in Table 4), yielding similar baseline latencies (Run 1 p50: 208 ms, p95: 1,344 ms; Run 2 avg: 199 ms, p50: 197 ms). The ~50x speedup observed in Table 1 applies strictly to the median container acquisition phase (2 ms warm vs 114 ms cold; p95: 264 ms vs 994 ms); once enqueued through HTTP and BullMQ, queue transit, execution, and IPC account for the majority of client wall-clock duration.

---

## Tuning Recommendations

1. **Global Concurrent Boot Cap (`WARM_POOL_MAX_CONCURRENT_BOOTS`)**:
   - Default is `3`. On multi-core bare-metal hosts with fast NVMe disks, this can be increased to `concurrency` (e.g. 4–8) to replenish drained pools faster after high-load bursts.
2. **Pool Size Exceeding Concurrency for Sustained Load (Marked Untested)**:
   - Setting a target pool size larger than worker concurrency (`targetPoolSize > concurrency`, for example `WARM_POOL_TARGET_POSTGRES=6` or `8` with `WORKER_CONCURRENCY=4`) may help buffer sustained high-throughput burst traffic by providing additional pre-warmed idle containers while background replenishment boots new ones. *(Note: Marked untested pending long-term soak testing under heavy production loads).*
3. **Dedicated Worker Segmentation (`WORKER_TYPE=db`)**:
   - Isolate workers (`WORKER_TYPE=isolate`) run CPU-bound untrusted code in lightweight cgroups.
   - Database workers (`WORKER_TYPE=db`) run the long-lived warm PostgreSQL and MySQL daemon pools. Keep them separated in production via Docker Compose or Kubernetes pods to avoid cross-tenant CPU/memory starvation.
4. **Tmpfs Sizing**:
   - Database daemons store their temporary WAL, tables, and Unix sockets in memory (`tmpfs`). Sizing `/box` to 256 MB and `/tmp` to 64 MB (as configured in `src/executor/containerConfig.js`) ensures complex subqueries and sorting operations execute in RAM without disk I/O bottlenecks.
5. **Rate Limiting**:
   - The API enforces dedicated rate limiting for `POST /submissions` (configured via `RATE_LIMIT_SUBMISSIONS_WINDOW_MS`, default 60000 ms, and `RATE_LIMIT_SUBMISSIONS_MAX`, default 120 requests/window) in addition to global IP rate limits (`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS`), protecting the execution queue from denial-of-service floods.
