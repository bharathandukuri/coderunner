export function parsePositiveIntEnv(envName, rawVal, defaultValue) {
  if (rawVal === undefined || rawVal === null || rawVal === '') {
    return defaultValue;
  }
  const parsed = Number(rawVal);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${envName} must be a positive integer, got ${rawVal}`);
  }
  return parsed;
}

const rawWorkerConcurrency = process.env.WORKER_CONCURRENCY !== undefined ? Number(process.env.WORKER_CONCURRENCY) : 4;
const baseWorkerConcurrency = (Number.isInteger(rawWorkerConcurrency) && rawWorkerConcurrency > 0) ? rawWorkerConcurrency : 4;

export function validateQueueDepthEnv(env = process.env, concurrency = baseWorkerConcurrency) {
  const maxQueueDepth = parsePositiveIntEnv('MAX_QUEUE_DEPTH', env.MAX_QUEUE_DEPTH, concurrency * 25);
  const maxDbQueueDepth = parsePositiveIntEnv('MAX_DB_QUEUE_DEPTH', env.MAX_DB_QUEUE_DEPTH, concurrency * 5);
  return { maxQueueDepth, maxDbQueueDepth };
}

const config = {
  server: {
    port: parseInt(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    apiBaseUrl: process.env.API_BASE_URL || 'http://localhost:3000',
    bodyLimit: process.env.BODY_LIMIT || '5mb',
    trustProxy: process.env.TRUST_PROXY === 'false' ? false : 1,
  },

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  auth: {
    tokens: (process.env.AUTH_TOKEN || '').split(' ').filter(Boolean),
    headers: (process.env.AUTH_HEADERS || 'X-Auth-Token x-rapidapi-key').split(' ').filter(Boolean),
  },

  execution: {
    defaultCpuTimeLimit: parseInt(process.env.DEFAULT_CPU_TIME_LIMIT) || 5,
    maxCpuTimeLimit: parseInt(process.env.MAX_CPU_TIME_LIMIT) || 15,
    defaultWallTimeLimit: parseInt(process.env.DEFAULT_WALL_TIME_LIMIT) || 10,
    maxWallTimeLimit: parseInt(process.env.MAX_WALL_TIME_LIMIT) || 30,
    defaultMemoryLimit: parseInt(process.env.DEFAULT_MEMORY_LIMIT) || 128000,
    maxMemoryLimit: parseInt(process.env.MAX_MEMORY_LIMIT) || 512000,
    maxProcesses: parseInt(process.env.MAX_PROCESSES) || 60,
    maxBatchSize: process.env.MAX_BATCH_SIZE ? parseInt(process.env.MAX_BATCH_SIZE, 10) : 20,
    maxSourceSize: parseInt(process.env.MAX_SOURCE_SIZE) || 65536,
    maxAdditionalFilesSize: parseInt(process.env.MAX_ADDITIONAL_FILES_SIZE) || 2097152, // 2MB base64
    defaultStackLimit: parseInt(process.env.DEFAULT_STACK_LIMIT) || 64000,
    compileCpuTimeLimit: parseInt(process.env.COMPILE_CPU_TIME_LIMIT) || 15,
    compileWallTimeLimit: parseInt(process.env.COMPILE_WALL_TIME_LIMIT) || 30,
  },

  worker: {
    concurrency: process.env.WORKER_CONCURRENCY !== undefined ? Number(process.env.WORKER_CONCURRENCY) : 4,
  },

  queue: {
    maxQueueDepth: parsePositiveIntEnv('MAX_QUEUE_DEPTH', process.env.MAX_QUEUE_DEPTH, baseWorkerConcurrency * 25),
    maxDbQueueDepth: parsePositiveIntEnv('MAX_DB_QUEUE_DEPTH', process.env.MAX_DB_QUEUE_DEPTH, baseWorkerConcurrency * 5),
    maxConcurrentWaitRequests: process.env.MAX_CONCURRENT_WAIT_REQUESTS ? parseInt(process.env.MAX_CONCURRENT_WAIT_REQUESTS, 10) : (baseWorkerConcurrency * 25),
    retryAfterSeconds: parseInt(process.env.RETRY_AFTER_SECONDS, 10) || 5,
  },

  cache: {
    resultTtl: parseInt(process.env.RESULT_CACHE_TTL) || 3600,
  },

  rateLimit: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 60000,
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS) || 100,
    submissionsWindowMs: parseInt(process.env.RATE_LIMIT_SUBMISSIONS_WINDOW_MS) || 60000,
    submissionsMax: parseInt(process.env.RATE_LIMIT_SUBMISSIONS_MAX) || 120,
  },

  docker: {
    socketPath: process.env.DOCKER_SOCKET || (!process.env.DOCKER_HOST ? '/var/run/docker.sock' : undefined),
    host: process.env.DOCKER_HOST,
    runtime: process.env.DOCKER_RUNTIME,
    containerTimeout: parseInt(process.env.CONTAINER_TIMEOUT) || 30000,
    languagePoolEnabled: process.env.ENABLE_LANGUAGE_POOL === 'true',
    maxConcurrentBoots: parseInt(process.env.WARM_POOL_MAX_CONCURRENT_BOOTS) || 3,
  },

  mongodb: {
    enabled: process.env.ENABLE_MONGODB === 'true',
  },
};

/**
 * Get pool concurrency from config.
 * Throws a clear Error if it is not a positive integer.
 */
export function getPoolConcurrency() {
  const c = config.worker?.concurrency;
  if (typeof c !== 'number' || !Number.isInteger(c) || c <= 0) {
    throw new Error(`WORKER_CONCURRENCY must be a positive integer, got ${process.env.WORKER_CONCURRENCY ?? c}`);
  }
  return c;
}

export default config;
