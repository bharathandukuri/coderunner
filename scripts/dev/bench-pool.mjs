#!/usr/bin/env node
/**
 * scripts/dev/bench-pool.mjs - Benchmarks cold vs warm container pool acquisition and execution
 */

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`
Usage: node scripts/dev/bench-pool.mjs [options]

Benchmarks container acquisition and cold vs warm execution timings across supported runtimes.
Environment variables:
  BENCH_ITERATIONS     Number of iterations to run (default: 5)
  API_URL              API base URL for e2e tests (default: http://localhost:3000)
  AUTH_TOKEN           Auth token for API requests (default: dev-token)
  DOCKER_SOCKET        Path to Docker socket (default: /var/run/docker.sock)
`);
  process.exit(0);
}

import Docker from 'dockerode';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { WarmContainerPool } from '../../src/executor/pool/WarmContainerPool.js';
import { getLanguageById } from '../../src/languages/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || (!process.env.DOCKER_HOST ? '/var/run/docker.sock' : undefined),
  host: process.env.DOCKER_HOST,
});

const BASE_URL = process.env.API_URL || 'http://localhost:3000';
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'dev-token';
const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS, 10) || 5;

const mockRedis = {
  set: async () => 'OK',
  get: async () => null,
  exists: async () => 1,
  del: async () => 1,
  ping: async () => 'PONG',
  quit: async () => 'OK',
};

const benchPool = new WarmContainerPool(docker, {
  redis: mockRedis,
  concurrency: 1,
  enableLanguagePool: true,
});

function percentile(arr, p) {
  if (!arr || arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function statsSummary(arr) {
  if (!arr || arr.length === 0) return { p50: 'N/A', p95: 'N/A', p99: 'N/A', min: 'N/A', max: 'N/A', avg: 'N/A' };
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    p50: percentile(arr, 50),
    p95: percentile(arr, 95),
    p99: percentile(arr, 99),
    min: Math.min(...arr),
    max: Math.max(...arr),
    avg: Math.round(sum / arr.length),
  };
}

async function measureBootTime(langId) {
  const start = Date.now();
  const container = await benchPool.createAndBoot(langId);
  const duration = Date.now() - start;
  return { duration, container };
}

async function getContainerMemory(container) {
  const stats = await container.stats({ stream: false });
  const usage = stats.memory_stats?.usage || 0;
  const cache = stats.memory_stats?.stats?.cache || stats.memory_stats?.stats?.inactive_file || 0;
  const netUsage = Math.max(0, usage - cache);
  return {
    rawUsageBytes: usage,
    netUsageBytes: netUsage,
    usageMB: (usage / (1024 * 1024)).toFixed(2),
    netUsageMB: (netUsage / (1024 * 1024)).toFixed(2),
  };
}

async function getCgroupMemoryPeak(container) {
  try {
    const exec = await container.exec({
      Cmd: ['cat', '/sys/fs/cgroup/memory.peak'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ Detach: false });
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    await new Promise(r => stream.on('end', r));
    const clean = output.trim().replace(/[^0-9]/g, '');
    const bytes = parseInt(clean, 10);
    if (!isNaN(bytes) && bytes > 0) {
      return bytes;
    }
  } catch {}
  return 0;
}

async function getEnvironment(dockerInstance) {
  let gitCommit = 'unknown';
  try {
    gitCommit = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {}

  let dockerVersion = 'unknown';
  let storageDriver = 'unknown';
  try {
    const v = await dockerInstance.version();
    dockerVersion = v.Version || 'unknown';
    const info = await dockerInstance.info();
    storageDriver = info.Driver || 'unknown';
  } catch {}

  const cpus = os.cpus();
  const cpuModel = cpus && cpus.length > 0 ? cpus[0].model : 'unknown';
  const cpuCores = cpus ? cpus.length : 0;
  const totalRamGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  const kernelVersion = os.release();

  return {
    cpuModel,
    cpuCores,
    totalRam: totalRamGB,
    kernelVersion,
    dockerVersion,
    storageDriver,
    gitCommit,
    date: new Date().toISOString(),
  };
}

async function getTmpfsUsage(container) {
  try {
    const exec = await container.exec({
      Cmd: ['df', '-k', '/box'],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ Detach: false });
    let output = '';
    stream.on('data', chunk => { output += chunk.toString(); });
    await new Promise(r => stream.on('end', r));
    const lines = output.trim().split('\n');
    if (lines.length > 1) {
      const parts = lines[1].trim().split(/\s+/);
      const usedKB = parseInt(parts[2], 10) || 0;
      return `${(usedKB / 1024).toFixed(2)} MB`;
    }
  } catch {
    // fallback
  }
  return 'N/A';
}

async function sendApiSubmission(langId, sourceCode, options = {}) {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN,
    },
    body: JSON.stringify({
      language_id: langId,
      source_code: sourceCode,
      ...options,
    }),
  });
  const duration = Date.now() - start;
  let data = null;
  try {
    data = await res.json();
  } catch {}

  let serverDuration = null;
  if (data?.created_at && data?.finished_at) {
    const s = new Date(data.created_at).getTime();
    const f = new Date(data.finished_at).getTime();
    if (!isNaN(s) && !isNaN(f) && f >= s) {
      serverDuration = f - s;
    }
  }

  return {
    duration,
    serverDuration,
    ok: res.ok && data?.status?.id === 3,
    statusId: data?.status?.id,
    stdout: data?.stdout || '',
    stderr: data?.stderr || '',
  };
}

async function main() {
  console.log(`Starting CodeRunner Pool Benchmark (${ITERATIONS} iterations)...`);
  const env = await getEnvironment(docker);
  const report = {
    timestamp: new Date().toISOString(),
    environment: env,
    iterations: ITERATIONS,
    boots: {},
    idleRam: {},
    heavyLoad: {},
    apiLatency: {},
  };

  // 1. Boot times
  console.log('\n--- 1. Measuring Boot Times ---');
  for (const [name, id, isDaemon] of [
    ['PostgreSQL (16)', 8, true],
    ['MySQL (8.4)', 9, true],
    ['Python (3.8) Cold', 5, false],
  ]) {
    process.stdout.write(`Measuring ${name}... `);
    const times = [];
    const containersToClean = [];

    for (let i = 0; i < ITERATIONS; i++) {
      try {
        const { duration, container } = await measureBootTime(id);
        times.push(duration);
        if (i === ITERATIONS - 1) {
          const mem = await getContainerMemory(container);
          report.idleRam[name] = `${mem.netUsageMB} MB (net) / ${mem.usageMB} MB (total)`;
        }
        await container.remove({ force: true, v: true }).catch(() => {});
      } catch (err) {
        console.error(`Boot error: ${err.message}`);
      }
    }

    report.boots[name] = statsSummary(times);
    console.log(`p50: ${report.boots[name].p50}ms | p95: ${report.boots[name].p95}ms | p99: ${report.boots[name].p99}ms`);
  }

  // Python warm acquire measurement
  process.stdout.write('Measuring Python (3.8) Warm acquire... ');
  const warmAcquireTimes = [];
  try {
    for (let i = 0; i < ITERATIONS; i++) {
      if (!benchPool.pools[5] || benchPool.pools[5].available.length === 0) {
        await benchPool.replenish(5);
      }
      const t0 = performance.now();
      const container = await benchPool.acquire(5);
      const duration = performance.now() - t0;
      warmAcquireTimes.push(Math.round(duration));
      await benchPool.destroy(container);
    }
    report.boots['Python (3.8) Warm'] = statsSummary(warmAcquireTimes);
    console.log(`p50: ${report.boots['Python (3.8) Warm'].p50}ms | p95: ${report.boots['Python (3.8) Warm'].p95}ms | p99: ${report.boots['Python (3.8) Warm'].p99}ms`);
  } catch (err) {
    console.log(`Failed (${err.message}), setting N/A`);
    report.boots['Python (3.8) Warm'] = { p50: 'N/A', p95: 'N/A', p99: 'N/A', min: 'N/A', max: 'N/A', avg: 'N/A' };
  }

  // 2. Heavy Load: Peak RAM and tmpfs usage
  console.log('\n--- 2. Measuring Heavy Load & Peak Resource Usage ---');

  // PostgreSQL heavy query
  {
    process.stdout.write('Running heavy PostgreSQL query (generate_series 1,000,000)... ');
    const { container } = await measureBootTime(8);
    try {
      const initialMem = await getContainerMemory(container);
      const exec = await container.exec({
        Cmd: ['su-exec', 'runner', 'sh', '-c', 'echo "SELECT count(*) FROM generate_series(1, 1000000);" > /box/bench.sql && node /opt/runner/runner.js /box/bench.sql 15'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ Detach: false });
      stream.resume();

      let peakUsage = initialMem.rawUsageBytes;
      const pollInterval = setInterval(async () => {
        try {
          const stats = await container.stats({ stream: false });
          if (stats.memory_stats?.usage > peakUsage) {
            peakUsage = stats.memory_stats.usage;
          }
        } catch {}
      }, 25);

      await new Promise(r => stream.on('end', r));
      clearInterval(pollInterval);

      const cgroupPeak = await getCgroupMemoryPeak(container);
      const finalMem = await getContainerMemory(container);
      const tmpfs = await getTmpfsUsage(container);
      const effectivePeak = Math.max(cgroupPeak, peakUsage, initialMem.rawUsageBytes, finalMem.rawUsageBytes);

      report.heavyLoad['PostgreSQL'] = {
        peakRamMB: (effectivePeak / (1024 * 1024)).toFixed(2) + ' MB',
        tmpfsUsage: tmpfs,
      };
      console.log(`Peak RAM: ${report.heavyLoad['PostgreSQL'].peakRamMB}, tmpfs: ${tmpfs}`);
    } finally {
      await container.remove({ force: true, v: true }).catch(() => {});
    }
  }

  // MySQL heavy query
  {
    process.stdout.write('Running heavy MySQL query (recursive CTE 500,000 rows)... ');
    const { container } = await measureBootTime(9);
    try {
      const initialMem = await getContainerMemory(container);
      const exec = await container.exec({
        Cmd: ['su-exec', 'runner', 'sh', '-c', 'echo "SET SESSION cte_max_recursion_depth = 600000; WITH RECURSIVE cte AS (SELECT 1 AS n UNION ALL SELECT n + 1 FROM cte WHERE n < 500000) SELECT count(*) FROM cte;" > /box/bench.sql && node /opt/runner/runner.js /box/bench.sql 15'],
        AttachStdout: true,
        AttachStderr: true,
      });
      const stream = await exec.start({ Detach: false });
      stream.resume();

      let peakUsage = initialMem.rawUsageBytes;
      const pollInterval = setInterval(async () => {
        try {
          const stats = await container.stats({ stream: false });
          if (stats.memory_stats?.usage > peakUsage) {
            peakUsage = stats.memory_stats.usage;
          }
        } catch {}
      }, 25);

      await new Promise(r => stream.on('end', r));
      clearInterval(pollInterval);

      const cgroupPeak = await getCgroupMemoryPeak(container);
      const finalMem = await getContainerMemory(container);
      const tmpfs = await getTmpfsUsage(container);
      const effectivePeak = Math.max(cgroupPeak, peakUsage, initialMem.rawUsageBytes, finalMem.rawUsageBytes);

      report.heavyLoad['MySQL'] = {
        peakRamMB: (effectivePeak / (1024 * 1024)).toFixed(2) + ' MB',
        tmpfsUsage: tmpfs,
      };
      console.log(`Peak RAM: ${report.heavyLoad['MySQL'].peakRamMB}, tmpfs: ${tmpfs}`);
    } finally {
      await container.remove({ force: true, v: true }).catch(() => {});
    }
  }

  // 3. End-to-end API Latency (Warm vs Cold)
  console.log('\n--- 3. Measuring End-to-End API Execution Latency ---');
  for (const [name, id, query] of [
    ['PostgreSQL (16)', 8, 'SELECT 1 AS ok;'],
    ['MySQL (8.4)', 9, 'SELECT 1 AS ok;'],
    ['Python (3.8)', 5, 'print("ok")'],
  ]) {
    process.stdout.write(`Measuring ${name} API latency... `);
    const warmTimes = [];
    const warmServerTimes = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const res = await sendApiSubmission(id, query);
      if (res.ok) {
        warmTimes.push(res.duration);
        if (res.serverDuration !== null) warmServerTimes.push(res.serverDuration);
      }
    }

    // Cold submission (using custom memory limit to force on-demand / cold path)
    const coldTimes = [];
    const coldServerTimes = [];
    const coldIterations = Math.min(20, ITERATIONS);
    for (let i = 0; i < coldIterations; i++) {
      const res = await sendApiSubmission(id, query, { memory_limit: 480000 });
      if (res.ok) {
        coldTimes.push(res.duration);
        if (res.serverDuration !== null) coldServerTimes.push(res.serverDuration);
      }
    }

    report.apiLatency[name] = {
      warm: statsSummary(warmTimes),
      warmServer: statsSummary(warmServerTimes),
      cold: statsSummary(coldTimes),
      coldServer: statsSummary(coldServerTimes),
    };
    console.log(`Warm p50: ${report.apiLatency[name].warm.p50}ms (server p50: ${report.apiLatency[name].warmServer.p50}ms) | Cold avg: ${report.apiLatency[name].cold.avg}ms (server avg: ${report.apiLatency[name].coldServer.avg}ms)`);
  }

  console.log('\n======================================================');
  console.log('                 BENCHMARK REPORT                     ');
  console.log('======================================================\n');

  console.log('### Benchmark Environment');
  console.log(`- CPU: ${env.cpuModel} (${env.cpuCores} cores)`);
  console.log(`- RAM: ${env.totalRam}`);
  console.log(`- Kernel: ${env.kernelVersion}`);
  console.log(`- Docker: ${env.dockerVersion} (Storage Driver: ${env.storageDriver})`);
  console.log(`- Commit: ${env.gitCommit}`);
  console.log(`- Date: ${env.date}\n`);

  console.log('### Container Boot Times (create + start + await ready)');
  console.table(report.boots);

  console.log('\n### Idle RAM Usage (Net / Total)');
  console.table(report.idleRam);

  console.log('\n### Peak Resource Usage (Heavy Query)');
  console.table(report.heavyLoad);

  console.log('\n### End-to-End API Latency (ms)');
  for (const [k, v] of Object.entries(report.apiLatency)) {
    console.log(`- ${k}: Warm p50=${v.warm.p50}ms (server p50=${v.warmServer?.p50 ?? 'N/A'}ms) | Cold avg=${v.cold.avg}ms (server avg=${v.coldServer?.avg ?? 'N/A'}ms)`);
  }

  const benchDir = path.join(__dirname, '..', 'docs', 'benchmarks');
  if (!fs.existsSync(benchDir)) {
    fs.mkdirSync(benchDir, { recursive: true });
  }
  const outFile = path.join(benchDir, 'benchmark.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nRaw benchmark report written to: ${outFile}`);

  console.log('\nJSON Output:');
  console.log(JSON.stringify(report, null, 2));

  await benchPool.shutdown();
  process.exit(0);
  return report;
}

main().catch(err => {
  console.error('[FATAL] Benchmark failed:', err);
  process.exit(1);
});
