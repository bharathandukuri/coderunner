# Product Requirements Document: CodeRunner

## Executive Summary

CodeRunner is an asynchronous, high-performance sandboxed code and database execution engine built on Node.js/Express, Redis/BullMQ, Docker, and Linux cgroup sandboxes (Isolate). It provides pure execution semantics—compiling, running, and isolating untrusted code and queries, and returning execution telemetry (`stdout`, `stderr`, duration, memory, and exit codes) without embedded grading side-effects.

> Credits: Based on foundational concepts by Chai aur Code / Hitesh Choudhary, customized and rewritten for pure code and database execution with ephemeral warm pools and native multi-file orchestration.

---

## Product Vision

Deliver a secure, low-latency code execution engine capable of executing arbitrary untrusted code across major programming languages with strong sandboxing guarantees, supporting both single-file executions and multi-file projects.

---

## Core Capabilities

### 1. Pure Execution Model
- Accepts source code, standard input (`stdin`), and resource limits.
- Executes code inside a restricted sandbox environment.
- Returns process execution results (`stdout`, `stderr`, `time`, `wall_time`, `memory`, `exit_code`, `status`).
- Does not compare outputs or assign grading judgments like "Wrong Answer"—evaluation belongs in client/consumer applications.

### 2. Multi-File Project Orchestration (`POST /submissions/multi`)
- Accepts a collection of files in structured JSON (`path`, `content`).
- Compiles the project once inside a single dedicated sandbox environment.
- Preserves relative subdirectories (`models/User.java`, `src/app.py`).
- Sequentially executes multiple entry points against the same compiled environment.
- Implements fail-fast isolation: if an execution crashes or times out, the container is terminated immediately.

### 3. Hardened Sandboxing
- Multi-engine support: **Docker** container sandboxing and **Isolate** Linux cgroups namespaces.
- Enforces `ReadonlyRootfs`, dropped Linux capabilities (`CapDrop: ALL`), and `no-new-privileges`.
- Memory isolation with swap disabled, CPU quota limits, and PID execution bounds.
- Path traversal defense preventing writes outside the working `/box` directory.
- **Security Boundary**: Docker socket proxy restricts the worker's API surface (read-only for unneeded endpoints, no volumes/swarm/nodes/secrets); defense-in-depth within the host, not a tenant-isolation boundary. Multi-tenant isolation requires separate host VMs.

### 4. Language Support
- Clean sequential language identifiers:
  - `1`: C (GCC 9.4.0)
  - `2`: C++ (GCC 9.4.0)
  - `3`: Java (OpenJDK 17)
  - `4`: JavaScript (Node.js 18.15.0)
  - `5`: Python (3.8.10)
  - `6`: TypeScript (5.0.3)
  - `7`: SQL (SQLite 3)

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/health` | Health check endpoint |
| `GET` | `/languages` | List all supported languages |
| `GET` | `/statuses` | List all execution status codes |
| `POST` | `/submissions` | Execute a single-file code submission |
| `POST` | `/submissions/batch` | Batch submit single-file executions (up to 20) |
| `POST` | `/submissions/multi` | Execute a multi-file project with multiple entry points |
| `POST` | `/submissions/multi/batch` | Batch submit multi-file projects (up to 20) |
| `GET` | `/submissions/:token` | Retrieve status and outputs for any submission |
| `GET` | `/submissions/batch` | Retrieve status and outputs for multiple tokens |
| `DELETE` | `/submissions/:token` | Delete a submission from the cache |
| `GET` | `/metrics` | Prometheus observability metrics |

---

## Execution Status Codes

- `1`: In Queue
- `2`: Processing
- `3`: Accepted (Process exited with code 0)
- `5`: Time Limit Exceeded (CPU or wall-clock timeout)
- `6`: Compilation Error
- `7`: Runtime Error (SIGSEGV)
- `8`: Runtime Error (SIGXFSZ)
- `9`: Runtime Error (SIGFPE)
- `10`: Runtime Error (SIGABRT)
- `11`: Runtime Error (NZEC - Non-zero exit code)
- `13`: Internal Error

---

## Security & Sandbox Boundaries

### 1. Isolate Worker
- Runs with `privileged: true` and `cgroup: host` by design to manage cgroups v2 resource controllers (`cpu`, `memory`, `pids`).
- Each user execution runs inside a disposable ephemeral directory sandbox (`/var/local/lib/isolate/<id>`) managed by the `isolate` binary.
- When running in containers, `isolate` is baked into `docker/worker/Dockerfile`.
- When running directly on bare-metal or VMs, `scripts/install-isolate.sh` installs the binary and systemd service onto the host system.

### 2. Docker & Database Worker (`worker-db`)
- Runs database submissions (`submissions-db`) using warm ephemeral containers (`coderunner/postgres:16`, `coderunner/mysql:8.4`).
- Communicates with Docker via `docker-socket-proxy` (`v0.5.0`) over an internal network (`docker-socket-net`, `internal: true`).
- **Proxy Boundary Note:** The proxy is a defense-in-depth barrier blocking non-container endpoints (`/volumes`, `/networks`, `/secrets`). It is not a strict multi-tenant boundary because it filters by HTTP endpoint, not request body. Strict multi-tenancy requires dedicated execution nodes.
- **gVisor (`runsc`)**: Can be installed on the host via `scripts/install-gvisor.sh`. When `DOCKER_RUNTIME=runsc` is set in `.env`, user code inside Docker containers is evaluated by an emulated user-space kernel.

