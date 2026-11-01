# Capacity, Sizing, and Limits Reference

This document is the authoritative capacity planning reference for CoderRunner. It details workload definitions, pass/fail operational criteria, empirically measured resource consumption, hardware sizing formulas, cloud VM capacity recommendations, overload behavior, and a reference table of every configuration variable controlling capacity.

---

## 1. Workload Definitions

A "typical submission" for capacity testing is defined for each execution engine as follows:

- **Code Submission (Python, C++, Java, Node.js)**:
  - Execution limits: 1.0 s CPU time, 10.0 s wall-clock time, 256 MB RAM limit.
  - Payload: Standard algorithmic task (e.g. 10,000 iterations of integer multiplication, array sorting, or string manipulation, printing output to stdout).
  - Executor: Linux Isolate (default) or multi-language Docker container.
- **PostgreSQL 16 Submission**:
  - Execution limits: 10.0 s wall-clock time, 512 MB container RAM.
  - Payload: Schema creation (`CREATE TABLE`), batch insertion of 1,000 rows with mixed types, followed by 3 analytic queries (indexed lookup, aggregation with `GROUP BY`, and window function).
  - Executor: Pre-warmed isolated PostgreSQL Docker container.
- **MySQL 8.4 Submission**:
  - Execution limits: 10.0 s wall-clock time, 512 MB container RAM.
  - Payload: Identical SQL schema, 1,000 rows inserted, followed by 3 analytic queries.
  - Executor: Pre-warmed isolated MySQL Docker container.

---

## 2. Pass / Fail Capacity Criteria

A given request arrival rate is considered "handled sustainably" by a host only when all five criteria below are satisfied:

1. **p95 Latency**:
   - Code execution: p95 end-to-end turnaround under **2.5 seconds**.
   - Database execution: p95 end-to-end turnaround under **3.5 seconds**.
2. **Error Rate**: **0.0%** infrastructure or runtime errors (HTTP 500, status 13 internal error, or dropped connections). Submissions with user syntax errors (status 6) or user time limit exceeded (status 5) are expected application outcomes and excluded from error counts.
3. **Container Boot Failures**: **0** pool boot failures (`coderunner_pool_boot_failures_total == 0`).
4. **Host Memory Headroom**: Host available memory (`MemAvailable`) stays strictly above **15%** of total physical RAM throughout the test.
5. **Queue Stability**: Average BullMQ queue depth does not grow monotonically over a 5-minute window.

---

## 3. Measured Sizing Formulas

The formulas below are derived directly from empirical `docker stats` measurements on live instances.

### Measured Service & Container Footprints

| Component                   | Idle RAM | Active / Peak RAM | Description                                                                                                                      |
| --------------------------- | -------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **Core Base Stack**         | ~150 MiB | ~170 MiB          | Caddy (18 MiB), API (41 MiB), Worker (40 MiB), Worker-DB (39 MiB), Redis (6 MiB), Docker-Proxy (4 MiB)                           |
| **Monitoring Profile**      | ~210 MiB | ~260 MiB          | Prometheus (70 MiB), Grafana (56 MiB), cAdvisor (42 MiB), Alertmanager (18 MiB), Node-Exporter (14 MiB), Redis-Exporter (10 MiB) |
| **Host OS Baseline**        | ~350 MiB | ~350 MiB          | Kernel, systemd, journald, SSH, Docker daemon                                                                                    |
| **PostgreSQL 16 Container** | ~57 MiB  | ~75 MiB           | Single isolated warm PostgreSQL instance                                                                                         |
| **MySQL 8.4 Container**     | ~243 MiB | ~280 MiB          | Single isolated warm MySQL instance with Performance Schema off                                                                  |
| **MongoDB 8.0 Container**   | ~90 MiB  | ~97 MiB           | Single isolated warm MongoDB instance with WiredTiger cache 0.25GB (`coderunner/mongodb:8.0`, ~694 MB multi-stage build via `scripts/build-images.sh`) |
| **Isolate Code Job**        | 0 MiB    | ~15–30 MiB        | Process in Linux namespaces (allocated on demand, released immediately)                                                          |
| **Docker Code Container**   | ~25 MiB  | ~45–128 MiB       | Cold or pooled language runner container                                                                                         |

### Formulas

#### Minimum Required RAM

$$\text{RAM}_{\text{min}} = \text{Base} + (\text{Workers} \times \text{Concurrency} \times \text{RAM}_{\text{job}}) + \sum (\text{PoolSize}_{e} \times \text{RAM}_{\text{pool},e})$$

Where:

- $\text{Base} = 500\text{ MiB}$ without monitoring, or $710\text{ MiB}$ with `ENABLE_MONITORING=true`.
- $\text{RAM}_{\text{job}} = 30\text{ MiB}$ for Isolate workers, or $128\text{ MiB}$ for Docker code workers.
- $\text{RAM}_{\text{pool},\text{pg}} = 75\text{ MiB}$ per PostgreSQL container.
- $\text{RAM}_{\text{pool},\text{my}} = 280\text{ MiB}$ per MySQL container.
- $\text{RAM}_{\text{pool},\text{mongo}} = 97\text{ MiB}$ per MongoDB container (when `ENABLE_MONGODB=true`).

#### Minimum Required vCPU

$$\text{vCPU}_{\text{min}} = \max\left(1, \left\lceil \frac{\text{Workers} \times \text{Concurrency}}{\text{OvercommitFactor}} \right\rceil\right)$$

Where $\text{OvercommitFactor}$ is typically $2.0$ for compute-heavy workloads or $4.0$ for database workloads spending significant time waiting on disk I/O.

### Swap Recommendation

- **Recommendation**: Configure a swapfile equal to **50% to 100% of physical RAM** (e.g. 1 GB to 2 GB swap on a 2 GB host).
- **Reasoning**: Without swap, transient spikes in database memory or concurrent container boots trigger the Linux Out-Of-Memory (OOM) killer immediately, abruptly terminating `dockerd`, `redis`, or `worker`. With swap, transient allocations page to disk safely without process termination, while container memory limits (`DEFAULT_MEMORY_LIMIT`, `API_MEMORY`, etc.) continue to constrain user jobs. However, continuous sustained load must fit entirely within physical RAM to avoid disk thrashing.

---

## 4. Hardware Sizing & Measured Capacity Tiers

> [!IMPORTANT]
> **Database Throughput Ceiling & Horizontal Scaling**: Database submissions are fundamentally limited to approximately **1 to 2 requests per second per node** (empirically measured for PostgreSQL 16 and MySQL 8.4; MongoDB 8.0 is not measured) regardless of host vCPU count. Because every database execution is fully sandboxed and consumes an isolated, ephemeral container boot, the Docker daemon serializes container destroy and create lifecycles under continuous load. **The only effective way to scale database throughput is horizontal worker scaling by adding `worker-db` nodes** (using `docker-compose.hub.yml`). In contrast, native code submissions run via Linux Isolate and scale linearly with host vCPUs (sustaining ≥ 70 req/s on 8 vCPUs with ~20 ms latency).

The following table details recommended configurations and measured throughput limits.

> **Measurement Standard**: All figures cited below are from raw benchmark log files committed in `docs/benchmarks/`. Cells marked **TODO: not measured** represent unverified configurations where physical VM benchmarks have not yet been executed.

| Sizing Tier & Test Environment                                                                                             | Recommended Settings                                                                                                                                                        | Code-Only (Isolate) Max RPS | Code-Only (Docker) Max RPS | DB-Only (PG+MySQL) Max RPS | Mixed (70% Code / 30% DB) Max RPS                       | Source Citation                                                                    |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | -------------------------- | -------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **1 vCPU / 2 GB RAM**<br>_(measured on real EC2 t3.small; degraded result — burst degraded, host locked up >1 RPS)_        | `WORKER_CONCURRENCY=2`<br>`POSTGRES_POOL_SIZE=2`<br>`MYSQL_POOL_SIZE=2`<br>`MAX_QUEUE_DEPTH=50`<br>`MAX_DB_QUEUE_DEPTH=10`<br>`RATE_LIMIT_SUBMISSIONS_MAX=60`  | TODO: not measured          | TODO: not measured         | TODO: not measured         | **0.67 req/s**<br>_(Highest rate survived; degraded on burst, locked up >1 RPS)_  | [docs/benchmarks/ec2-t3-small-sustained.md](benchmarks/ec2-t3-small-sustained.md)  |
| **2 vCPU / 4 GB RAM**<br>_(measured on laptop VM: i5-12500H, 2 pinned cores; comparable to t3.medium, cx32)_             | `WORKER_CONCURRENCY=4`<br>`POSTGRES_POOL_SIZE=4`<br>`MYSQL_POOL_SIZE=4`<br>`MAX_QUEUE_DEPTH=100`<br>`MAX_DB_QUEUE_DEPTH=20`<br>`RATE_LIMIT_SUBMISSIONS_MAX=120` | **≥ 30 req/s**\*            | TODO: not measured         | **1 req/s**                | **2 req/s**                                             | [docs/benchmarks/2026-11-01-2c-4g/README.md](benchmarks/2026-11-01-2c-4g/README.md)  |
| **4 vCPU / 8 GB RAM**<br>_(measured on laptop VM: i5-12500H, 4 pinned cores; comparable to t3.xlarge, cx42)_             | `WORKER_CONCURRENCY=8`<br>`POSTGRES_POOL_SIZE=6`<br>`MYSQL_POOL_SIZE=6`<br>`MAX_QUEUE_DEPTH=200`<br>`MAX_DB_QUEUE_DEPTH=40`<br>`RATE_LIMIT_SUBMISSIONS_MAX=240` | **≥ 50 req/s**\*            | TODO: not measured         | **1 req/s**                | **2 req/s**                                             | [docs/benchmarks/2026-11-01-4c-8g/README.md](benchmarks/2026-11-01-4c-8g/README.md)  |
| **8 vCPU / 10–16 GB RAM**<br>_(measured on laptop VM: i5-12500H, 8 pinned cores; comparable to c6i.2xlarge)_               | `WORKER_CONCURRENCY=16`<br>`POSTGRES_POOL_SIZE=10`<br>`MYSQL_POOL_SIZE=10`<br>`MAX_QUEUE_DEPTH=400`<br>`MAX_DB_QUEUE_DEPTH=80`<br>`RATE_LIMIT_SUBMISSIONS_MAX=500` | **≥ 70 req/s**\*            | TODO: not measured         | **2 req/s**                | **3 req/s**                                             | [docs/benchmarks/2026-11-01-8c-10g/README.md](benchmarks/2026-11-01-8c-10g/README.md) |

\* **Lower Bound Note**: The reported Isolate throughput figures (≥ 30, ≥ 50, ≥ 70 req/s) represent lower bounds because the capacity ramp test reached its predefined test ceiling cleanly. In 2x overload verification runs, requests were processed with 100% completion (e.g. at 140 req/s on 8 vCPU, 8,295 submissions completed successfully with HTTP 201 while 106 excess requests were gracefully throttled via HTTP 503 backpressure).

---

## 5. Overload & Failure Behavior

When incoming load exceeds server sizing boundaries, CoderRunner degrades predictably rather than cascading into silent data loss:

1. **Queue Fills (`MAX_QUEUE_DEPTH` and `MAX_DB_QUEUE_DEPTH` reached)**:
   - `MAX_QUEUE_DEPTH` applies to the code queue (`submissions`), and `MAX_DB_QUEUE_DEPTH` applies to the database queue (`submissions-db`).
   - Both are **soft limits**: an incoming request or batch is admitted as long as the target queue's waiting depth is strictly below the limit at arrival time. A single batch can cause the queue depth to temporarily exceed the limit by up to `MAX_BATCH_SIZE - 1`.
   - When a target queue reaches or exceeds its limit, incoming requests targeting that queue are rejected immediately with **HTTP 503 Service Unavailable** (specifying the full queue name, depth, and limit) and a `Retry-After: 5` header.
2. **Synchronous Wait Cap (`MAX_CONCURRENT_WAIT_REQUESTS` reached)**:
   - If clients submit with `?wait=true` faster than jobs complete, the API caps concurrent long-poll connections. Further `wait=true` requests receive HTTP 503, preventing HTTP socket descriptor exhaustion in Node.js.
3. **Worker Concurrency Exceeded**:
   - Submissions accumulate safely in the BullMQ Redis queue. Latency climbs linearly with queue length. Waiters on `?wait=true` resolve as soon as jobs complete or until `CONTAINER_TIMEOUT` triggers.
4. **RAM Exhaustion**:
   - Host containers have explicit cgroup limits (`mem_limit`). If an individual submission exceeds its memory cap, the sandbox terminates only that submission process with an Out-Of-Memory error (status 4).
   - Redis runs with `--maxmemory-policy noeviction`. If Redis reaches `REDIS_MAXMEMORY`, it rejects new write operations with an error rather than evicting queued jobs or cached results.
5. **Database Pool Depletion**:
   - If requests arrive faster than containers can be returned or replenished, incoming database jobs queue up to `POOL_MAX_WAITERS`.
   - If a warm container crashes during execution, the worker initiates fallback on-demand recovery. If 3 consecutive boot attempts fail, the **Circuit Breaker** trips, temporarily protecting the Docker daemon from fork storms while alerting operators via Prometheus.

---

## 6. Environment Variable Reference

The table below catalogs every environment variable controlling capacity, concurrency, resources, timeouts, and daemon behavior.

| Variable                           | Default                              | Component  | Description & Operational Impact                                                |
| ---------------------------------- | ------------------------------------ | ---------- | ------------------------------------------------------------------------------- |
| `ALERTMANAGER_PIDS_LIMIT`          | `100`                                | Compose    | Process count ceiling for Alertmanager container                                |
| `ALERT_WEBHOOK_URL`                | `http://localhost:5001/`             | Compose    | Webhook receiver endpoint for Alertmanager notifications                        |
| `API_BASE_URL`                     | `http://localhost:3000`              | API        | Canonical base URL for API self-reference                                       |
| `API_CPUS`                         | `1.0`                                | Compose    | Maximum CPU allocation for the Express API container                            |
| `API_MEMORY`                       | `512M`                               | Compose    | Memory ceiling for Express API container                                        |
| `API_PIDS_LIMIT`                   | `200`                                | Compose    | Maximum process count for Express API container                                 |
| `AUTH_HEADERS`                     | `X-Auth-Token x-rapidapi-key`        | API        | Space-separated list of accepted HTTP header names for authentication           |
| `AUTH_TOKEN`                       | _(empty / open)_                     | API        | Space-separated list of valid bearer tokens for API authentication              |
| `BODY_LIMIT`                       | `5mb`                                | API        | Maximum allowed payload size for HTTP request bodies                            |
| `CADDY_CPUS`                       | `1.0`                                | Compose    | Maximum CPU allocation for the Caddy edge proxy container                       |
| `CADDY_MEMORY`                     | `256M`                               | Compose    | Memory ceiling for Caddy container                                              |
| `CADDY_PIDS_LIMIT`                 | `100`                                | Compose    | Maximum process count for Caddy container                                       |
| `CADVISOR_PIDS_LIMIT`              | `200`                                | Compose    | Process count ceiling for cAdvisor container                                    |
| `CODERUNNER_IMAGE_NAMESPACE`       | `coderunner`                         | Compose    | Docker image namespace prefix for runner images                                 |
| `CODERUNNER_VERSION`               | `latest`                             | Compose    | Version tag for custom runner images                                            |
| `COMPILE_CPU_TIME_LIMIT`           | `15`                                 | Sandbox    | Default CPU time limit (seconds) for compilation step (C++, Java)               |
| `COMPILE_WALL_TIME_LIMIT`          | `30`                                 | Sandbox    | Default wall-clock time limit (seconds) for compilation step                    |
| `CONTAINER_TIMEOUT`                | `30000`                              | Worker     | Hard timeout (milliseconds) for container execution and acquire waits           |
| `DEFAULT_CPU_TIME_LIMIT`           | `5`                                  | Sandbox    | Default CPU time limit (seconds) per submission if unspecified                  |
| `DEFAULT_MEMORY_LIMIT`             | `128000`                             | Sandbox    | Default memory limit in kilobytes (128 MB) per submission                       |
| `DEFAULT_STACK_LIMIT`              | `64000`                              | Sandbox    | Default stack limit in kilobytes (64 MB) for Isolate                            |
| `DEFAULT_WALL_TIME_LIMIT`          | `10`                                 | Sandbox    | Default wall-clock time limit (seconds) per submission if unspecified           |
| `DOCKER_HOST`                      | _(empty)_                            | Worker     | Remote Docker daemon TCP socket URL (e.g. `tcp://docker-proxy:2375`)            |
| `DOCKER_PROXY_PIDS_LIMIT`          | `50`                                 | Compose    | Process count ceiling for docker-socket-proxy container                         |
| `DOCKER_RUNTIME`                   | _(empty / runc)_                     | Worker     | Alternative Docker runtime engine (e.g. `runsc` for gVisor sandboxing)          |
| `DOCKER_SOCKET`                    | `/var/run/docker.sock`               | Worker     | Path to Docker UNIX domain socket                                               |
| `DOMAIN`                           | `localhost`                          | Compose    | Public domain name configured in Caddy for automatic TLS                        |
| `ENABLE_LANGUAGE_POOL`             | `false`                              | Worker     | Enables warm container pooling for standard programming languages               |
| `ENABLE_MONGODB`                   | `false`                              | Worker | Opt-in flag to enable MongoDB 8.0 support and container pool                    |
| `GF_SERVER_ROOT_URL`               | `%(protocol)s://%(domain)s/grafana/` | Compose    | Grafana subpath routing configuration                                           |
| `GRAFANA_CPUS`                     | `0.5`                                | Compose    | CPU ceiling for Grafana container                                               |
| `GRAFANA_MEMORY`                   | `512M`                               | Compose    | Memory ceiling for Grafana container                                            |
| `GRAFANA_PASSWORD`                 | `admin`                              | Compose    | Initial administrator password for Grafana                                      |
| `GRAFANA_PIDS_LIMIT`               | `100`                                | Compose    | Process count ceiling for Grafana container                                     |
| `GRAFANA_SITE_ADDRESS`             | `localhost:3001`                     | Compose    | Bind address for Grafana web interface                                          |
| `INSTANCE_ID`                      | `worker-<uuid>`                      | Worker     | Unique worker identifier used for container tagging and orphan cleanup          |
| `MAX_ADDITIONAL_FILES_SIZE`        | `2097152`                            | Sandbox    | Maximum size (bytes) of auxiliary files submitted with code (2 MB)              |
| `MAX_BATCH_SIZE`                   | `20`                                 | API        | Maximum number of submissions allowed in a single batch request                 |
| `MAX_CONCURRENT_WAIT_REQUESTS`     | `concurrency * 25`                   | API        | Maximum simultaneous HTTP requests holding long-poll connections (`?wait=true`) |
| `MAX_CPU_TIME_LIMIT`               | `15`                                 | Sandbox    | Upper ceiling for client-requested CPU time limit (seconds)                     |
| `MAX_DB_QUEUE_DEPTH`               | `concurrency * 5`                    | API        | BullMQ backlog limit for database queue (DB throughput x tolerated wait) before returning HTTP 503 |
| `MAX_MEMORY_LIMIT`                 | `512000`                             | Sandbox    | Upper ceiling for client-requested RAM limit in kilobytes (512 MB)              |
| `MAX_PROCESSES`                    | `60`                                 | Sandbox    | Process / thread ceiling per submission inside Isolate                          |
| `MAX_QUEUE_DEPTH`                  | `concurrency * 25`                   | API        | BullMQ backlog limit for code queue (submissions) before returning HTTP 503 backpressure |
| `MAX_SOURCE_SIZE`                  | `65536`                              | Sandbox    | Maximum source code string size in bytes (64 KB)                                |
| `MAX_WALL_TIME_LIMIT`              | `30`                                 | Sandbox    | Upper ceiling for client-requested wall-clock time limit (seconds)              |
| `MONGODB_POOL_SIZE`                | `WORKER_CONCURRENCY`                 | Worker     | Target idle warm container depth for MongoDB 8.0 database (when ENABLE_MONGODB=true) |
| `MYSQL_POOL_SIZE`                  | `2`                                  | Worker     | Target idle warm container depth for MySQL 8.4 database                         |
| `NODE_ENV`                         | `development`                        | All        | Node.js environment mode (`production` or `development`)                        |
| `NODE_EXPORTER_PIDS_LIMIT`         | `50`                                 | Compose    | Process count ceiling for node-exporter container                               |
| `POOL_ACQUIRE_TIMEOUT_MS`          | `10000`                              | Worker     | Milliseconds to wait for a warm container before timing out                     |
| `POOL_MAX_WAITERS`                 | `16`                                 | Worker     | Maximum queued requests waiting for a warm container                            |
| `PORT`                             | `3000`                               | API        | TCP listen port for the Express application                                     |
| `POSTGRES_POOL_SIZE`               | `2`                                  | Worker     | Target idle warm container depth for PostgreSQL 16 database                     |
| `PROMETHEUS_CPUS`                  | `0.5`                                | Compose    | CPU allocation ceiling for Prometheus container                                 |
| `PROMETHEUS_MEMORY`                | `512M`                               | Compose    | Memory limit for Prometheus container                                           |
| `PROMETHEUS_PIDS_LIMIT`            | `100`                                | Compose    | Process count ceiling for Prometheus container                                  |
| `PROMETHEUS_RETENTION`             | `15d`                                | Compose    | Time duration metrics are retained on disk by Prometheus                        |
| `RATE_LIMIT_MAX_REQUESTS`          | `100`                                | API        | Maximum general API requests allowed per client IP within rate limit window     |
| `RATE_LIMIT_SUBMISSIONS_MAX`       | `120`                                | API        | Maximum submissions allowed per client IP within submissions window             |
| `RATE_LIMIT_SUBMISSIONS_WINDOW_MS` | `60000`                              | API        | Duration (milliseconds) of submissions rate limiting window (1 minute)          |
| `RATE_LIMIT_WINDOW_MS`             | `60000`                              | API        | Duration (milliseconds) of general rate limiting window (1 minute)              |
| `REDIS_CPUS`                       | `1.0`                                | Compose    | CPU ceiling for Redis container                                                 |
| `REDIS_EXPORTER_PIDS_LIMIT`        | `50`                                 | Compose    | Process count ceiling for redis-exporter container                              |
| `REDIS_MAXMEMORY`                  | `256mb`                              | Compose    | Memory ceiling for Redis before rejecting writes with noeviction                |
| `REDIS_MEMORY`                     | `512M`                               | Compose    | Docker cgroup memory limit for Redis container                                  |
| `REDIS_PIDS_LIMIT`                 | `100`                                | Compose    | Maximum process count for Redis container                                       |
| `REDIS_URL`                        | `redis://localhost:6379`             | API/Worker | Redis connection URL for BullMQ queues                                          |
| `RESULT_CACHE_TTL`                 | `3600`                               | API        | Duration (seconds) execution results remain cached in Redis                     |
| `RETRY_AFTER_SECONDS`              | `5`                                  | API        | Header value returned to clients when HTTP 503 backpressure triggers            |
| `TRUST_PROXY`                      | `1`                                  | API        | Enables Express `trust proxy` to read `X-Forwarded-For` from reverse proxy      |
| `WARM_POOL_MAX_CONCURRENT_BOOTS`   | `3`                                  | Worker     | Maximum simultaneous Docker container boots allowed across warm pools           |
| `WORKER_CONCURRENCY`               | `4`                                  | Worker     | Number of simultaneous jobs processed by the code execution worker              |
| `WORKER_CPUS`                      | `2.0`                                | Compose    | CPU ceiling for code execution worker container                                 |
| `WORKER_DB_CONCURRENCY`            | `2`                                  | Worker     | Number of simultaneous jobs processed by the database worker                    |
| `WORKER_DB_CPUS`                   | `2.0`                                | Compose    | CPU ceiling for database worker container                                       |
| `WORKER_DB_MEMORY`                 | `2048M`                              | Compose    | Memory ceiling for database worker container                                    |
| `WORKER_DB_PIDS_LIMIT`             | `300`                                | Compose    | Process ceiling for database worker container                                   |
| `WORKER_MEMORY`                    | `1024M`                              | Compose    | Memory ceiling for code execution worker container                              |
| `WORKER_METRICS_PORT`              | `null`                               | Worker     | Dedicated port for worker Prometheus metrics if separate from API               |
| `WORKER_PIDS_LIMIT`                | `300`                                | Compose    | Process ceiling for code execution worker container                             |
| `WORKER_TYPE`                      | `all`                                | Worker     | Worker role: `all` (handles both), `isolate`, or `docker`                       |
