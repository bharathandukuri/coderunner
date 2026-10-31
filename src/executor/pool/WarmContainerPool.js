import Docker from 'dockerode';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import config, { getPoolConcurrency } from '../../utils/config.js';
import logger from '../../utils/logger.js';
import { createDockerClient } from '../../utils/dockerClient.js';
import { getLanguageById, getAllLanguages } from '../../languages/index.js';
import { buildContainerConfig } from '../containerConfig.js';
import {
  recordPoolDepth,
  recordPoolWaiters,
  recordPoolBootDuration,
  recordPoolBootFailure,
  recordPoolAcquireWait,
  recordPoolCircuitState,
} from '../../api/metrics.js';

export { getPoolConcurrency };

export class WarmContainerPool {
  constructor(docker, options = {}) {
    this.docker = docker || createDockerClient();
    this.customRedis = !!options.redis;
    this.redis = options.redis || (config.redis?.url ? new Redis(config.redis.url) : null);

    this.instanceId = options.instanceId || process.env.INSTANCE_ID || `worker-${uuidv4().slice(0, 8)}`;
    this.workerSlotId = this.instanceId;

    // A2: Concurrency from getPoolConcurrency(), must be a positive integer
    const baseConcurrency = options.concurrency !== undefined ? Number(options.concurrency) : getPoolConcurrency();
    if (!Number.isInteger(baseConcurrency) || baseConcurrency <= 0) {
      throw new Error(`Pool concurrency must be a positive integer, got ${baseConcurrency}`);
    }

    // A3: DB pools size = WORKER_CONCURRENCY for each engine, overrides must be integers >= 1
    const rawPg = options.postgresPoolSize !== undefined ? options.postgresPoolSize : process.env.POSTGRES_POOL_SIZE;
    if (rawPg !== undefined && rawPg !== null) {
      const parsedPg = Number(rawPg);
      if (!Number.isInteger(parsedPg) || parsedPg < 1) {
        throw new Error(`POSTGRES_POOL_SIZE must be an integer >= 1, got ${rawPg}`);
      }
      this.postgresPoolSize = parsedPg;
    } else {
      this.postgresPoolSize = baseConcurrency;
    }

    const rawMy = options.mysqlPoolSize !== undefined ? options.mysqlPoolSize : process.env.MYSQL_POOL_SIZE;
    if (rawMy !== undefined && rawMy !== null) {
      const parsedMy = Number(rawMy);
      if (!Number.isInteger(parsedMy) || parsedMy < 1) {
        throw new Error(`MYSQL_POOL_SIZE must be an integer >= 1, got ${rawMy}`);
      }
      this.mysqlPoolSize = parsedMy;
    } else {
      this.mysqlPoolSize = baseConcurrency;
    }

    if (options.poolSize !== undefined) {
      const parsed = Number(options.poolSize);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`poolSize must be an integer >= 1, got ${options.poolSize}`);
      }
      this.targetPoolSize = parsed;
      if (rawPg === undefined) this.postgresPoolSize = parsed;
      if (rawMy === undefined) this.mysqlPoolSize = parsed;
    } else {
      this.targetPoolSize = baseConcurrency;
    }

    // A7: Global cap on concurrent boots across all pools (env WARM_POOL_MAX_CONCURRENT_BOOTS, default 3)
    const rawMaxBoots = process.env.WARM_POOL_MAX_CONCURRENT_BOOTS || options.maxConcurrentBoots || '3';
    const parsedMaxBoots = Number(rawMaxBoots);
    this.maxConcurrentBoots = (Number.isInteger(parsedMaxBoots) && parsedMaxBoots > 0) ? parsedMaxBoots : 3;
    this.currentConcurrentBoots = 0;
    this.bootSlotWaiters = [];

    this.maxWaiters = parseInt(process.env.POOL_MAX_WAITERS || options.maxWaiters || '16', 10);
    this.acquireTimeoutMs = parseInt(process.env.POOL_ACQUIRE_TIMEOUT_MS || options.acquireTimeoutMs || '10000', 10);

    this.trackedContainerIds = new Set();
    this.trackedOnDemandIds = new Set();
    this.inFlightBoots = new Set();
    this.pendingRemovals = new Set();
    this.isShuttingDown = false;

    // Supported warm pool languages (database engines)
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

    // A4: Language pools opt-in via ENABLE_LANGUAGE_POOL (default false)
    const enableLanguagePool = options.enableLanguagePool !== undefined
      ? Boolean(options.enableLanguagePool)
      : (process.env.ENABLE_LANGUAGE_POOL === 'true');
    this.enableLanguagePool = enableLanguagePool;

    if (this.enableLanguagePool) {
      const allLangs = getAllLanguages();
      const nonDbLangs = allLangs.filter(l => l.category !== 'database' && !l.is_archived);

      // Group by image so languages sharing an image share one pool
      const imageGroups = new Map();
      for (const lang of nonDbLangs) {
        if (!imageGroups.has(lang.image)) {
          imageGroups.set(lang.image, []);
        }
        imageGroups.get(lang.image).push(lang);
      }

      for (const [image, langs] of imageGroups) {
        const maxMinMemory = Math.max(...langs.map(l => l.min_memory || 0));
        const effectiveMemory = Math.max(maxMinMemory, 256000);
        const maxPidsLimit = Math.max(...langs.map(l => l.pids_limit || 0), 64);
        const boxSize = Math.max(Math.ceil(effectiveMemory / 1024), 128);
        const name = langs.map(l => (l.name || '').split(/[\s(]/)[0].toLowerCase()).join('_');

        const sharedPool = {
          available: [],
          waiters: [],
          activeBoots: 0,
          consecutiveFailures: 0,
          circuitState: 'closed',
          circuitOpenUntil: 0,
          targetPoolSize: baseConcurrency,
          image,
          name,
          isDaemon: false,
          user: null,
          pidsLimit: maxPidsLimit,
          minMemory: maxMinMemory,
          effectiveMemory,
          memoryLimit: effectiveMemory * 1024,
          boxSize,
          languages: langs.map(l => l.id),
        };

        for (const lang of langs) {
          this.pools[lang.id] = sharedPool;
        }
      }
    }

    // A7: Log total idle containers config will create
    const uniquePools = new Set(Object.values(this.pools));
    let totalTargetIdleContainers = 0;
    for (const p of uniquePools) {
      totalTargetIdleContainers += p.targetPoolSize;
    }
    this.totalTargetIdleContainers = totalTargetIdleContainers;
    logger.info({
      event: 'warm_pool_configured',
      totalTargetIdleContainers,
      maxConcurrentBoots: this.maxConcurrentBoots,
      pools: Array.from(uniquePools).map(p => ({ name: p.name, targetPoolSize: p.targetPoolSize })),
    });

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

    // B3: Background liveness check (every 30s)
    this.livenessTimer = setInterval(() => {
      this.checkLiveness().catch(() => {});
    }, 30000);
    this.livenessTimer.unref();
  }

  /**
   * Acquire a slot under the global concurrent boot cap (A7)
   */
  async acquireBootSlot() {
    if (this.currentConcurrentBoots < this.maxConcurrentBoots) {
      this.currentConcurrentBoots++;
      return;
    }
    return new Promise((resolve) => {
      this.bootSlotWaiters.push(resolve);
    });
  }

  /**
   * Release a slot under the global concurrent boot cap (A7)
   */
  releaseBootSlot() {
    if (this.bootSlotWaiters.length > 0) {
      const next = this.bootSlotWaiters.shift();
      next();
    } else {
      this.currentConcurrentBoots = Math.max(0, this.currentConcurrentBoots - 1);
    }
  }

  /**
   * Update pool configuration dynamically
   */
  updateOptions(options = {}) {
    if (options.concurrency !== undefined) {
      const parsed = Number(options.concurrency);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`concurrency must be an integer >= 1, got ${options.concurrency}`);
      }
    }
    if (options.postgresPoolSize !== undefined) {
      const parsed = Number(options.postgresPoolSize);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`POSTGRES_POOL_SIZE must be an integer >= 1, got ${options.postgresPoolSize}`);
      }
      this.postgresPoolSize = parsed;
      if (this.pools[8]) this.pools[8].targetPoolSize = this.postgresPoolSize;
    }
    if (options.mysqlPoolSize !== undefined) {
      const parsed = Number(options.mysqlPoolSize);
      if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`MYSQL_POOL_SIZE must be an integer >= 1, got ${options.mysqlPoolSize}`);
      }
      this.mysqlPoolSize = parsed;
      if (this.pools[9]) this.pools[9].targetPoolSize = this.mysqlPoolSize;
    }
    if (options.poolSize !== undefined) {
      const ps = Number(options.poolSize);
      if (!Number.isInteger(ps) || ps < 1) {
        throw new Error(`poolSize must be an integer >= 1, got ${options.poolSize}`);
      }
      this.targetPoolSize = ps;
      if (options.postgresPoolSize === undefined && this.pools[8]) this.pools[8].targetPoolSize = ps;
      if (options.mysqlPoolSize === undefined && this.pools[9]) this.pools[9].targetPoolSize = ps;
    }
    if (options.maxWaiters !== undefined) {
      this.maxWaiters = parseInt(options.maxWaiters, 10);
    }
    if (options.acquireTimeoutMs !== undefined) {
      this.acquireTimeoutMs = parseInt(options.acquireTimeoutMs, 10);
    }

    if (!this.isShuttingDown) {
      const uniquePools = new Set(Object.values(this.pools));
      for (const pool of uniquePools) {
        if (pool.languages && pool.languages.length > 0) {
          this.checkReplenish(pool.languages[0]);
        } else if (pool.name === 'postgres') {
          this.checkReplenish(8);
        } else if (pool.name === 'mysql') {
          this.checkReplenish(9);
        }
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
   * Sweep orphaned containers older than threshold without an active Redis heartbeat (B4)
   * Pool containers: age > 60s
   * On-demand containers: age > 600s (10 min)
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
      // Find containers with com.coderunner.instance_id or com.coderunner.pool
      const listInstance = await this.docker.listContainers({
        all: true,
        filters: { label: ['com.coderunner.instance_id'] },
      }).catch(() => []);
      const listPool = await this.docker.listContainers({
        all: true,
        filters: { label: ['com.coderunner.pool'] },
      }).catch(() => []);

      const seen = new Set();
      const list = [];
      for (const info of [...(Array.isArray(listInstance) ? listInstance : []), ...(Array.isArray(listPool) ? listPool : [])]) {
        const id = info.Id || info.id;
        if (id && !seen.has(id)) {
          seen.add(id);
          list.push(info);
        }
      }

      const now = Date.now();
      for (const info of list) {
        const labels = info.Labels || {};
        const createdAt = parseInt(labels['com.coderunner.created_at'] || '0', 10) || (info.Created ? info.Created * 1000 : 0);
        const ageMs = now - createdAt;

        const isPool = labels['com.coderunner.pool'] === 'true';
        const thresholdMs = isPool ? 60000 : 600000;

        if (ageMs > thresholdMs) {
          const id = info.Id || info.id;
          const instId = labels['com.coderunner.instance_id'] || labels['com.coderunner.worker_slot'];
          if (!instId) {
            logger.info({ event: 'sweep_removing_unlabeled_orphan', id, ageMs });
            const c = this.docker.getContainer(id);
            await c.remove({ force: true, v: true }).catch(() => {});
            continue;
          }

          let alive = true;
          try {
            const exists = await this.redis.exists(`worker:heartbeat:${instId}`);
            alive = (exists === 1);
          } catch (err) {
            logger.warn({ event: 'sweep_heartbeat_check_failed', id, instId, error: err.message });
            continue;
          }

          if (!alive) {
            logger.info({ event: 'sweep_removing_orphan', id, instId, ageMs, isPool });
            const c = this.docker.getContainer(id);
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
    let languageId;
    let submission = null;

    if (typeof languageIdOrSubmission === 'object' && languageIdOrSubmission !== null) {
      submission = languageIdOrSubmission;
      languageId = submission.language?.id ?? submission.language_id;
    } else {
      languageId = parseInt(languageIdOrSubmission, 10);
    }

    const lang = (submission && submission.language) || getLanguageById(languageId);
    const pool = this.pools[languageId];

    if (this.isShuttingDown) {
      const pName = pool?.name || (lang?.name ? lang.name.toLowerCase() : 'Container');
      throw new Error(`${pName} pool is shutting down`);
    }

    const isDbDaemon = pool ? Boolean(pool.isDaemon) : Boolean(lang && lang.category === 'database' && lang.is_daemon);

    if (isDbDaemon && !pool) {
      throw new Error(`No container pool configured for language ${languageId}`);
    }

    // A6: On-demand fallback (language containers only)
    if (!isDbDaemon) {
      if (!pool) {
        return await this.createOnDemandContainer(languageId, submission);
      }

      // Check if request limits are outside what container.update can express (C4 / A6)
      const reqMem = submission && submission.memory_limit;
      const exceedsPool = reqMem && reqMem > (pool.effectiveMemory || 256000);
      const isUnexpressibleMem = reqMem && reqMem < 4096; // Docker minimum limit is 4MB
      const isCustom = submission && (
        submission.enable_network ||
        exceedsPool ||
        isUnexpressibleMem
      );
      const poolEmpty = pool.available.length === 0;
      const circuitOpen = pool.circuitState === 'open' && Date.now() < pool.circuitOpenUntil;
      const queueFull = pool.waiters.length >= this.maxWaiters;

      if (isCustom || poolEmpty || circuitOpen || queueFull) {
        if (poolEmpty && !circuitOpen) {
          this.checkReplenish(languageId);
        }
        return await this.createOnDemandContainer(languageId, submission);
      }
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
          if (!isDbDaemon && submission) {
            await this.applyResourceLimits(container, submission, lang);
          }
          return container;
        }
      } catch {
        // Container dead or gone
      }

      this.destroy(container);
      this.checkReplenish(languageId);
    }

    // If a non-db pool became empty after dead containers, fall back to on-demand per A6
    if (!isDbDaemon) {
      this.checkReplenish(languageId);
      return await this.createOnDemandContainer(languageId, submission);
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
        throw new Error(`Execution service for ${pool.name} is temporarily degraded (circuit breaker OPEN). Please try again shortly.`);
      }
    }

    // 3. Queue-full Backpressure Protection
    if (pool.waiters.length >= this.maxWaiters) {
      throw new Error(`${pool.name} execution pool queue is full (${pool.waiters.length} waiters). Cannot accept more requests.`);
    }

    // 4. Enqueue waiter with timeout (B1 fix: object-based waiter and indexOf)
    return new Promise((resolve, reject) => {
      let settled = false;
      let waiter = null;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;

        if (waiter) {
          const idx = pool.waiters.indexOf(waiter);
          if (idx !== -1) {
            pool.waiters.splice(idx, 1);
            recordPoolWaiters(pool.name, pool.waiters.length);
          }
        }
        reject(new Error(`Timed out waiting for ${pool.name} container (${this.acquireTimeoutMs}ms)`));
      }, this.acquireTimeoutMs);

      waiter = {
        resolve: (container) => {
          if (settled) {
            return false;
          }
          settled = true;
          clearTimeout(timer);
          recordPoolAcquireWait(pool.name, (Date.now() - acquireStart) / 1000);
          if (!isDbDaemon && submission) {
            this.applyResourceLimits(container, submission, lang)
              .then(() => resolve(container))
              .catch(() => resolve(container));
          } else {
            resolve(container);
          }
          return true;
        },
        reject: (err) => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          const idx = pool.waiters.indexOf(waiter);
          if (idx !== -1) {
            pool.waiters.splice(idx, 1);
            recordPoolWaiters(pool.name, pool.waiters.length);
          }
          reject(err);
          return true;
        },
      };

      pool.waiters.push(waiter);
      recordPoolWaiters(pool.name, pool.waiters.length);

      this.checkReplenish(languageId);
    });
  }

  /**
   * Apply request resource limits to a claimed pooled container via container.update (C4)
   */
  async applyResourceLimits(container, submission, lang) {
    if (!container || !submission) return;
    const updateOpts = {};
    const reqMemKb = submission.memory_limit != null
      ? Math.max(submission.memory_limit, lang?.min_memory || 0)
      : null;
    const reqPids = submission.max_processes_and_or_threads;

    if (reqMemKb != null && reqMemKb > 0) {
      const bytes = reqMemKb * 1024;
      updateOpts.Memory = bytes;
      updateOpts.MemorySwap = bytes;
    }
    if (reqPids != null && reqPids > 0) {
      updateOpts.PidsLimit = reqPids;
    }

    if (Object.keys(updateOpts).length > 0 && typeof container.update === 'function') {
      try {
        await container.update(updateOpts);
      } catch (err) {
        logger.warn({ event: 'container_update_failed', id: container.id, error: err.message });
      }
    }
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
      this.trackedOnDemandIds.delete(containerId);
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
   * Background liveness check: inspects available containers every 30s and replaces dead ones (B3)
   */
  async checkLiveness() {
    if (this.isShuttingDown || !this.docker) return;
    const uniquePools = new Set(Object.values(this.pools));

    for (const pool of uniquePools) {
      if (!pool.available || pool.available.length === 0) continue;

      const langId = (pool.languages && pool.languages[0]) || (pool.name === 'postgres' ? 8 : (pool.name === 'mysql' ? 9 : null));

      const candidates = [...pool.available];
      for (const container of candidates) {
        let isAlive = false;
        try {
          const inspect = await container.inspect();
          if (inspect && inspect.State && inspect.State.Running) {
            isAlive = true;
          }
        } catch {
          isAlive = false;
        }

        if (!isAlive) {
          const idx = pool.available.indexOf(container);
          if (idx !== -1) {
            pool.available.splice(idx, 1);
            recordPoolDepth(pool.name, pool.available.length);
          }
          this.destroy(container);
          if (langId !== null && !this.isShuttingDown) {
            await this.replenish(langId).catch(() => {});
          }
        }
      }
    }
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

    // First-Ready Handoff: deliver to earliest waiting request (B1)
    let handedOff = false;
    while (pool.waiters.length > 0) {
      const waiter = pool.waiters.shift();
      recordPoolWaiters(pool.name, pool.waiters.length);
      if (waiter.resolve(container)) {
        handedOff = true;
        this.checkReplenish(languageId);
        break;
      }
    }

    if (!handedOff) {
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

    await this.acquireBootSlot();
    let container = null;
    const isDaemon = !!pool.isDaemon;

    try {
      const containerConfig = buildContainerConfig({
        language: getLanguageById(languageId),
        pool,
        instanceId: this.instanceId,
        isDaemon,
        isPool: true,
      });

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
    } finally {
      this.releaseBootSlot();
    }
  }

  /**
   * Backward-compatibility alias for tests and benchmarks
   */
  async createAndBootDaemon(languageId) {
    return this.createAndBoot(languageId);
  }

  /**
   * Create an isolated on-demand container for unpooled or custom submissions (C3)
   */
  async createOnDemandContainer(languageId, submission = {}) {
    const sub = submission || {};
    const lang = sub.language || getLanguageById(languageId);
    const containerConfig = buildContainerConfig({
      language: lang,
      submission: sub,
      instanceId: this.instanceId,
      isDaemon: Boolean(lang && lang.category === 'database' && lang.is_daemon),
      isPool: false,
    });

    let container = null;
    try {
      container = await this.docker.createContainer(containerConfig);
      await container.start();
      if (container && container.id) {
        this.trackedOnDemandIds.add(container.id);
      }
      return container;
    } catch (err) {
      if (container && typeof container.remove === 'function') {
        try {
          await container.remove({ force: true, v: true });
        } catch {
          // Ignore remove failure during cleanup
        }
      }
      throw err;
    }
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
  async warmPool(workerType) {
    if (workerType === 'isolate') return;
    await this.startupSweep();
    const uniquePools = new Set();
    for (const [idStr, pool] of Object.entries(this.pools)) {
      const languageId = parseInt(idStr, 10);
      const isDb = Boolean(pool.isDaemon);
      if (workerType === 'db' && !isDb) continue;
      if (!uniquePools.has(pool)) {
        uniquePools.add(pool);
        this.checkReplenish(languageId);
      }
    }
  }

  /**
   * Graceful shutdown: awaits removal of all tracked, available, in-flight boots, and pending removals
   */
  async shutdown() {
    this.isShuttingDown = true;
    logger.info({ event: 'warm_pool_shutdown_started', instanceId: this.instanceId });

    while (this.bootSlotWaiters && this.bootSlotWaiters.length > 0) {
      const next = this.bootSlotWaiters.shift();
      next();
    }

    if (this.livenessTimer) clearInterval(this.livenessTimer);
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
        pool.waiters.shift().reject(new Error(`${pool.name} pool is shutting down`));
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

    // Trigger removal of remaining tracked on-demand containers (B4)
    for (const containerId of this.trackedOnDemandIds) {
      if (this.docker && this.docker.getContainer) {
        this.destroy(this.docker.getContainer(containerId));
      }
    }
    this.trackedOnDemandIds.clear();

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

export function peekWarmPool() {
  return warmPoolInstance;
}

export function _resetWarmPool() {
  warmPoolInstance = null;
}

export default {
  WarmContainerPool,
  getWarmPool,
  peekWarmPool,
  _resetWarmPool,
  getPoolConcurrency,
};
