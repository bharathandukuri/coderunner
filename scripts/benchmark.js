import http from 'http';
import Docker from 'dockerode';
import { WarmContainerPool } from '../src/executor/pool/WarmContainerPool.js';

const docker = new Docker();
const BASE_URL = process.env.API_URL || 'http://api:3000';
const AUTH_TOKEN = 'dev-token';

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

async function measureColdBoot(languageId) {
  const pool = new WarmContainerPool(docker);
  const start = Date.now();
  const c = await pool.createAndBootDaemon(languageId);
  const duration = Date.now() - start;
  await pool.destroy(c);
  return duration;
}

async function sendRequest(langId, sql = 'SELECT 1;') {
  const start = Date.now();
  const res = await fetch(`${BASE_URL}/submissions?wait=true`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Auth-Token': AUTH_TOKEN,
    },
    body: JSON.stringify({
      source_code: sql,
      language_id: langId,
    }),
  });
  const data = await res.json();
  const duration = Date.now() - start;
  return { duration, ok: res.ok && data.status?.id === 3, data };
}

async function run() {
  console.log('=== 1. Cold Boot Measurements ===');
  const pgCold = [];
  for (let i = 0; i < 3; i++) {
    const t = await measureColdBoot(8);
    pgCold.push(t);
  }
  const myCold = [];
  for (let i = 0; i < 3; i++) {
    const t = await measureColdBoot(9);
    myCold.push(t);
  }
  console.log(`PostgreSQL Cold Boot: avg = ${Math.round(pgCold.reduce((a, b) => a + b, 0) / pgCold.length)}ms (samples: ${pgCold.join(', ')}ms)`);
  console.log(`MySQL Cold Boot: avg = ${Math.round(myCold.reduce((a, b) => a + b, 0) / myCold.length)}ms (samples: ${myCold.join(', ')}ms)`);

  console.log('\n=== 2. Warm Hit Latencies (Sequential) ===');
  for (const [name, id] of [['PostgreSQL', 8], ['MySQL', 9]]) {
    const times = [];
    for (let i = 0; i < 20; i++) {
      const r = await sendRequest(id);
      if (r.ok) times.push(r.duration);
    }
    console.log(`${name} Warm Hits (20 reqs): p50 = ${percentile(times, 50)}ms, p95 = ${percentile(times, 95)}ms, min = ${Math.min(...times)}ms, max = ${Math.max(...times)}ms`);
  }

  console.log('\n=== 3. 20-Request Burst (Concurrent) ===');
  for (const [name, id] of [['PostgreSQL', 8], ['MySQL', 9]]) {
    const start = Date.now();
    const promises = Array.from({ length: 20 }, () => sendRequest(id));
    const results = await Promise.all(promises);
    const times = results.map(r => r.duration);
    const totalTime = Date.now() - start;
    const okCount = results.filter(r => r.ok).length;
    console.log(`${name} Burst (20 concurrent): ${okCount}/20 ok in ${totalTime}ms | p50 = ${percentile(times, 50)}ms, p95 = ${percentile(times, 95)}ms`);
  }

  console.log('\n=== 4. Sustained Load (60 seconds) ===');
  const durationMs = 60000;
  const startTime = Date.now();
  let completed = 0;
  let errors = 0;
  const latencies = [];
  const concurrency = 4;

  async function workerLoop() {
    while (Date.now() - startTime < durationMs) {
      const langId = completed % 2 === 0 ? 8 : 9;
      try {
        const r = await sendRequest(langId);
        latencies.push(r.duration);
        if (r.ok) completed++;
        else errors++;
      } catch (e) {
        errors++;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => workerLoop()));
  const totalElapsedSec = (Date.now() - startTime) / 1000;
  const throughput = (completed / totalElapsedSec).toFixed(2);
  console.log(`Sustained Load: ${completed} requests completed in ${totalElapsedSec.toFixed(1)}s (${throughput} req/s), errors: ${errors}`);
  console.log(`Latencies: p50 = ${percentile(latencies, 50)}ms, p95 = ${percentile(latencies, 95)}ms, p99 = ${percentile(latencies, 99)}ms`);
}

run().catch(console.error);
