import Docker from 'dockerode';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import config from '../../utils/config.js';
import logger from '../../utils/logger.js';
import { createDockerClient } from '../../utils/dockerClient.js';
import { getLanguageById } from '../../languages/index.js';
import {
  recordPoolDepth,
  recordPoolWaiters,
  recordPoolBootDuration,
  recordPoolBootFailure,
  recordPoolAcquireWait,
  recordPoolCircuitState,
} from '../../api/metrics.js';

export class WarmContainerPool {
  constructor(docker, options = {}) {
    this.docker = docker || createDockerClient();
    this.customRedis = !!options.redis;
    this.redis = options.redis || (config.redis?.url ? new Redis(config.redis.url) : null);

    this.instanceId = options.instanceId || process.env.INSTANCE_ID || `worker-${uuidv4().slice(0, 8)}`;
    this.workerSlotId = this.instanceId;

    const defaultConcurrency = parseInt(process.env.WORKER_CONCURRENCY || options.concurrency || '2', 10);
    this.postgresPoolSize = parseInt(process.env.POSTGRES_POOL_SIZE || options.postgresPoolSize || defaultConcurrency, 10);
    this.mysqlPoolSize = parseInt(process.env.MYSQL_POOL_SIZE || options.mysqlPoolSize || defaultConcurrency, 10);
    this.languagePoolSize = parseInt(process.env.LANGUAGE_POOL_SIZE || options.languagePoolSize || config.docker?.languagePoolSize || '1', 10);
    this.targetPoolSize = options.poolSize ? parseInt(options.poolSize, 10) : defaultConcurrency;

    this.maxWaiters = parseInt(process.env.POOL_MAX_WAITERS || options.maxWaiters || '16', 10);
    this.acquireTimeoutMs = parseInt(process.env.POOL_ACQUIRE_TIMEOUT_MS || options.acquireTimeoutMs || '10000', 10);

    this.trackedContainerIds = new Set();
    this.inFlightBoots = new Set();
    this.pendingRemovals = new Set();
    this.isShuttingDown = false;

    // Supported warm pool languages (database engines + general CLI languages)
    this.pools = {
      8: {
        available: [],
        waiters: [],
        activeBoots: 0,
        consecutiveFailures: 0,
        circuitState: 'closed', // 'closed' | 'open' | 'half-open'
        circuitOpenUntil: 0,
        targetPoolSize: this.postgresPoolSize,
        image: 'coderunner/postgres:16',
        name: 'postgres',
        isDaemon: true,
        user: '70:70',
        pidsLimit: 64,
        memoryLimit: 512 * 1024 * 1024,
        readySignal: 'CODERUNNER_DAEMON_READY',
      },
      9: {
        available: [],
        waiters: [],
        activeBoots: 0,
        consecutiveFailures: 0,
        circuitState: 'closed',
        circuitOpenUntil: 0,
        targetPoolSize: this.mysqlPoolSize,
        image: 'coderunner/mysql:8.4',
        name: 'mysql',
        isDaemon: true,
        user: '999:999',
        pidsLimit: 128,
        memoryLimit: 512 * 1024 * 1024,
        readySignal: 'CODERUNNER_DAEMON_READY',
      },
    };

    // Pre-warm general languages (e.g. Python, Node) if language pool is enabled
    if (config.docker?.languagePoolEnabled !== false) {
      this.pools[5] = {
        available: [],
        waiters: [],
        activeBoots: 0,
        consecutiveFailures: 0,
        circuitState: 'closed',
        circuitOpenUntil: 0,
        targetPoolSize: this.languagePoolSize,
        image: 'coderunner/python:3.8',
        name: 'python',
        isDaemon: false,
        user: null,
        pidsLimit: 64,
        memoryLimit: 256 * 1024 * 1024,
      };
    }

    // Setup Redis heartbeat (EX 30, refreshed every 10s)
    if (this.redis) {
      this.heartbeatTimer = setInterval(() => {
        this.sendHeartbeat().catch(() => {});
      }, 10000);
      this.heartbeatTimer.unref();
      this.sendHeartbeat().catch(() => {});

      // Sweep orphaned containers on startup and every 60s
      this.sweepTimer = setInterval(() => {
        this.sweepOrphans().catch(() => {});
      }, 60000);
      this.sweepTimer.unref();
    }
  }

  /**
   * Update pool configuration dynamically
   */
  updateOptions(options = {}) {
    if (options.postgresPoolSize !== undefined) {
      this.postgresPoolSize = parseInt(options.postgresPoolSize, 10);
      if (this.pools[8]) this.pools[8].targetPoolSize = this.postgresPoolSize;
    }
    if (options.mysqlPoolSize !== undefined) {
      this.mysqlPoolSize = parseInt(options.mysqlPoolSize, 10);
      if (this.pools[9]) this.pools[9].targetPoolSize = this.mysqlPoolSize;
    }
    if (options.languagePoolSize !== undefined) {
      this.languagePoolSize = parseInt(options.languagePoolSize, 10);
      if (this.pools[5]) this.pools[5].targetPoolSize = this.languagePoolSize;
    }
    if (options.poolSize !== undefined) {
      const ps = parseInt(options.poolSize, 10);
      this.targetPoolSize = ps;
      if (options.postgresPoolSize === undefined && this.pools[8]) this.pools[8].targetPoolSize = ps;
      if (options.mysqlPoolSize === undefined && this.pools[9]) this.pools[9].targetPoolSize = ps;
      if (options.languagePoolSize === undefined && this.pools[5]) this.pools[5].targetPoolSize = ps;
    }
    if (options.maxWaiters !== undefined) {
      this.maxWaiters = parseInt(options.maxWaiters, 10);
    }
    if (options.acquireTimeoutMs !== undefined) {
      this.acquireTimeoutMs = parseInt(options.acquireTimeoutMs, 10);
    }

    if (!this.isShuttingDown) {
      for (const id of Object.keys(this.pools)) {
        this.checkReplenish(parseInt(id, 10));
      }
    }
  }

  /**
   * Send heartbeat to Redis
   */
  async sendHeartbeat() {
    if (!this.redis || this.isShuttingDown) return;
    try {
      await this.redis.set(`worker:heartbeat:${this.instanceId}`, 'alive', 'EX', 30);
    } catch (err) {
      logger.warn({ event: 'heartbeat_failed', instanceId: this.instanceId, error: err.message });
    }
  }

  /**
   * Sweep orphaned containers older than 60s without an active Redis heartbeat
   * If Redis is unreachable, the sweep skips to prevent pruning healthy containers.
   */
  async sweepOrphans() {
    if (!this.docker || !this.docker.listContainers) return;
    if (!this.redis) {
      logger.warn({ event: 'sweep_skipped', reason: 'redis_not_configured' });
      return;
    }

    // Verify Redis is responsive before evaluating heartbeats
    try {
      await this.redis.ping();
    } catch (err) {
      logger.warn({ event: 'sweep_skipped', reason: 'redis_unreachable', error: err.message });
      return;
    }

    try {
      const list = await this.docker.listContainers({
        all: true,
        filters: {
          label: ['com.coderunner.pool=true'],
        },
      });

      const now = Date.now();
      for (const info of list) {
        const labels = info.Labels || {};
        const createdAt = parseInt(labels['com.coderunner.created_at'] || '0', 10) || (info.Created ? info.Created * 1000 : 0);
        const ageMs = now - createdAt;

        if (ageMs > 60000) {
          const instId = labels['com.coderunner.instance_id'] || labels['com.coderunner.worker_slot'];
          if (!instId) {
            logger.info({ event: 'sweep_removing_unlabeled_orphan', id: info.Id, ageMs });
            const c = this.docker.getContainer(info.Id);
            await c.remove({ force: true, v: true }).catch(() => {});
            continue;
          }

          let alive = true;
          try {
            const exists = await this.redis.exists(`worker:heartbeat:${instId}`);
            alive = (exists === 1);
          } catch (err) {
            logger.warn({ event: 'sweep_heartbeat_check_failed', id: info.Id, instId, error: err.message });
            continue;
          }

          if (!alive) {
            logger.info({ event: 'sweep_removing_orphan', id: info.Id, instId, ageMs });
            const c = this.docker.getContainer(info.Id);
            await c.remove({ force: true, v: true }).catch(() => {});
          }
        }
      }
    } catch (err) {
      logger.error({ event: 'sweep_orphans_error', error: err.message });
    }
  }

  /**
   * Acquire a pre-warmed container or create on-demand.
   * Accepts either languageId (number) or a submission object.
   */
  async acquire(languageIdOrSubmission) {
    if (this.isShuttingDown) {
      throw new Error('Database pool is shutting down');
    }

    let languageId;
    let submission = null;

    if (typeof languageIdOrSubmission === 'object' && languageIdOrSubmission !== null) {
      submission = languageIdOrSubmission;
      languageId = submission.language?.id ?? submission.language_id;
    } else {
      languageId = parseInt(languageIdOrSubmission, 10);
    }

    const pool = this.pools[languageId];

    // Non-standard submissions (networking or non-standard memory) bypass pool and run on-demand
    const isDatabase = languageId === 7 || languageId === 8 || languageId === 9;
    const isCustom = submission && (submission.enable_network || (!isDatabase && submission.memory_limit && submission.memory_limit > 256000));

    if (!pool || isCustom) {
      const container = await this.createOnDemandContainer(languageId, submission);
      return container;
    }

    const acquireStart = Date.now();

    // 1. Instant Warm Hit: Check available containers
    while (pool.available.length > 0) {
      const container = pool.available.pop();
      try {
        const inspect = await container.inspect();
        if (inspect.State.Running) {
          recordPoolAcquireWait(pool.name, (Date.now() - acquireStart) / 1000);
          recordPoolDepth(pool.name, pool.available.length);
          this.checkReplenish(languageId);
          return container;
        }
      } catch {
        // Container dead or gone
      }

      this.destroy(container);
      this.checkReplenish(languageId);
    }

    recordPoolDepth(pool.name, 0);

    // 2. Circuit Breaker Check
    const now = Date.now();
    if (pool.circuitState === 'open') {
      if (now >= pool.circuitOpenUntil) {
        pool.circuitState = 'half-open';
        recordPoolCircuitState(pool.name, 'half-open');
        logger.info({ event: 'circuit_breaker_half_open_probing', language: pool.name });
      } else {
        throw new Error(`Database service for ${pool.name} is temporarily degraded (circuit breaker OPEN). Please try again shortly.`);
      }
    }

    // 3. Queue-full Backpressure Protection
    if (pool.waiters.length >= this.maxWaiters) {
      throw new Error(`Database execution pool queue is full (${pool.waiters.length} waiters). Cannot accept more requests.`);
    }

    // 4. Enqueue waiter with timeout
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;

        const idx = pool.waiters.findIndex(w => w.resolve === resolve);
        if (idx !== -1) {
          pool.waiters.splice(idx, 1);
          recordPoolWaiters(pool.name, pool.waiters.length);
        }
        reject(new Error(`Timed out waiting for database container (${this.acquireTimeoutMs}ms)`));
      }, this.acquireTimeoutMs);

      const waiter = {
        resolve: (container) => {
          if (settled) {
            this.destroy(container);
            return;
          }
          settled = true;
          clearTimeout(timer);
          recordPoolAcquireWait(pool.name, (Date.now() - acquireStart) / 1000);
          resolve(container);
        },
        reject: (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      };

      pool.waiters.push(waiter);
      recordPoolWaiters(pool.name, pool.waiters.length);

      this.checkReplenish(languageId);
    });
  }

  /**
   * Safe release & disposal of an ephemeral container
   */
  release(container) {
    if (!container) return Promise.resolve();
    return this.destroy(container);
  }

  /**
   * Destroy container off the critical path, tracking pending removals
   * Returns removal promise
   */
  destroy(container) {
    if (!container) return Promise.resolve();
    const containerId = container.id || container.Id;
    if (containerId) {
      this.trackedContainerIds.delete(containerId);
    }

    const removePromise = (async () => {
      try {
        await container.remove({ force: true, v: true });
      } catch (err) {
        logger.warn({ event: 'container_destroy_failed', id: containerId, error: err.message });
      }
    })();

    this.pendingRemovals.add(removePromise);
    removePromise.finally(() => {
      this.pendingRemovals.delete(removePromise);
    });

    return removePromise;
  }

  /**
   * Trigger replenishing if current depth is below target
   */
  checkReplenish(languageId) {
    const pool = this.pools[languageId];
    if (!pool || this.isShuttingDown) return;

    const now = Date.now();
    if (pool.circuitState === 'open') {
      if (now < pool.circuitOpenUntil) return;
      pool.circuitState = 'half-open';
      recordPoolCircuitState(pool.name, 'half-open');
    }

    if (pool.circuitState === 'half-open') {
      if (pool.activeBoots > 0) return;
      this.replenish(languageId).catch(() => {});
      return;
    }

    const target = pool.targetPoolSize;
    const currentSlots = pool.available.length + pool.activeBoots;
    const needed = Math.max(0, target - currentSlots);

    for (let i = 0; i < needed; i++) {
      this.replenish(languageId).catch(() => {});
    }
  }

  /**
   * Replenish container with exponential backoff on failure and First-Ready Handoff
   */
  async replenish(languageId) {
    const pool = this.pools[languageId];
    if (!pool || this.isShuttingDown) return;

    if (pool.circuitState === 'half-open' && pool.activeBoots > 0) return;
    if (pool.available.length + pool.activeBoots >= pool.targetPoolSize && pool.waiters.length === 0) return;

    pool.activeBoots++;

    let bootPromise = null;
    let container = null;
    const bootStart = Date.now();

    try {
      bootPromise = this.createAndBoot(languageId);
      this.inFlightBoots.add(bootPromise);

      container = await bootPromise;
      recordPoolBootDuration(pool.name, (Date.now() - bootStart) / 1000);

      if (this.isShuttingDown) {
        if (container) {
          this.destroy(container);
        }
        return;
      }

      // Success: reset failures and close circuit
      pool.consecutiveFailures = 0;
      pool.circuitState = 'closed';
      pool.circuitOpenUntil = 0;
      recordPoolCircuitState(pool.name, 'closed');
    } catch (err) {
      pool.activeBoots--;
      pool.consecutiveFailures++;
      recordPoolBootFailure(pool.name);

      if (pool.circuitState === 'half-open' || pool.consecutiveFailures >= 3) {
        pool.circuitState = 'open';
        recordPoolCircuitState(pool.name, 'open');
        const backoffMs = Math.min(1000 * Math.pow(2, pool.consecutiveFailures - 3), 30000);
        pool.circuitOpenUntil = Date.now() + backoffMs;

        logger.error({
          event: 'circuit_breaker_tripped',
          language: pool.name,
          backoffMs,
          error: err.message,
        });

        // Fail fast currently waiting requests
        while (pool.waiters.length > 0) {
          const w = pool.waiters.shift();
          recordPoolWaiters(pool.name, pool.waiters.length);
          w.reject(new Error(`Container infrastructure error (${pool.name}): ${err.message}`));
        }
      } else {
        const retryDelay = Math.min(100 * Math.pow(2, pool.consecutiveFailures), 2000);
        setTimeout(() => {
          if (!this.isShuttingDown) {
            this.checkReplenish(languageId);
          }
        }, retryDelay).unref();
      }
      return;
    } finally {
      if (bootPromise) {
        this.inFlightBoots.delete(bootPromise);
      }
    }

    pool.activeBoots--;
    if (container && container.id) {
      this.trackedContainerIds.add(container.id);
    }

    // First-Ready Handoff: deliver to earliest waiting request
    if (pool.waiters.length > 0) {
      const waiter = pool.waiters.shift();
      recordPoolWaiters(pool.name, pool.waiters.length);
      waiter.resolve(container);
      this.checkReplenish(languageId);
    } else {
      pool.available.push(container);
      recordPoolDepth(pool.name, pool.available.length);
    }
  }

  /**
   * Create and boot a container (either a database daemon or an idle language sandbox)
   */
  async createAndBoot(languageId) {
    const pool = this.pools[languageId];
    if (!pool) {
      throw new Error(`Language ${languageId} is not configured in warm pool`);
    }

    let container = null;
    const isDaemon = !!pool.isDaemon;

    try {
      const containerConfig = {
        Image: pool.image,
        WorkingDir: '/box',
        NetworkDisabled: true,
        Labels: {
          'com.coderunner.pool': 'true',
          'com.coderunner.instance_id': this.instanceId,
          'com.coderunner.worker_slot': this.instanceId,
          'com.coderunner.created_at': Date.now().toString(),
          'com.coderunner.language': pool.name,
        },
        HostConfig: {
          NetworkMode: 'none',
          ...(config.docker.runtime ? { Runtime: config.docker.runtime } : {}),
          ReadonlyRootfs: true,
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges:true'],
          Memory: pool.memoryLimit || 512 * 1024 * 1024,
          MemorySwap: pool.memoryLimit || 512 * 1024 * 1024,
          CpuPeriod: 100000,
          CpuQuota: 100000,
          PidsLimit: pool.pidsLimit || 64,
        },
      };

      if (isDaemon) {
        if (pool.user) containerConfig.User = pool.user;
        containerConfig.HostConfig.Tmpfs = {
          '/box': 'rw,exec,nosuid,size=256m,mode=1777',
          '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
        };
      } else {
        containerConfig.Cmd = ['/bin/sh', '-c', 'sleep 3600'];
        containerConfig.Tty = false;
        containerConfig.OpenStdin = true;
        containerConfig.HostConfig.Tmpfs = {
          '/box': 'rw,exec,nosuid,size=256m,mode=1777',
          '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
          '/home': 'rw,noexec,nosuid,size=16m,mode=1777',
        };
      }

      container = await this.docker.createContainer(containerConfig);
      await container.start();

      if (isDaemon) {
        await this.awaitReadySignal(container);
      }

      return container;
    } catch (err) {
      if (container) {
        await container.remove({ force: true, v: true }).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * Backward-compatibility alias for tests and benchmarks
   */
  async createAndBootDaemon(languageId) {
    return this.createAndBoot(languageId);
  }

  /**
   * Create an isolated on-demand container for unpooled or custom submissions
   */
  async createOnDemandContainer(languageId, submission = {}) {
    const lang = submission.language || getLanguageById(languageId);
    const { memory_limit, max_processes_and_or_threads, enable_network } = submission;

    const isDatabase = languageId === 7 || languageId === 8 || languageId === 9;
    const effectiveMemory = isDatabase
      ? 512000
      : (memory_limit ? Math.max(memory_limit, 256000) : 256000);
    const boxSize = Math.max(Math.ceil(effectiveMemory / 1024), 128);

    const container = await this.docker.createContainer({
      Image: lang ? lang.image : `coderunner/language:${languageId}`,
      Cmd: ['/bin/sh', '-c', 'sleep 3600'],
      WorkingDir: '/box',
      NetworkDisabled: !enable_network,
      Labels: {
        'com.coderunner.pool': 'false',
        'com.coderunner.created_at': Date.now().toString(),
      },
      HostConfig: {
        Memory: effectiveMemory * 1024,
        MemorySwap: effectiveMemory * 1024,
        CpuPeriod: 100000,
        CpuQuota: 100000,
        PidsLimit: max_processes_and_or_threads || 64,
        NetworkMode: enable_network ? 'bridge' : 'none',
        ReadonlyRootfs: true,
        SecurityOpt: ['no-new-privileges:true'],
        CapDrop: ['ALL'],
        ...(config.docker.runtime ? { Runtime: config.docker.runtime } : {}),
        Tmpfs: {
          '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
          '/box': `rw,exec,nosuid,size=${boxSize}m,mode=1777`,
          '/home': 'rw,noexec,nosuid,size=16m,mode=1777',
        },
      },
      Tty: false,
      OpenStdin: true,
    });

    await container.start();
    return container;
  }

  /**
   * Poll readiness marker (/box/.ready) until daemon startup completes
   */
  async awaitReadySignal(container, maxWaitMs = 10000) {
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const exec = await container.exec({
          Cmd: ['test', '-f', '/box/.ready'],
          AttachStdout: false,
          AttachStderr: false,
        });

        await new Promise((resolve) => {
          exec.start({}, (err, stream) => {
            if (err) return resolve();
            stream.on('end', resolve);
            stream.resume();
          });
        });

        const inspect = await exec.inspect();
        if (inspect.ExitCode === 0) {
          return;
        }
      } catch {
        // Container might still be starting
      }

      await new Promise(r => setTimeout(r, 25));
    }

    throw new Error(`Timeout waiting for daemon readiness (/box/.ready) after ${maxWaitMs}ms`);
  }

  /**
   * Startup sweep: purge orphaned containers older than 60s
   */
  async startupSweep() {
    await this.sweepOrphans();
  }

  /**
   * Pre-warm pool up to target capacity
   */
  async warmPool() {
    await this.startupSweep();
    for (const languageId of Object.keys(this.pools)) {
      this.checkReplenish(parseInt(languageId, 10));
    }
  }

  /**
   * Graceful shutdown: awaits removal of all tracked, available, in-flight boots, and pending removals
   */
  async shutdown() {
    this.isShuttingDown = true;
    logger.info({ event: 'warm_pool_shutdown_started', instanceId: this.instanceId });

    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer) clearInterval(this.sweepTimer);

    if (this.redis) {
      try {
        await this.redis.del(`worker:heartbeat:${this.instanceId}`);
      } catch {
        // Ignore redis cleanup error
      }
    }

    // Reject all waiting requests immediately
    for (const id of Object.keys(this.pools)) {
      const pool = this.pools[id];
      while (pool.waiters.length > 0) {
        pool.waiters.shift().reject(new Error('Database pool is shutting down'));
      }
    }

    // Trigger removal of all available containers
    for (const id of Object.keys(this.pools)) {
      const pool = this.pools[id];
      while (pool.available.length > 0) {
        const container = pool.available.pop();
        this.destroy(container);
      }
    }

    // Trigger removal of remaining tracked containers
    for (const containerId of this.trackedContainerIds) {
      if (this.docker && this.docker.getContainer) {
        this.destroy(this.docker.getContainer(containerId));
      }
    }
    this.trackedContainerIds.clear();

    // Await all in-flight boots and all pending removals
    await Promise.allSettled([
      ...Array.from(this.inFlightBoots),
      ...Array.from(this.pendingRemovals),
    ]);

    if (!this.customRedis && this.redis) {
      try {
        await this.redis.quit();
      } catch {
        // Ignore quit error
      }
    }

    logger.info({ event: 'warm_pool_shutdown_completed' });
  }
}

// Singleton instance
let warmPoolInstance = null;

export function getWarmPool(docker, options = {}) {
  if (!warmPoolInstance) {
    warmPoolInstance = new WarmContainerPool(docker, options);
  } else if (options && Object.keys(options).length > 0) {
    warmPoolInstance.updateOptions(options);
  }
  return warmPoolInstance;
}

export function _resetWarmPool() {
  warmPoolInstance = null;
}

// Backward-compatibility aliases
export const DatabaseContainerPool = WarmContainerPool;
export const getDatabasePool = getWarmPool;
export const _resetDatabasePool = _resetWarmPool;
export const LanguageContainerPool = WarmContainerPool;
export const getLanguagePool = getWarmPool;

export default {
  WarmContainerPool,
  getWarmPool,
  _resetWarmPool,
  DatabaseContainerPool,
  getDatabasePool,
  _resetDatabasePool,
  LanguageContainerPool,
  getLanguagePool,
};
