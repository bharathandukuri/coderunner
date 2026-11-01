import { Queue } from 'bullmq';
import Redis from 'ioredis';
import config from '../utils/config.js';
import logger from '../utils/logger.js';

// Redis connection
let redis = null;
let subRedis = null;
let submissionQueue = null;
let dbSubmissionQueue = null;

export const SUBMISSIONS_QUEUE = 'submissions';
export const DB_SUBMISSIONS_QUEUE = 'submissions-db';

/**
 * Initialize Redis and BullMQ queues
 */
export async function initializeQueue() {
  redis = new Redis(config.redis.url, {
    maxRetriesPerRequest: null,
  });

  redis.on('error', (err) => {
    logger.error({ err }, 'Redis connection error');
  });

  redis.on('connect', () => {
    logger.info('Connected to Redis');
  });

  const defaultJobOptions = {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: {
      count: 100,
    },
    removeOnFail: {
      count: 1000,
    },
  };

  submissionQueue = new Queue(SUBMISSIONS_QUEUE, {
    connection: redis,
    defaultJobOptions,
  });

  dbSubmissionQueue = new Queue(DB_SUBMISSIONS_QUEUE, {
    connection: redis,
    defaultJobOptions,
  });

  logger.info('BullMQ queues initialized');
  return submissionQueue;
}

/**
 * Get Redis connection
 */
export function getRedis() {
  return redis;
}

/**
 * Get dedicated Redis subscriber connection for Pub/Sub events
 */
export function getSubscriberRedis() {
  if (!subRedis && redis) {
    subRedis = redis.duplicate();
    subRedis.on('error', (err) => {
      logger.warn({ event: 'sub_redis_error', error: err.message });
    });
  }
  return subRedis;
}

export function setSubscriberRedis(sub) {
  subRedis = sub;
}

export function setRedis(r) {
  redis = r;
}

export function setQueues(subQ, dbQ = null) {
  submissionQueue = subQ;
  dbSubmissionQueue = dbQ;
}

/**
 * Check if language routes to database queue
 */
export function isDbLanguage(languageId) {
  const id = Number(languageId);
  return id === 8 || id === 9 || id === 10;
}

/**
 * Get queue name for language
 */
export function getQueueName(languageId) {
  return isDbLanguage(languageId) ? DB_SUBMISSIONS_QUEUE : SUBMISSIONS_QUEUE;
}

/**
 * Get submission queue
 */
export function getQueue(languageId) {
  if (isDbLanguage(languageId)) {
    return dbSubmissionQueue || submissionQueue;
  }
  return submissionQueue;
}

/**
 * Add submission to queue and cache
 */
export async function addSubmission(submission) {
  if (!redis || !submissionQueue) {
    throw new Error('Queue not initialized');
  }

  // Store initial submission state in Redis
  await redis.setex(
    `submission:${submission.token}`,
    config.cache.resultTtl,
    JSON.stringify(submission)
  );

  const isDb = isDbLanguage(submission.language_id);
  const targetQueue = (isDb && dbSubmissionQueue) ? dbSubmissionQueue : submissionQueue;

  // Add job to target queue
  await targetQueue.add('execute', submission, {
    jobId: submission.token,
  });

  logger.debug({
    event: 'submission_queued',
    token: submission.token,
    queue: isDb ? DB_SUBMISSIONS_QUEUE : SUBMISSIONS_QUEUE,
  });

  return submission;
}

/**
 * Get submission from cache
 */
export async function getSubmission(token) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const data = await redis.get(`submission:${token}`);
  if (!data) return null;

  return JSON.parse(data);
}

/**
 * Update submission in cache
 */
export async function updateSubmission(token, updates) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const existing = await getSubmission(token);
  if (!existing) return null;

  const updated = { ...existing, ...updates };

  await redis.setex(
    `submission:${token}`,
    config.cache.resultTtl,
    JSON.stringify(updated)
  );

  return updated;
}

/**
 * Delete submission from cache
 */
export async function deleteSubmission(token) {
  if (!redis) {
    throw new Error('Redis not initialized');
  }

  const exists = await redis.exists(`submission:${token}`);
  if (!exists) return false;

  await redis.del(`submission:${token}`);
  return true;
}

/**
 * Get queue statistics
 */
export async function getQueueStats() {
  if (!submissionQueue) {
    return {
      submissions: { total: 0, in_queue: 0, processing: 0, completed: 0, failed: 0 },
      by_queue: {
        [SUBMISSIONS_QUEUE]: { total: 0, in_queue: 0, processing: 0, completed: 0, failed: 0 },
        [DB_SUBMISSIONS_QUEUE]: { total: 0, in_queue: 0, processing: 0, completed: 0, failed: 0 },
      },
    };
  }

  const [codeWaiting, codeActive, codeCompleted, codeFailed] = await Promise.all([
    submissionQueue.getWaitingCount ? submissionQueue.getWaitingCount() : 0,
    submissionQueue.getActiveCount ? submissionQueue.getActiveCount() : 0,
    submissionQueue.getCompletedCount ? submissionQueue.getCompletedCount() : 0,
    submissionQueue.getFailedCount ? submissionQueue.getFailedCount() : 0,
  ]);

  let dbWaiting = 0, dbActive = 0, dbCompleted = 0, dbFailed = 0;
  if (dbSubmissionQueue) {
    [dbWaiting, dbActive, dbCompleted, dbFailed] = await Promise.all([
      dbSubmissionQueue.getWaitingCount ? dbSubmissionQueue.getWaitingCount() : 0,
      dbSubmissionQueue.getActiveCount ? dbSubmissionQueue.getActiveCount() : 0,
      dbSubmissionQueue.getCompletedCount ? dbSubmissionQueue.getCompletedCount() : 0,
      dbSubmissionQueue.getFailedCount ? dbSubmissionQueue.getFailedCount() : 0,
    ]);
  }

  const totalWaiting = codeWaiting + dbWaiting;
  const totalActive = codeActive + dbActive;
  const totalCompleted = codeCompleted + dbCompleted;
  const totalFailed = codeFailed + dbFailed;

  return {
    submissions: {
      total: totalWaiting + totalActive + totalCompleted + totalFailed,
      in_queue: totalWaiting,
      processing: totalActive,
      completed: totalCompleted,
      failed: totalFailed,
    },
    by_queue: {
      [SUBMISSIONS_QUEUE]: {
        total: codeWaiting + codeActive + codeCompleted + codeFailed,
        in_queue: codeWaiting,
        processing: codeActive,
        completed: codeCompleted,
        failed: codeFailed,
      },
      [DB_SUBMISSIONS_QUEUE]: {
        total: dbWaiting + dbActive + dbCompleted + dbFailed,
        in_queue: dbWaiting,
        processing: dbActive,
        completed: dbCompleted,
        failed: dbFailed,
      },
    },
  };
}

/**
 * Get worker statistics
 */
export async function getWorkerStats() {
  if (!submissionQueue) {
    return [];
  }

  const queues = [submissionQueue];
  if (dbSubmissionQueue) queues.push(dbSubmissionQueue);

  const allWorkers = [];
  for (const q of queues) {
    const workers = await q.getWorkers();
    allWorkers.push(...workers.map(w => ({
      id: w.id,
      name: w.name,
      active: true,
    })));
  }

  return allWorkers;
}

/**
 * Close Redis connection
 */
export async function closeQueue() {
  if (submissionQueue) {
    await submissionQueue.close();
  }
  if (dbSubmissionQueue) {
    await dbSubmissionQueue.close();
  }
  if (subRedis) {
    await subRedis.quit().catch(() => {});
    subRedis = null;
  }
  if (redis) {
    await redis.quit();
  }
  logger.info('Queue connections closed');
}

export default {
  initializeQueue,
  getRedis,
  getSubscriberRedis,
  getQueue,
  addSubmission,
  getSubmission,
  updateSubmission,
  deleteSubmission,
  getQueueStats,
  getWorkerStats,
  closeQueue,
};
