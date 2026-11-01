#!/usr/bin/env node
/**
 * scripts/load-test.mjs - CodeRunner Load & Capacity Generator
 * Modes: ramp (default for capacity benchmarking), burst, sustained
 * Features: multi-engine workloads, remote execution, automated abort conditions
 */

import http from 'node:http';

// Parse command line arguments
const args = process.argv.slice(2);
function getArg(flag, envVar, fallback) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === flag && args[i + 1]) return args[i + 1];
    if (args[i].startsWith(`${flag}=`)) return args[i].split('=')[1];
  }
  return process.env[envVar] || fallback;
}

function hasArg(flag) {
  return args.includes(flag);
}

if (hasArg('--help') || hasArg('-h')) {
  console.log(`
Usage: node scripts/load-test.mjs [options]

Modes:
  --ramp                  Step-wise capacity ramp mode with automated abort conditions (default)
  --burst                 Burst load phase (e.g. 20 concurrent requests per engine)
  --sustained             Fixed rate sustained load over duration

Options:
  --api-url=<url>         API base URL (default: http://localhost:8080)
  --prom-url=<url>        Prometheus URL (default: http://localhost:9090 or http://prometheus:9090)
  --auth-token=<token>    API authentication token (required)
  --workload=<type>       Workload to test: python, postgres, mysql, mix (default: mix)
  --step-duration=<sec>   Hold duration per ramp step in seconds (default: 60)
  --start-rps=<num>       Starting requests per second (default: 1)
  --step-rps=<num>        RPS increment per step (default: 1)
  --max-rps=<num>         Maximum RPS to ramp up to (default: 50)
  --p95-threshold=<ms>    Max allowable p95 latency before abort (default: 2000ms for db/mix, 1000ms for py)
  --burst-size=<num>      Burst size per engine (default: 20)
  --duration=<sec>        Duration for sustained phase in seconds (default: 300)
  --target-rps=<num>      Target RPS for sustained phase (default: 1)
`);
  process.exit(0);
}

const BASE_URL = getArg('--api-url', 'API_URL', 'http://localhost:8080');
const PROMETHEUS_URL = getArg('--prom-url', 'PROMETHEUS_URL', 'http://localhost:9090');
const AUTH_TOKEN = getArg('--auth-token', 'AUTH_TOKEN', '');
const WORKLOAD = getArg('--workload', 'WORKLOAD', 'mix').toLowerCase();

const MODE = hasArg('--burst') ? 'burst' : (hasArg('--sustained') ? 'sustained' : (getArg('--mode', 'MODE', 'ramp')));

// Ramp configuration
const RAMP_START_RPS = parseFloat(getArg('--start-rps', 'RAMP_START_RPS', '1'));
const RAMP_STEP_RPS = parseFloat(getArg('--step-rps', 'RAMP_STEP_RPS', '1'));
const RAMP_MAX_RPS = parseFloat(getArg('--max-rps', 'RAMP_MAX_RPS', '50'));
const RAMP_STEP_DURATION_SEC = parseInt(getArg('--step-duration', 'RAMP_STEP_DURATION_SEC', '60'), 10);
const DEFAULT_P95_THRESHOLD = WORKLOAD === 'python' ? 1000 : 2500;
const RAMP_P95_THRESHOLD_MS = parseInt(getArg('--p95-threshold', 'RAMP_P95_THRESHOLD_MS', String(DEFAULT_P95_THRESHOLD)), 10);

// Burst / Sustained configuration
const BURST_SIZE = parseInt(getArg('--burst-size', 'BURST_SIZE', '20'), 10);
const DURATION_SEC = parseInt(getArg('--duration', 'DURATION_SEC', '300'), 10);
const TARGET_RPS = parseFloat(getArg('--target-rps', 'TARGET_RPS', '1'));

if (!AUTH_TOKEN) {
  console.error('Error: AUTH_TOKEN required (set via --auth-token or AUTH_TOKEN env var)');
  process.exit(1);
}

const ENGINES = {
  python: { id: 5, name: 'Python (Isolate)', code: "print('LOAD_PY')" },
  postgres: { id: 8, name: 'PostgreSQL (Warm Pool)', code: "SELECT 1 AS load_pg;" },
  mysql: { id: 9, name: 'MySQL (Warm Pool)', code: "SELECT 1 AS load_mysql;" },
};

function getWorkloadEngines(type) {
  if (type === 'python') return [ENGINES.python];
  if (type === 'postgres') return [ENGINES.postgres];
  if (type === 'mysql') return [ENGINES.mysql];
  return [ENGINES.python, ENGINES.postgres, ENGINES.mysql]; // mix
}

function calculatePercentiles(latencies) {
  if (latencies.length === 0) return { p50: 0, p95: 0, p99: 0, min: 0, max: 0, avg: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (pct) => sorted[Math.min(Math.floor(sorted.length * pct), sorted.length - 1)];
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    p50: p(0.50),
    p95: p(0.95),
    p99: p(0.99),
    max: sorted[sorted.length - 1],
    avg: Math.round(sum / sorted.length),
  };
}

async function queryPrometheus(expr) {
  try {
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    return data?.data?.result || [];
  } catch {
    return [];
  }
}

async function submitJob(engine) {
  const start = Date.now();
  const clientIp = `10.0.0.${Math.floor(Math.random() * 500) + 1}`;
  try {
    const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': AUTH_TOKEN,
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'X-Forwarded-For': clientIp,
      },
      body: JSON.stringify({
        language_id: engine.id,
        source_code: engine.code,
        time_limit: 15,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const duration = Date.now() - start;
    const data = await res.json().catch(() => null);
    const ok = res.status === 201 && data && data.status && data.status.id === 3;
    return { ok, duration, status: res.status, statusId: data?.status?.id, error: data?.error, stderr: data?.stderr };
  } catch (err) {
    return { ok: false, duration: Date.now() - start, status: 0, error: err.message };
  }
}

async function checkHostHealth() {
  const [memAvailRes, memTotalRes, loadRes, cpuCountRes, circuitRes] = await Promise.all([
    queryPrometheus('node_memory_MemAvailable_bytes'),
    queryPrometheus('node_memory_MemTotal_bytes'),
    queryPrometheus('node_load1'),
    queryPrometheus('count(node_cpu_seconds_total{mode="idle"})'),
    queryPrometheus('coderunner_pool_circuit_state'),
  ]);

  let memAvailPct = null;
  if (memAvailRes[0]?.value && memTotalRes[0]?.value) {
    const avail = parseFloat(memAvailRes[0].value[1]);
    const total = parseFloat(memTotalRes[0].value[1]);
    if (total > 0) memAvailPct = (avail / total) * 100;
  }

  let load1 = null;
  if (loadRes[0]?.value) {
    load1 = parseFloat(loadRes[0].value[1]);
  }

  let vCPUs = null;
  if (cpuCountRes[0]?.value) {
    vCPUs = parseInt(cpuCountRes[0].value[1], 10);
  }

  let circuitTripped = false;
  for (const c of circuitRes) {
    if (parseFloat(c.value[1]) > 0) {
      circuitTripped = true;
    }
  }

  return { memAvailPct, load1, vCPUs, circuitTripped };
}

async function runRampStep(rps, durationSec, engines) {
  const latencies = [];
  let successes = 0;
  let failures = 0;
  const inFlight = new Set();
  const startTime = Date.now();
  const endTime = startTime + durationSec * 1000;
  const intervalMs = 1000 / rps;
  let engineIdx = 0;
  let nextTick = Date.now();

  while (Date.now() < endTime) {
    const engine = engines[engineIdx % engines.length];
    engineIdx++;

    const job = submitJob(engine).then((res) => {
      latencies.push(res.duration);
      if (res.ok) successes++;
      else failures++;
      inFlight.delete(job);
    });
    inFlight.add(job);

    nextTick += intervalMs;
    const sleepMs = nextTick - Date.now();
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
  }

  // Await remaining in-flight
  await Promise.all(Array.from(inFlight));

  const total = successes + failures;
  const errorRate = total > 0 ? (failures / total) : 0;
  const stats = calculatePercentiles(latencies);

  // Probe host health
  const health = await checkHostHealth();

  // Evaluate automated abort conditions
  const abortReasons = [];
  if (errorRate > 0.05) {
    abortReasons.push(`Error/5xx rate (${(errorRate * 100).toFixed(1)}%) exceeded 5% threshold`);
  }
  if (stats.p95 > RAMP_P95_THRESHOLD_MS) {
    abortReasons.push(`p95 latency (${stats.p95}ms) exceeded threshold (${RAMP_P95_THRESHOLD_MS}ms)`);
  }
  if (health.memAvailPct !== null && health.memAvailPct < 15) {
    abortReasons.push(`Host MemAvailable (${health.memAvailPct.toFixed(1)}%) dropped below 15% threshold`);
  }
  if (health.load1 !== null && health.vCPUs !== null && health.load1 > (2 * health.vCPUs)) {
    abortReasons.push(`Host load1 (${health.load1.toFixed(2)}) exceeded 2x vCPUs (${2 * health.vCPUs})`);
  }
  if (health.circuitTripped) {
    abortReasons.push(`Warm container pool circuit breaker tripped`);
  }

  return {
    rps,
    durationSec,
    total,
    successes,
    failures,
    errorRate,
    stats,
    health,
    passed: abortReasons.length === 0,
    abortReasons,
  };
}

async function runRampMode() {
  const engines = getWorkloadEngines(WORKLOAD);
  console.log(`\n=================================================`);
  console.log(`  Starting RAMP Mode Load Test`);
  console.log(`  Workload: ${WORKLOAD} | Base URL: ${BASE_URL}`);
  console.log(`  RPS Range: ${RAMP_START_RPS} -> ${RAMP_MAX_RPS} (step: ${RAMP_STEP_RPS}, duration: ${RAMP_STEP_DURATION_SEC}s)`);
  console.log(`  Abort criteria: MemAvailable < 15%, load1 > 2x vCPUs, p95 > ${RAMP_P95_THRESHOLD_MS}ms, error rate > 5%`);
  console.log(`=================================================\n`);

  let currentRps = RAMP_START_RPS;
  let highestPassingStep = null;
  let firstFailure = null;
  const stepHistory = [];

  while (currentRps <= RAMP_MAX_RPS) {
    process.stdout.write(`• Testing ${currentRps} RPS for ${RAMP_STEP_DURATION_SEC}s... `);
    const stepResult = await runRampStep(currentRps, RAMP_STEP_DURATION_SEC, engines);
    stepHistory.push(stepResult);

    if (stepResult.passed) {
      highestPassingStep = stepResult;
      console.log(`✓ PASS | ${stepResult.successes}/${stepResult.total} ok | p50: ${stepResult.stats.p50}ms | p95: ${stepResult.stats.p95}ms | p99: ${stepResult.stats.p99}ms`);
      currentRps += RAMP_STEP_RPS;
    } else {
      firstFailure = stepResult;
      console.log(`✗ ABORT | ${stepResult.abortReasons.join('; ')} | p50: ${stepResult.stats.p50}ms | p95: ${stepResult.stats.p95}ms | errors: ${(stepResult.errorRate * 100).toFixed(1)}%`);
      break;
    }
  }

  console.log(`\n=================================================`);
  console.log(`  RAMP Test Complete`);
  console.log(`  Workload:               ${WORKLOAD}`);
  console.log(`  Max Passing RPS:        ${highestPassingStep ? highestPassingStep.rps : '0 (failed at initial RPS)'}`);
  if (highestPassingStep) {
    console.log(`  p50 at Max RPS:         ${highestPassingStep.stats.p50} ms`);
    console.log(`  p95 at Max RPS:         ${highestPassingStep.stats.p95} ms`);
    console.log(`  p99 at Max RPS:         ${highestPassingStep.stats.p99} ms`);
  }
  console.log(`  First Failure Mode:     ${firstFailure ? firstFailure.abortReasons.join('; ') : 'None (reached max RPS)'}`);
  console.log(`=================================================\n`);

  return {
    workload: WORKLOAD,
    maxPassingRps: highestPassingStep ? highestPassingStep.rps : 0,
    passingStats: highestPassingStep?.stats || null,
    firstFailureMode: firstFailure ? firstFailure.abortReasons.join('; ') : 'None',
    steps: stepHistory,
  };
}

async function runBurstPhase() {
  const engines = getWorkloadEngines(WORKLOAD);
  console.log(`\n=== 1. Burst Load Phase (${BURST_SIZE} requests per engine) ===`);
  const burstResults = {};

  for (const engine of engines) {
    console.log(`Submitting ${BURST_SIZE} concurrent requests for ${engine.name}...`);
    const promises = Array.from({ length: BURST_SIZE }, () => submitJob(engine));
    const results = await Promise.all(promises);

    const latencies = results.map(r => r.duration);
    const successes = results.filter(r => r.ok).length;
    const stats = calculatePercentiles(latencies);

    burstResults[engine.name] = { ...stats, total: BURST_SIZE, successes };
    console.log(`  ✓ ${engine.name}: ${successes}/${BURST_SIZE} succeeded | min: ${stats.min}ms | p50: ${stats.p50}ms | p95: ${stats.p95}ms | p99: ${stats.p99}ms | max: ${stats.max}ms`);
  }

  return burstResults;
}

async function runSustainedPhase() {
  const engines = getWorkloadEngines(WORKLOAD);
  console.log(`\n=== 2. Sustained Load Phase (~${TARGET_RPS} req/s for ${DURATION_SEC}s) ===`);
  const latencies = [];
  let successes = 0;
  let totalDispatched = 0;

  const intervalMs = 1000 / TARGET_RPS;
  const startTime = Date.now();
  const endTime = startTime + DURATION_SEC * 1000;
  let engineIdx = 0;
  const inFlight = new Set();
  let nextTick = Date.now();

  while (Date.now() < endTime) {
    const engine = engines[engineIdx % engines.length];
    engineIdx++;
    totalDispatched++;

    const jobPromise = submitJob(engine).then((res) => {
      latencies.push(res.duration);
      if (res.ok) successes++;
      inFlight.delete(jobPromise);
    });
    inFlight.add(jobPromise);

    nextTick += intervalMs;
    const sleepMs = nextTick - Date.now();
    if (sleepMs > 0) {
      await new Promise(r => setTimeout(r, sleepMs));
    }
  }

  await Promise.all(Array.from(inFlight));
  const stats = calculatePercentiles(latencies);

  console.log(`  ✓ Sustained: ${successes}/${totalDispatched} succeeded | min: ${stats.min}ms | p50: ${stats.p50}ms | p95: ${stats.p95}ms | max: ${stats.max}ms`);
  return { dispatched: totalDispatched, successes, stats };
}

async function main() {
  if (MODE === 'burst') {
    const burst = await runBurstPhase();
    console.log('\n=== Load Test Summary ===');
    console.log(JSON.stringify({ burst }, null, 2));
  } else if (MODE === 'sustained') {
    const sustained = await runSustainedPhase();
    console.log('\n=== Load Test Summary ===');
    console.log(JSON.stringify({ sustained }, null, 2));
  } else {
    const ramp = await runRampMode();
    console.log('\n=== Load Test Summary ===');
    console.log(JSON.stringify({ ramp }, null, 2));
  }
}

main().catch(err => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
