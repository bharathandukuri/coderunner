# MongoDB 8.0 Empirical Footprint & Benchmark

This directory contains empirical footprint measurements for MongoDB 8.0 LTS (`mongo:8.0`) under CodeRunner container sandbox hardening constraints (`--wiredTigerCacheSizeGB 0.25`, `512MB RAM`, `64 pids`, read-only rootfs, tmpfs storage).

## Environment Block
- **Date**: 2026-11-01
- **Host CPU**: 12th Gen Intel(R) Core(TM) i5-12500H
- **Kernel**: Linux 7.2.13-200.fc44.x86_64
- **OS**: Fedora Linux 44 (Workstation Edition)
- **Docker Engine**: 29.9.2 (build a82e528)
- **Engine Image**: `mongo:8.0` (Image ID `d0d926f94df0`)

## Summary Results

| Metric | Measured Value | Notes |
|---|---|---|
| **Image Size** | **1,280,327,584 bytes** (~1.28 GB) | Uncompressed disk size; 321 MB compressed content size |
| **Boot Time (P50)** | **1,568.50 ms** (~1.57 s) | 10 samples (Min: 1503.06 ms, Max: 1600.72 ms) |
| **Boot Time (Max)** | **1,600.72 ms** (~1.60 s) | Ephemeral container boot to `/box/.ready` signal |
| **Idle RAM** | **90.21 MiB** | Steady-state standby with mongod running |
| **Trivial Query RAM** | **91.70 MiB** | `db.stats()` query executed via mongosh |
| **Active Load RAM (10k docs)** | **96.29 MiB** | 10,000 JSON documents inserted into collection (~97 MiB, idle plus light load) |

## Slim Image Comparison (`mongo:8.0` vs `coderunner/mongodb:8.0`)

| Metric | Official `mongo:8.0` | Slim `coderunner/mongodb:8.0` | Improvement / Impact |
|---|---|---|---|
| **Base Image** | Debian 12 (bookworm) | Ubuntu 24.04 (glibc 2.39 pinned) | Clean LTS base, non-root runner (1001) |
| **Image Size** | 1,280 MB (1.28 GB) | 694 MB | **45.8% smaller** (exceeds 30% reduction requirement) |
| **Boot Time (Min)** | 1,503 ms | 554 ms | Ephemeral container boot to `/box/.ready` |
| **Boot Time (P50)** | 1,569 ms | 696 ms | **55.6% faster** boot latency |
| **Boot Time (Max)** | 1,601 ms | 4,408 ms | Jitter on high concurrency, p50 ~696 ms |
| **Idle Memory (mongod RSS)** | ~90 MiB | ~80 MiB | Steady-state mongod process memory |
| **Idle Memory (docker stats cgroup)** | ~280 MiB | ~280 MiB | Includes 200 MB WiredTiger pre-allocated journal files on `/data/db` tmpfs |

## Constants & Formulas
Based on the measured idle baseline of **90.21 MiB** and container memory cap of **512 MB**, the memory sizing formula in `docs/limits.md` and `scripts/preflight.sh` allocates:
- $\text{RAM}_{\text{pool},\text{mongo}} = 90\text{ MiB}$ per idle warm pool container
- $\text{RAM}_{\text{job},\text{mongo}} = 512\text{ MiB}$ per concurrent database worker slot
$$\text{RAM}_{\text{mongo}} = (\text{PoolSize}_{\text{mongo}} \times 90\text{ MiB}) + (\text{Workers}_{\text{db}} \times \text{Concurrency}_{\text{db}} \times 512\text{ MiB})$$
