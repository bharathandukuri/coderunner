# CoderRunner

CoderRunner is a high-performance, secure code and database execution engine designed for online judges, assessment platforms, and educational sandboxes. It runs untrusted source code and database queries within strict memory, CPU, and network boundaries, leveraging Linux Isolate sandboxes for zero-overhead code execution and pre-warmed Docker containers for instant database transactions.

## Supported Engines
- **Programming Languages**: C, C++, Java, Python (3.8+), JavaScript (Node.js), TypeScript.
- **Relational Databases**: PostgreSQL (16), MySQL (8.4), SQLite (3).
- **Document Databases**: MongoDB (8.0).

> [!IMPORTANT]
> **Database Throughput & Scaling**: Database submissions are fundamentally limited to approximately **1 to 2 requests per second per node** (empirically measured for PostgreSQL 16 and MySQL 8.4; MongoDB 8.0 is not measured) regardless of host vCPU count. Because every database execution is fully sandboxed and consumes an isolated, ephemeral container boot, Docker daemon container lifecycles serialize container creation and destruction. The recommended architectural pattern for scaling database throughput is **horizontal worker scaling by adding `worker-db` nodes** (see [Capacity & Limits Reference](docs/limits.md)). In contrast, native code submissions run via Linux Isolate and scale linearly with vCPUs (sustaining ≥ 70 req/s on 8 vCPUs with ~20 ms latency).

## Architecture

```
HTTP Request (POST /submissions?wait=true)
     │
     ▼
┌───────────┐         ┌───────────┐         ┌─────────────────────────┐
│ Express   │ ──────> │   Redis   │ ──────> │ Worker Process          │
│ API       │ <────── │  (BullMQ) │         │ (concurrency=N)         │
└───────────┘ Pub/Sub └───────────┘         └────────────┬────────────┘
     ▲                                                   │
     │                                     ┌─────────────┴─────────────┐
     │                                     ▼                           ▼
     │                             ┌───────────────┐           ┌───────────────┐
     │                             │ Linux Isolate │           │ Pre-Warmed    │
     │                             │ (Native Code) │           │ Docker Pool   │
     │                             └───────┬───────┘           │ (Postgres/DB) │
     │                                     │                   └───────┬───────┘
     └─────────────────────────────────────┴───────────────────────────┘
                                Execution Result
```

## Quick Start

```bash
cp .env.example .env
npm install
docker compose up -d redis
npm run worker &
npm start
```

Submit code:
```bash
curl -X POST http://localhost:3000/submissions?wait=true \
  -H "Content-Type: application/json" \
  -d '{"language_id": 71, "source_code": "print(sum(range(100)))"}'
```

## Language & Pool Configuration

Control which languages are enabled and whether warm container pools are maintained via `.env`:

```bash
# Enable or disable specific languages (default true, except mongodb=false)
LANGUAGE_PYTHON_ENABLED=true
LANGUAGE_MONGODB_ENABLED=true

# Warm container pooling (default true for databases, false for code languages)
# Turning database pools off saves idle RAM (~280MB for MySQL) at the cost of container boot latency (~1.4s)
LANGUAGE_MYSQL_POOL=false
LANGUAGE_POSTGRESQL_POOL=true
LANGUAGE_PYTHON_POOL=false
```

## Documentation

- [Local Development Guide](docs/local.md): Local prerequisites, running with Isolate vs Docker, enabling language pools, and running unit tests.
- [Production Deployment Guide](docs/production.md): Automated server deployment with `scripts/deploy.sh`, Caddy TLS setup, secret rotation, Prometheus/Grafana monitoring, and alert runbooks.
- [Capacity & Limits Reference](docs/limits.md): Authoritative workload definitions, pass criteria, sizing formulas, VM capacity tiers, overload behavior, and environment variable reference.
