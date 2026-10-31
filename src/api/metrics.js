import client from 'prom-client';
import { getQueueStats, getWorkerStats } from '../queue/producer.js';

// Create a Registry
const register = new client.Registry();

// Default metrics (CPU, memory, etc.)
client.collectDefaultMetrics({ register });

// Custom metrics
const queueSize = new client.Gauge({
  name: 'coderunner_queue_size',
  help: 'Number of submissions waiting in queue',
  registers: [register],
});

const activeWorkers = new client.Gauge({
  name: 'coderunner_workers_active',
  help: 'Number of active workers processing submissions',
  registers: [register],
});

const submissionsTotal = new client.Counter({
  name: 'coderunner_submissions_total',
  help: 'Total number of submissions processed',
  labelNames: ['status', 'language'],
  registers: [register],
});

const submissionDuration = new client.Histogram({
  name: 'coderunner_submission_duration_seconds',
  help: 'Duration of submission execution in seconds',
  labelNames: ['language'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

const queueProcessing = new client.Gauge({
  name: 'coderunner_queue_processing',
  help: 'Number of submissions currently being processed',
  registers: [register],
});

const queueCompleted = new client.Gauge({
  name: 'coderunner_queue_completed',
  help: 'Total completed submissions in queue',
  registers: [register],
});

const queueFailed = new client.Gauge({
  name: 'coderunner_queue_failed',
  help: 'Total failed submissions in queue',
  registers: [register],
});

// Database Warm Pool Metrics
const poolDepth = new client.Gauge({
  name: 'coderunner_pool_depth',
  help: 'Number of warm containers currently available in the pool',
  labelNames: ['engine'],
  registers: [register],
});

const poolWaiters = new client.Gauge({
  name: 'coderunner_pool_waiters',
  help: 'Number of requests currently waiting for a container',
  labelNames: ['engine'],
  registers: [register],
});

const poolBootDuration = new client.Histogram({
  name: 'coderunner_pool_boot_duration_seconds',
  help: 'Duration of container boot in seconds',
  labelNames: ['engine'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

const poolBootFailures = new client.Counter({
  name: 'coderunner_pool_boot_failures_total',
  help: 'Total count of container boot failures',
  labelNames: ['engine'],
  registers: [register],
});

const poolAcquireWaitDuration = new client.Histogram({
  name: 'coderunner_pool_acquire_wait_duration_seconds',
  help: 'Duration a request waited to acquire a container in seconds',
  labelNames: ['engine'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

const poolCircuitState = new client.Gauge({
  name: 'coderunner_pool_circuit_state',
  help: 'Circuit breaker state (0=closed, 1=half-open, 2=open)',
  labelNames: ['engine'],
  registers: [register],
});

// Update queue metrics before each scrape
register.setDefaultLabels({ service: 'coderunner' });

async function updateQueueMetrics() {
  try {
    const stats = await getQueueStats();
    queueSize.set(stats.submissions.in_queue);
    queueProcessing.set(stats.submissions.processing);
    queueCompleted.set(stats.submissions.completed);
    queueFailed.set(stats.submissions.failed);

    const workers = await getWorkerStats();
    activeWorkers.set(workers.length);
  } catch {
    // Queue might not be ready yet
  }
}

export function recordSubmission(status, language, durationSeconds) {
  submissionsTotal.inc({ status, language });
  if (durationSeconds !== undefined) {
    submissionDuration.observe({ language }, durationSeconds);
  }
}

export function recordPoolDepth(engine, depth) {
  poolDepth.set({ engine }, depth);
}

export function recordPoolWaiters(engine, count) {
  poolWaiters.set({ engine }, count);
}

export function recordPoolBootDuration(engine, durationSec) {
  poolBootDuration.observe({ engine }, durationSec);
}

export function recordPoolBootFailure(engine) {
  poolBootFailures.inc({ engine });
}

export function recordPoolAcquireWait(engine, waitSec) {
  poolAcquireWaitDuration.observe({ engine }, waitSec);
}

export function recordPoolCircuitState(engine, state) {
  const val = typeof state === 'number' ? state : (state === 'open' ? 2 : (state === 'half-open' ? 1 : 0));
  poolCircuitState.set({ engine }, val);
}

export async function metricsHandler(req, res) {
  await updateQueueMetrics();
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
}

export default {
  register,
  metricsHandler,
  recordSubmission,
  recordPoolDepth,
  recordPoolWaiters,
  recordPoolBootDuration,
  recordPoolBootFailure,
  recordPoolAcquireWait,
  recordPoolCircuitState,
};
