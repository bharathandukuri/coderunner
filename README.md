# CoderRunner

CoderRunner is a high-performance, secure code and database execution engine designed for online judges, assessment platforms, and educational sandboxes. It runs untrusted source code and database queries within strict memory, CPU, and network boundaries, leveraging Linux Isolate sandboxes for zero-overhead code execution and pre-warmed Docker containers for instant database transactions.

## Supported Engines
- **Programming Languages**: C, C++, Java, Python (3.8+), JavaScript (Node.js), TypeScript.
- **Relational Databases**: PostgreSQL (16), MySQL (8.4), SQLite (3).

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

## Documentation

- [Local Development Guide](docs/local.md): Local prerequisites, running with Isolate vs Docker, enabling language pools, and running unit tests.
- [Production Deployment Guide](docs/production.md): Automated server deployment with `scripts/deploy.sh`, Caddy TLS setup, secret rotation, Prometheus/Grafana monitoring, and alert runbooks.
- [Capacity & Limits Reference](docs/limits.md): Authoritative workload definitions, pass criteria, sizing formulas, VM capacity tiers, overload behavior, and environment variable reference.
