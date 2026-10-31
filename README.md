# CodeRunner

A high-performance, hardened sandboxed code and database execution engine built with Node.js, Express, Docker, and Linux sandboxing (Isolate / cgroups v2).

CodeRunner is designed strictly as a **pure execution engine**—it compiles and executes untrusted code and queries inside hardened sandboxes with strict resource limits (CPU, memory, wall time, PIDs, network disabled), returning clean execution telemetry (`stdout`, `stderr`, duration, peak memory, and exit codes) without forced grading or test-case coupling.

---

## Key Features

- **Pure Execution Focus**: Decouples code execution from test-case grading. Executes untrusted code and returns raw outputs and process metrics.
- **Relational Database Execution**:
  - **PostgreSQL 16 (`id: 8`)** and **MySQL 8.4 LTS (`id: 9`)**: Evaluated via in-memory ephemeral warm pools delivering **~200ms warm hits**.
  - **Protocol-Level In-Container Runner**: Bypasses CLI shell vulnerabilities (`\!`, `\c`, `system`, `COPY ... PROGRAM`) using direct wire-protocol execution (`pg` and `mysql2`).
  - **MySQL `DELIMITER` Support**: Built-in client-side statement splitting supporting stored procedures, triggers, and functions (`//`, `$$`).
  - **Uniform Output Contract**: Consistent tabular formatting, preserving duplicate column names, explicit `NULL` rendering, and strict byte-capped output truncation.
- **SQLite 3 (`id: 7`)**: Ephemeral file-based database evaluation inside sandbox `tmpfs`.
- **Standard Programming Languages**:
  - Single-file (`POST /submissions`) and native multi-file JSON orchestration (`POST /submissions/multi`).
  - Batch execution for up to 20 submissions per request.
- **Hardened Sandboxing**:
  - Drops all Linux capabilities (`CapDrop: ALL`), enforces `no-new-privileges`.
  - Read-only root filesystem with isolated in-memory `tmpfs` mounts for `/box` and `/tmp`.
  - Strict resource limits: CPU quotas, memory caps with swap disabled, and PID limits.
  - Full network isolation (`NetworkDisabled: true`, `NetworkMode: 'none'`).
  - **Docker Socket Proxy Security Boundary**: Docker socket proxy restricts the worker's API surface (read-only for unneeded endpoints, no volumes/swarm/nodes/secrets); defense-in-depth within the host, not a tenant-isolation boundary. Multi-tenant isolation requires separate host VMs.
- **Production Architecture**:
  - Dual BullMQ job queues: `submissions` for isolate code workers, and `submissions-db` for dedicated database workers (`worker-db`).
  - Dynamic instance heartbeats in Redis with safe orphan sweeping (skips prune if Redis is down).
  - Out-of-the-box Prometheus metrics (`/metrics`) and alert rules (`alertrules.yml`).

---

## System Architecture

```
┌────────────────┐      ┌────────────────┐      ┌─────────────────────────────┐
│  API Clients   │─────▶│ CodeRunner API │─────▶│    BullMQ / Redis Queues    │
│  (Frontend/IDE)│      │  (Port 3000)   │      │                             │
└────────────────┘      └────────────────┘      └──────────────┬──────────────┘
                                                               │
                         ┌─────────────────────────────────────┴─────────────────────────────────────┐
                         │                                                                           │
                  [submissions]                                                               [submissions-db]
                         ▼                                                                           ▼
           ┌───────────────────────────┐                                               ┌───────────────────────────┐
           │   worker (Code Sandbox)   │                                               │    worker-db (Databases)  │
           │ (Isolate / cgroups v2 /   │                                               │ (Ephemeral Warm Daemon    │
           │  Unprivileged Docker)     │                                               │  Pool: Postgres & MySQL)  │
           └─────────────┬─────────────┘                                               └─────────────┬─────────────┘
                         ▼                                                                           ▼
           ┌───────────────────────────┐                                               ┌───────────────────────────┐
           │  Languages 1–7 Execution  │                                               │  Languages 8–9 Execution  │
           │  (C, C++, Java, JS, Py)   │                                               │  (Protocol Wire Runner)   │
           └───────────────────────────┘                                               └───────────────────────────┘
```

---

## Supported Languages & Engines

| ID | Language / Engine | Version | Execution Mode | Standard Invocation |
|:---:|---|---|---|---|
| **1** | C | GCC 9.4.0 | Sandbox Container / Isolate | `gcc -O2 -std=c11 -o main *.c` |
| **2** | C++ | GCC 9.4.0 | Sandbox Container / Isolate | `g++ -O2 -std=c++17 -o main *.cpp` |
| **3** | Java | OpenJDK 17 | Sandbox Container / Isolate | `javac -cp . Main.java && java Main` |
| **4** | JavaScript | Node.js 18.15 | Sandbox Container / Isolate | `node main.js` |
| **5** | Python | Python 3.8.10 | Sandbox Container / Isolate | `python3 main.py` |
| **6** | TypeScript | TypeScript 5.0 | Sandbox Container / Isolate | `tsc main.ts && node main.js` |
| **7** | SQLite 3 | SQLite 3.37 | Sandbox Container / Isolate | `sqlite3 -header -column /box/db.sqlite` |
| **8** | PostgreSQL | PostgreSQL 16 | Ephemeral Warm Daemon Pool | `/usr/local/bin/runner.js` (Unix socket) |
| **9** | MySQL | MySQL 8.4 LTS | Ephemeral Warm Daemon Pool | `/usr/local/bin/runner.js` (Unix socket) |

---

## Quick Start (Local Development)

### Prerequisites
- Docker & Docker Compose
- Node.js 20+

### Setup & Run

1. **Clone the repository**:
   ```bash
   git clone https://github.com/bharathandukuri/coderunner.git
   cd coderunner
   npm install
   ```

2. **Build runner images**:
   ```bash
   ./scripts/build-images.sh
   ```

3. **Start the stack** (API, Worker, Redis):
   ```bash
   docker compose up -d
   ```

4. **Verify Health**:
   ```bash
   curl http://localhost:3000/health
   ```

---

## API Usage Examples

Default development authentication token: `dev-token` (header: `X-Auth-Token: dev-token`).

### 1. Python Code Execution
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 5,
    "source_code": "import sys\nprint(f\"Hello, {sys.stdin.read().strip()}!\")",
    "stdin": "CodeRunner"
  }'
```

### 2. PostgreSQL 16 Execution
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 8,
    "source_code": "CREATE TABLE users (id INT, name TEXT);\nINSERT INTO users VALUES (1, '\''Alice'\''), (2, '\''Bob'\'');\nSELECT * FROM users ORDER BY id;"
  }'
```

### 3. MySQL 8.4 Execution with Stored Procedure & DELIMITER
```bash
curl -X POST "http://localhost:3000/submissions?wait=true" \
  -H "Content-Type: application/json" \
  -H "X-Auth-Token: dev-token" \
  -d '{
    "language_id": 9,
    "source_code": "DELIMITER //\nCREATE PROCEDURE Multiply(IN a INT, IN b INT, OUT res INT)\nBEGIN\n  SET res = a * b;\nEND //\nDELIMITER ;\nCALL Multiply(6, 7, @out);\nSELECT @out AS answer;"
  }'
```

---

## Documentation

- [Runner Output Contract & Specification](docs/output-contract.md)
- [Capacity Planning & Resource Sizing Guide](docs/capacity.md)
- [API Endpoints & URL Reference](docs/URLS.md)
- [Product Requirements & Architecture Details](docs/prd.md)

---

## Status Codes

| ID | Status Description | Notes |
|:---:|---|---|
| **1** | In Queue | Waiting in BullMQ queue |
| **2** | Processing | Actively executing inside sandbox |
| **3** | Accepted | Process finished cleanly (exit code 0) |
| **5** | Time Limit Exceeded | Exceeded CPU or wall time limit (exit code 124) |
| **6** | Compilation Error | Compilation failed (see `compile_output`) |
| **7** | Runtime Error (SIGSEGV) | Segmentation fault |
| **8** | Runtime Error (SIGXFSZ) | File size limit exceeded |
| **9** | Runtime Error (SIGFPE) | Arithmetic exception / division by zero |
| **10** | Runtime Error (SIGABRT) | Process aborted |
| **11** | Runtime Error (NZEC) | Non-zero exit code |
| **13** | Internal Error | Infrastructure, pool timeout, or circuit breaker trip |

---

## Acknowledgements & Credits

CodeRunner was developed by [Bharath Andukuri](https://github.com/bharathandukuri). 

Special thanks and acknowledgement to [Hitesh Choudhary / Chai aur Code](https://github.com/hiteshchoudhary) for early concepts in remote code execution sandboxes that inspired this work.

---

## License

MIT License. See [LICENSE](LICENSE) for details.
