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
| **Active Load RAM (10k docs)** | **96.29 MiB** | 10,000 JSON documents inserted into collection |

## Constants & Formulas
Based on the peak working RAM of **96.29 MiB**, the memory sizing formula in `docs/limits.md` and `scripts/preflight.sh` allocates:
$$\text{RAM}_{\text{pool},\text{mongo}} = 97\text{ MiB per container}$$
