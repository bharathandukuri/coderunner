# Local Development Guide

This guide covers running and developing CoderRunner on a local machine.

## Requirements

- **Linux** (kernel 5.4+ with cgroups v2 recommended) or macOS / WSL2 for Docker-only execution.
- **Node.js**: v20+ (`node -v`).
- **Redis**: v7+ (standalone or via Docker).
- **Docker**: Engine 24+ with Compose v2 (if running Docker executor or database warm pools).
- **Isolate** (optional, recommended for Linux development): v1.10+ installed via `scripts/install-isolate.sh`.

## Installation

1. Clone repository and install dependencies:
   ```bash
   git clone https://github.com/your-org/coderunner.git
   cd coderunner
   npm install
   ```

2. Initialize local environment file:
   ```bash
   cp .env.example .env
   ```

## Local Environment Variables

Only a minimal set of environment variables are required for local development:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port for the Express API server |
| `NODE_ENV` | `development` | Application mode (`development` enables detailed debug logging) |
| `REDIS_URL` | `redis://localhost:6379` | Connection string for BullMQ submission queues |
| `WORKER_TYPE` | `all` | Worker execution target: `all`, `isolate`, or `docker` |
| `WORKER_CONCURRENCY` | `4` | Number of simultaneous submissions processed by the worker |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Local Docker daemon control socket path |
| `ENABLE_LANGUAGE_POOL` | `false` | Enable pre-warmed containers for standard programming languages |
| `POSTGRES_POOL_SIZE` | `1` | Target idle warm container depth for PostgreSQL 16 |
| `MYSQL_POOL_SIZE` | `1` | Target idle warm container depth for MySQL 8.4 |

## Starting & Stopping Services

### 1. Start Redis
```bash
# Start local Redis container
docker run -d --name coderunner-redis -p 6379:6379 redis:7-alpine

# Verify Redis is responsive
redis-cli ping
```

### 2. Start the Worker
In a dedicated terminal:
```bash
npm run worker
```

### 3. Start the API Server
In a second terminal:
```bash
npm start
```
Or with auto-restart on file changes:
```bash
npm run dev
```

### 4. Stop Services
```bash
# Press Ctrl+C in worker and API terminal windows
# Stop Redis
docker stop coderunner-redis && docker rm coderunner-redis
```

## Running Tests

Execute the mocked unit test suite:
```bash
node --test tests/pool.test.js tests/executor.test.js tests/splitters.test.js
```

Validate markdown links and documentation consistency:
```bash
bash scripts/dev/check-docs.sh
```

Execute integration tests (requires running Redis, worker, and API):
```bash
node --test tests/api.test.js
```

## Running with Isolate vs Docker Executor

CoderRunner supports two sandbox backends for programming languages:

### 1. Isolate Sandbox (Native Linux)
Isolate runs processes in Linux namespaces and cgroups directly on the host without container startup overhead.
- **Setup**: Run `sudo bash scripts/install-isolate.sh`.
- **Usage**: Set `WORKER_TYPE=isolate` in `.env`.
- **Latency**: Median execution dispatch takes ~50–90 ms.

### 2. Docker Executor (Containers)
Docker isolates code execution inside short-lived or pooled containers using container runtimes (such as `runc` or `runsc`/gVisor).
- **Setup**: Ensure the Docker daemon is running and the multi-language runner image is built:
  ```bash
  bash scripts/build-images.sh multi
  ```
- **Usage**: Set `WORKER_TYPE=docker` in `.env`.

## Warm Container Pools for Languages

By default, database engines (PostgreSQL and MySQL) always use warm pools, while standard languages (Python, Java, C++) execute cold or via Isolate.

To enable warm container pooling for standard languages:
1. In `.env`, set:
   ```bash
   ENABLE_LANGUAGE_POOL=true
   ```
2. Build the database and language runner images:
   ```bash
   bash scripts/build-images.sh all
   ```
3. Restart the worker.

### When to Enable Language Warm Pools
- **High Concurrency Container Environments**: When running in Docker-only environments without Isolate and user submissions demand sub-second container response times.
- **When NOT to Enable**: On resource-constrained development machines or when Isolate is available. Each warm language container reserves RAM even when idle.

## Troubleshooting

### Docker Socket Permission Denied
- **Symptom**: `connect EACCES /var/run/docker.sock` in worker logs.
- **Fix**: Add your local user account to the `docker` system group:
  ```bash
  sudo usermod -aG docker $USER
  newgrp docker
  ```

### Redis Connection Refused
- **Symptom**: `[ioredis] UnhandledError: connect ECONNREFUSED 127.0.0.1:6379`.
- **Fix**: Confirm Redis is running on port 6379:
  ```bash
  docker ps -f name=coderunner-redis
  # Or start via docker compose
  docker compose up -d redis
  ```

### Isolate Permission Errors
- **Symptom**: `isolate: cannot open control cgroup`.
- **Fix**: Run `sudo isolate --init` or ensure Isolate is installed with setuid root permissions:
  ```bash
  sudo chown root:root /usr/local/bin/isolate
  sudo chmod 4755 /usr/local/bin/isolate
  ```
