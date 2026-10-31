#!/usr/bin/env node
import http from 'node:http';

const BASE_URL = process.env.API_URL || 'http://localhost:8080';
const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const BURST_SIZE = parseInt(process.env.BURST_SIZE || '20', 10);
const DURATION_SEC = parseInt(process.env.DURATION_SEC || '300', 10);
const TARGET_RPS = parseFloat(process.env.TARGET_RPS || '1');
const SKIP_BURST = process.env.SKIP_BURST === 'true';
const SKIP_SUSTAINED = process.env.SKIP_SUSTAINED === 'true';

if (!AUTH_TOKEN) {
  console.error('Error: AUTH_TOKEN environment variable required');
  process.exit(1);
}

const ENGINES = [
  { id: 5, name: 'Python (Isolate)', code: "print('LOAD_PY')" },
  { id: 8, name: 'PostgreSQL (Warm Pool)', code: "SELECT 1 AS load_pg;" },
  { id: 9, name: 'MySQL (Warm Pool)', code: "SELECT 1 AS load_mysql;" },
];

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
    const res = await fetch(`${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(expr)}`);
    const data = await res.json();
    return data?.data?.result || [];
  } catch (err) {
    return [];
  }
}

async function submitJob(engine) {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN,
      'Authorization': `Bearer ${AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      language_id: engine.id,
      source_code: engine.code,
      time_limit: 15,
    }),
  });
  const duration = Date.now() - start;
  const data = await res.json().catch(() => null);
  const ok = res.status === 201 && data && data.status && data.status.id === 3;
  return { ok, duration, status: res.status, statusId: data?.status?.id, error: data?.error, stderr: data?.stderr };
}

async function runBurstPhase() {
  console.log(`\n=== 1. Burst Load Phase (${BURST_SIZE} requests per engine) ===`);
  const burstResults = {};

  for (const engine of ENGINES) {
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
  console.log(`\n=== 2. Sustained Load Phase (~${TARGET_RPS} req/s for ${DURATION_SEC}s) ===`);
  const latencies = { 5: [], 8: [], 9: [] };
  const successes = { 5: 0, 8: 0, 9: 0 };
  const totalDispatched = { 5: 0, 8: 0, 9: 0 };

  const poolDepthHistory = [];
  const waiterPeaks = { postgres: 0, mysql: 0 };

  const intervalMs = 1000 / TARGET_RPS;
  const startTime = Date.now();
  const endTime = startTime + DURATION_SEC * 1000;
  let engineIdx = 0;
  const inFlight = new Set();

  let nextTick = Date.now();
  let lastPromSample = Date.now();

  while (Date.now() < endTime) {
    const engine = ENGINES[engineIdx % ENGINES.length];
    engineIdx++;
    totalDispatched[engine.id]++;

    const jobPromise = submitJob(engine).then((res) => {
      latencies[engine.id].push(res.duration);
      if (res.ok) successes[engine.id]++;
      inFlight.delete(jobPromise);
    });
    inFlight.add(jobPromise);

    // Periodically sample Prometheus metrics
    if (Date.now() - lastPromSample >= 15000) {
      lastPromSample = Date.now();
      const [depths, waiters] = await Promise.all([
        queryPrometheus('coderunner_pool_depth'),
        queryPrometheus('coderunner_pool_waiters'),
      ]);

      const depthSnapshot = { time: Math.round((Date.now() - startTime) / 1000) };
      for (const d of depths) {
        if (d.metric?.engine) depthSnapshot[d.metric.engine] = parseFloat(d.value[1]);
      }
      poolDepthHistory.push(depthSnapshot);

      for (const w of waiters) {
        const eng = w.metric?.engine;
        const val = parseFloat(w.value[1]);
        if (eng && val > (waiterPeaks[eng] || 0)) {
          waiterPeaks[eng] = val;
        }
      }
    }

    nextTick += intervalMs;
    const sleepMs = nextTick - Date.now();
    if (sleepMs > 0) {
      await new Promise(r => setTimeout(r, sleepMs));
    }

    if (Math.floor((Date.now() - startTime) / 1000) % 30 === 0 && (Date.now() - startTime) > 1000) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const totalSent = Object.values(totalDispatched).reduce((a, b) => a + b, 0);
      console.log(`  Progress: ${elapsed}s / ${DURATION_SEC}s elapsed (${totalSent} requests sent, ${inFlight.size} in flight)...`);
    }
  }

  console.log('Waiting for remaining in-flight requests to complete...');
  await Promise.all(Array.from(inFlight));

  const sustainedResults = {};
  for (const engine of ENGINES) {
    const stats = calculatePercentiles(latencies[engine.id]);
    sustainedResults[engine.name] = {
      ...stats,
      dispatched: totalDispatched[engine.id],
      successes: successes[engine.id],
    };
    console.log(`  ✓ ${engine.name}: ${successes[engine.id]}/${totalDispatched[engine.id]} succeeded | min: ${stats.min}ms | p50: ${stats.p50}ms | p95: ${stats.p95}ms | max: ${stats.max}ms`);
  }

  // Final Prometheus queries
  const [bootFailures, acquireP50, acquireP95] = await Promise.all([
    queryPrometheus('coderunner_pool_boot_failures_total'),
    queryPrometheus('histogram_quantile(0.50, sum(rate(coderunner_pool_acquire_wait_duration_seconds_bucket[5m])) by (le, engine))'),
    queryPrometheus('histogram_quantile(0.95, sum(rate(coderunner_pool_acquire_wait_duration_seconds_bucket[5m])) by (le, engine))'),
  ]);

  const prometheusStats = {
    waiterPeaks,
    poolDepthHistory,
    bootFailures: bootFailures.map(r => ({ engine: r.metric.engine, count: r.value[1] })),
    acquireWaitP50: acquireP50.map(r => ({ engine: r.metric.engine, seconds: r.value[1] })),
    acquireWaitP95: acquireP95.map(r => ({ engine: r.metric.engine, seconds: r.value[1] })),
  };

  return { sustainedResults, prometheusStats };
}

async function main() {
  console.log(`Starting Production Load Test against ${BASE_URL} (Prometheus: ${PROMETHEUS_URL})...`);
  const burst = SKIP_BURST ? null : await runBurstPhase();
  const sustainedData = SKIP_SUSTAINED ? null : await runSustainedPhase();

  console.log('\n=== Load Test Summary ===');
  console.log(JSON.stringify({ burst, sustained: sustainedData?.sustainedResults, prometheusStats: sustainedData?.prometheusStats }, null, 2));
}

main().catch(err => {
  console.error('Fatal load test error:', err);
  process.exit(1);
});
