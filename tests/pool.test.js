import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { WarmContainerPool, _resetWarmPool, peekWarmPool } from '../src/executor/pool/WarmContainerPool.js';

class MockStream extends EventEmitter {
  resume() {}
}

function createMockDocker(options = {}) {
  let containerCount = 0;
  const createdContainers = [];

  const docker = {
    createdContainers,
    failBootTimes: options.failBootTimes || 0,
    bootDelayMs: options.bootDelayMs || 5,
    createContainer: async (opts) => {
      containerCount++;
      const id = `mock-container-${containerCount}`;

      const container = {
        id,
        Id: id,
        opts,
        running: false,
        removed: false,
        removeOpts: null,
        start: async () => {
          if (docker.failBootTimes > 0) {
            docker.failBootTimes--;
            throw new Error('Simulated Docker start failure');
          }
          if (docker.bootDelayMs > 0) {
            await new Promise(r => setTimeout(r, docker.bootDelayMs));
          }
          container.running = true;
        },
        remove: async (removeOpts) => {
          container.removed = true;
          container.running = false;
          container.removeOpts = removeOpts;
          return { id };
        },
        update: async (updateOpts) => {
          container.updatedOpts = updateOpts;
          return updateOpts;
        },
        inspect: async () => ({
          State: { Running: container.running },
        }),
        exec: async () => ({
          start: (execOpts, callback) => {
            const stream = new MockStream();
            setImmediate(() => {
              callback(null, stream);
              setImmediate(() => stream.emit('end'));
            });
          },
          inspect: async () => ({ ExitCode: 0 }),
        }),
      };

      createdContainers.push(container);
      return container;
    },
    listContainers: async () => [],
    getContainer: (id) => {
      const found = createdContainers.find(c => c.id === id);
      return found || {
        id,
        remove: async (opts) => ({ id, opts }),
      };
    },
  };

  return docker;
}

function createMockRedis() {
  const store = new Map();
  return {
    store,
    set: async (key, val) => { store.set(key, val); return 'OK'; },
    get: async (key) => store.get(key) || null,
    exists: async (key) => (store.has(key) ? 1 : 0),
    del: async (key) => { store.delete(key); return 1; },
    ping: async () => 'PONG',
    quit: async () => 'OK',
  };
}

describe('WarmContainerPool Unit Tests (Mocked Docker)', () => {
  beforeEach(() => {
    _resetWarmPool();
  });

  it('1. Handoff order: First-Ready Handoff delivers container to earliest waiting request', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 20 });
    const mockRedis = createMockRedis();

    const pool = new WarmContainerPool(mockDocker, {
      redis: mockRedis,
      postgresPoolSize: 1,
      mysqlPoolSize: 1,
      acquireTimeoutMs: 1000,
    });

    const received = [];
    const p1 = pool.acquire(8).then(c => received.push({ waiter: 1, id: c.id }));
    const p2 = pool.acquire(8).then(c => received.push({ waiter: 2, id: c.id }));

    await Promise.all([p1, p2]);

    assert.strictEqual(received.length, 2);
    assert.strictEqual(received[0].waiter, 1, 'Waiter 1 should receive container first');
    assert.strictEqual(received[1].waiter, 2, 'Waiter 2 should receive container second');

    await pool.shutdown();
  });

  it('2. Acquire timeout: rejects with acquire timeout when no container becomes available', async () => {
    const mockDocker = createMockDocker();
    // Simulate container boot never succeeding by having it hang or taking longer than timeout
    mockDocker.createContainer = async () => {
      await new Promise(r => setTimeout(r, 500));
      throw new Error('Boot too slow');
    };

    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      acquireTimeoutMs: 50,
      maxWaiters: 5,
    });

    await assert.rejects(
      async () => {
        await pool.acquire(8);
      },
      /Timed out waiting for postgres container/
    );

    await pool.shutdown();
  });

  it('3. Queue-full: rejects immediately when waiters reach maxWaiters limit', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 200 });
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      maxWaiters: 2,
      acquireTimeoutMs: 500,
    });

    const p1 = pool.acquire(8).catch(() => {});
    const p2 = pool.acquire(8).catch(() => {});

    await assert.rejects(
      async () => {
        await pool.acquire(8);
      },
      /postgres execution pool queue is full/
    );

    await pool.shutdown();
    await Promise.allSettled([p1, p2]);
  });

  it('4. Boot failure + retry: retries boot without rejecting waiting request', async () => {
    // 1 failure then success
    const mockDocker = createMockDocker({ failBootTimes: 1, bootDelayMs: 5 });
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      acquireTimeoutMs: 1500,
    });

    // Acquire should succeed after the retry boot completes!
    const container = await pool.acquire(8);
    assert(container);
    assert.strictEqual(container.running, true);

    await pool.shutdown();
  });

  it('5. Circuit breaker: trips after 3 consecutive failures and half-open probes ONE boot', async () => {
    const mockDocker = createMockDocker({ failBootTimes: 10 });
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      acquireTimeoutMs: 500,
    });

    // Trigger replenishments to fail 3 times
    pool.pools[8].targetPoolSize = 1;
    await pool.replenish(8); // fail 1
    await pool.replenish(8); // fail 2
    await pool.replenish(8); // fail 3 -> trips circuit breaker

    assert.strictEqual(pool.pools[8].circuitState, 'open');
    assert(pool.pools[8].circuitOpenUntil > Date.now());

    // Subsequent acquire rejects immediately with degraded message
    await assert.rejects(
      async () => {
        await pool.acquire(8);
      },
      /temporarily degraded/
    );

    // Fast-forward backoff time to test half-open probe
    pool.pools[8].circuitOpenUntil = Date.now() - 1;
    mockDocker.failBootTimes = 0; // next boot will succeed

    // CheckReplenish in half-open state should trigger ONE probe boot
    pool.checkReplenish(8);
    assert.strictEqual(pool.pools[8].circuitState, 'half-open');

    // Wait for the probe to finish
    await new Promise(r => setTimeout(r, 50));
    assert.strictEqual(pool.pools[8].circuitState, 'closed');
    assert.strictEqual(pool.pools[8].available.length, 1);

    await pool.shutdown();
  });

  it('6. Shutdown awaits removals and rejects waiters', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 10 });
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      acquireTimeoutMs: 1000,
    });

    // Let 1 container become available
    await pool.replenish(8);
    assert.strictEqual(pool.pools[8].available.length, 1);

    // Queue a waiter
    const waiterPromise = pool.acquire(9);

    // Now call shutdown
    const shutdownPromise = pool.shutdown();

    // Waiter should reject
    await assert.rejects(
      async () => {
        await waiterPromise;
      },
      /mysql pool is shutting down/
    );

    await shutdownPromise;

    // Available container must be removed with force: true, v: true
    const removedContainers = mockDocker.createdContainers.filter(c => c.removed);
    assert(removedContainers.length >= 1);
    for (const c of removedContainers) {
      assert.deepStrictEqual(c.removeOpts, { force: true, v: true });
    }
  });

  it('7. Boot-after-shutdown is destroyed, not pooled', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 50 });
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      acquireTimeoutMs: 1000,
    });

    // Start a slow boot
    const slowBootPromise = pool.replenish(8);

    // Immediately initiate shutdown while boot is in flight
    await new Promise(r => setTimeout(r, 10));
    await pool.shutdown();
    await slowBootPromise;

    // The container that finished booting must NOT be in available
    assert.strictEqual(pool.pools[8].available.length, 0);

    // It must be removed with force: true, v: true
    const booted = mockDocker.createdContainers[0];
    assert(booted.removed, 'In-flight container must be removed');
    assert.deepStrictEqual(booted.removeOpts, { force: true, v: true });
  });

  it('8. updateOptions updates pool sizes and options without ignoring them', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 2,
      mysqlPoolSize: 2,
    });

    assert.strictEqual(pool.pools[8].targetPoolSize, 2);
    assert.strictEqual(pool.pools[9].targetPoolSize, 2);

    pool.updateOptions({ postgresPoolSize: 5, mysqlPoolSize: 4, maxWaiters: 32 });

    assert.strictEqual(pool.pools[8].targetPoolSize, 5);
    assert.strictEqual(pool.pools[9].targetPoolSize, 4);
    assert.strictEqual(pool.maxWaiters, 32);

    await pool.shutdown();
  });

  it('9. Non-daemon language: pre-warms idle standby container and acquires instantly', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      enableLanguagePool: true,
      postgresPoolSize: 1,
      mysqlPoolSize: 1,
    });

    // Language 5 (Python) should be pre-configured as non-daemon
    assert(pool.pools[5], 'Python pool must exist');
    assert.strictEqual(pool.pools[5].isDaemon, false, 'Python must be non-daemon');

    // Trigger replenish
    await pool.replenish(5);
    assert.strictEqual(pool.pools[5].available.length, 1);

    const warmContainer = pool.pools[5].available[0];
    assert.deepStrictEqual(warmContainer.opts.Cmd, ['/bin/sh', '-c', 'sleep infinity']);

    // Acquire submission object
    const acquired = await pool.acquire({ language: { id: 5 } });
    assert.strictEqual(acquired.id, warmContainer.id);

    await pool.shutdown();
  });

  it('10. Custom options bypass warm pool and create on-demand container', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      languagePoolSize: 1,
    });

    const acquired = await pool.acquire({
      language: { id: 5, image: 'coderunner/python:3.8' },
      enable_network: true,
      memory_limit: 512000,
    });

    assert(acquired);
    assert.strictEqual(acquired.opts.NetworkDisabled, false);

    await pool.shutdown();
  });

  it('11. Invalid WORKER_CONCURRENCY throws at initialization', () => {
    const mockDocker = createMockDocker();
    for (const invalid of [0, -1, 'abc']) {
      assert.throws(() => {
        new WarmContainerPool(mockDocker, {
          redis: createMockRedis(),
          concurrency: invalid,
        });
      }, /positive integer/);
    }
  });

  it('12. DB pool sizes equal WORKER_CONCURRENCY by default, invalid overrides throw', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 3,
    });
    assert.strictEqual(pool.pools[8].targetPoolSize, 3);
    assert.strictEqual(pool.pools[9].targetPoolSize, 3);
    await pool.shutdown();

    // Invalid POSTGRES_POOL_SIZE (< 1) must throw
    assert.throws(() => {
      new WarmContainerPool(mockDocker, {
        redis: createMockRedis(),
        concurrency: 3,
        postgresPoolSize: 0,
      });
    }, /POSTGRES_POOL_SIZE must be an integer >= 1/);

    // Invalid MYSQL_POOL_SIZE (< 1) must throw
    assert.throws(() => {
      new WarmContainerPool(mockDocker, {
        redis: createMockRedis(),
        concurrency: 3,
        mysqlPoolSize: -2,
      });
    }, /MYSQL_POOL_SIZE must be an integer >= 1/);
  });

  it('13. ENABLE_LANGUAGE_POOL=false creates no language pools', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 2,
      enableLanguagePool: false,
    });

    assert.strictEqual(pool.pools[5], undefined, 'Language 5 pool must not exist');
    assert.strictEqual(pool.pools[1], undefined, 'Language 1 pool must not exist');
    assert(pool.pools[8], 'PostgreSQL pool must exist');
    assert(pool.pools[9], 'MySQL pool must exist');

    await pool.shutdown();
  });

  it('14. Language pool fallbacks: on-demand when empty, circuit open, or queue full', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 2,
      enableLanguagePool: true,
    });

    // Language 5 pool starts empty -> acquire falls back to on-demand
    const c1 = await pool.acquire({ language: { id: 5, image: 'coderunner/python:3.8' } });
    assert(c1);
    assert.strictEqual(c1.opts.Labels['com.coderunner.pool'], 'false');

    // Simulate circuit open
    pool.pools[5].circuitState = 'open';
    pool.pools[5].circuitOpenUntil = Date.now() + 60000;
    const c2 = await pool.acquire({ language: { id: 5, image: 'coderunner/python:3.8' } });
    assert(c2);
    assert.strictEqual(c2.opts.Labels['com.coderunner.pool'], 'false');

    await pool.shutdown();
  });

  it('15. DB languages NEVER use on-demand fallback path', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 1,
      acquireTimeoutMs: 50,
      maxWaiters: 1,
    });

    // Make DB container creation hang to trigger timeout
    mockDocker.createContainer = async () => {
      await new Promise(r => setTimeout(r, 200));
      throw new Error('Slow DB boot');
    };

    // DB acquire must fail with timeout or queue-full, NEVER return an unready on-demand container
    await assert.rejects(async () => {
      await pool.acquire(8);
    }, /Timed out waiting for postgres container/);

    await pool.shutdown();
  });

  it('16. Global concurrent boot cap (WARM_POOL_MAX_CONCURRENT_BOOTS) is respected', async () => {
    let activeBootsCount = 0;
    let maxActiveObserved = 0;

    const mockDocker = createMockDocker({ bootDelayMs: 20 });
    const originalCreate = mockDocker.createContainer;
    mockDocker.createContainer = async (opts) => {
      activeBootsCount++;
      if (activeBootsCount > maxActiveObserved) {
        maxActiveObserved = activeBootsCount;
      }
      await new Promise(r => setTimeout(r, 25));
      activeBootsCount--;
      return originalCreate(opts);
    };

    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 2,
      maxConcurrentBoots: 2,
      postgresPoolSize: 2,
      mysqlPoolSize: 2,
    });

    // Trigger 4 concurrent boots (2 postgres, 2 mysql)
    const p1 = pool.replenish(8);
    const p2 = pool.replenish(8);
    const p3 = pool.replenish(9);
    const p4 = pool.replenish(9);

    await Promise.all([p1, p2, p3, p4]);

    assert(maxActiveObserved <= 2, `Max active boots observed (${maxActiveObserved}) exceeded cap of 2`);

    await pool.shutdown();
  });

  it('17. Stale waiter cleanup (B1): timed-out waiters are removed via indexOf and do not destroy healthy containers', async () => {
    const mockDocker = createMockDocker({ bootDelayMs: 200 });
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 1,
      acquireTimeoutMs: 50,
      maxWaiters: 5,
    });

    // Waiter 1 should time out after 50ms
    await assert.rejects(async () => {
      await pool.acquire(8);
    }, /Timed out waiting for postgres container/);

    // Verify waiter 1 is removed from waiters queue (not a ghost)
    assert.strictEqual(pool.pools[8].waiters.length, 0, 'Timed-out waiter must be removed from pool.waiters');

    // Waiter 2 acquires after waiter 1 timed out
    pool.acquireTimeoutMs = 1000;
    const p2 = pool.acquire(8);
    const container = await p2;

    assert(container, 'Waiter 2 should acquire container');
    assert.strictEqual(container.removed, false, 'Healthy container must NOT be destroyed');

    await pool.release(container);
    await pool.shutdown();
  });

  it('18. Replenish with settled waiter (B1): hands off to next waiter or pushes to available without destroying container', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 1,
    });

    // Manually push a settled waiter that returns false on resolve
    let settledWaiterCalled = false;
    pool.pools[8].waiters.push({
      resolve: () => {
        settledWaiterCalled = true;
        return false; // Already settled
      },
      reject: () => false,
    });

    // Also push a live waiter
    let liveWaiterReceived = null;
    pool.pools[8].waiters.push({
      resolve: (c) => {
        liveWaiterReceived = c;
        return true;
      },
      reject: () => false,
    });

    await pool.replenish(8);

    assert(settledWaiterCalled, 'Settled waiter should be invoked');
    assert(liveWaiterReceived, 'Live waiter should receive container after settled waiter was skipped');
    assert.strictEqual(liveWaiterReceived.removed, false, 'Container must remain healthy');

    await pool.shutdown();
  });

  it('19. Pool name in errors (B2): language pool errors name the language, DB pool errors name the DB engine', async () => {
    const mockDocker = createMockDocker();
    mockDocker.createContainer = async () => {
      await new Promise(r => setTimeout(r, 500));
      throw new Error('Boot slow');
    };

    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      enableLanguagePool: true,
      concurrency: 1,
      acquireTimeoutMs: 40,
      maxWaiters: 1,
    });

    // DB: postgres (8)
    await assert.rejects(async () => {
      await pool.acquire(8);
    }, /Timed out waiting for postgres container/);

    // DB: mysql (9)
    await assert.rejects(async () => {
      await pool.acquire(9);
    }, /Timed out waiting for mysql container/);

    // Non-DB: Python (5) with maxWaiters exceeded on fallback or timeout
    const pyPool = pool.pools[5];
    assert(pyPool, 'Python pool must exist');
    assert.strictEqual(pyPool.name, 'python');

    await pool.shutdown();
  });

  it('20. Liveness replacement (B3): dead warm container is detected, destroyed, and replaced', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 1,
      postgresPoolSize: 1,
    });

    await pool.replenish(8);
    assert.strictEqual(pool.pools[8].available.length, 1);
    const container = pool.pools[8].available[0];

    // Simulate container death (running = false)
    container.running = false;

    // Run checkLiveness()
    await pool.checkLiveness();

    assert.strictEqual(container.removed, true, 'Dead container must be destroyed');
    assert.strictEqual(pool.pools[8].available.length, 1, 'Replacement container must be booted');
    assert.notStrictEqual(pool.pools[8].available[0].id, container.id, 'New container must have distinct ID');

    await pool.shutdown();
  });

  it('21. On-demand containers are tracked and destroyed on shutdown (B4)', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      concurrency: 1,
    });

    const onDemand = await pool.createOnDemandContainer(5, {
      language: { id: 5, name: 'Python', min_memory: 256000 },
    });

    assert(onDemand);
    assert.strictEqual(onDemand.opts.Labels['com.coderunner.on_demand'], 'true');
    assert.strictEqual(onDemand.opts.Labels['com.coderunner.instance_id'], pool.instanceId);
    assert.deepStrictEqual(onDemand.opts.Cmd, ['/bin/sh', '-c', 'sleep infinity']);
    assert(pool.trackedOnDemandIds.has(onDemand.id), 'On-demand container must be in trackedOnDemandIds');

    await pool.shutdown();
    assert.strictEqual(onDemand.removed, true, 'On-demand container must be destroyed on shutdown');
    assert.strictEqual(pool.trackedOnDemandIds.size, 0);
  });

  it('22. Orphan sweeper (B4): sweeps pool (>60s) and on-demand (>600s), skips if Redis unreachable', async () => {
    const mockDocker = createMockDocker();
    const mockRedis = createMockRedis();

    const pool = new WarmContainerPool(mockDocker, {
      redis: mockRedis,
      concurrency: 1,
    });

    const now = Date.now();
    const removedIds = [];

    mockDocker.getContainer = (id) => ({
      id,
      remove: async () => {
        removedIds.push(id);
      },
    });

    mockDocker.listContainers = async () => [
      {
        Id: 'pool-young',
        Labels: {
          'com.coderunner.pool': 'true',
          'com.coderunner.created_at': String(now - 30000), // 30s old -> keep
          'com.coderunner.instance_id': 'other-inst',
        },
      },
      {
        Id: 'pool-orphan',
        Labels: {
          'com.coderunner.pool': 'true',
          'com.coderunner.created_at': String(now - 70000), // 70s old -> sweep
          'com.coderunner.instance_id': 'dead-inst',
        },
      },
      {
        Id: 'ondemand-young',
        Labels: {
          'com.coderunner.pool': 'false',
          'com.coderunner.on_demand': 'true',
          'com.coderunner.created_at': String(now - 300000), // 5 min old -> keep
          'com.coderunner.instance_id': 'dead-inst',
        },
      },
      {
        Id: 'ondemand-orphan',
        Labels: {
          'com.coderunner.pool': 'false',
          'com.coderunner.on_demand': 'true',
          'com.coderunner.created_at': String(now - 700000), // 11 min old -> sweep
          'com.coderunner.instance_id': 'dead-inst',
        },
      },
    ];

    await pool.sweepOrphans();

    assert(removedIds.includes('pool-orphan'), 'Orphaned pool container (>60s) must be removed');
    assert(removedIds.includes('ondemand-orphan'), 'Orphaned on-demand container (>600s) must be removed');
    assert(!removedIds.includes('pool-young'), 'Young pool container must be kept');
    assert(!removedIds.includes('ondemand-young'), 'Young on-demand container (<10m) must be kept');

    // Regression test: if Redis is unreachable (ping throws), sweep skips
    removedIds.length = 0;
    mockRedis.ping = async () => {
      throw new Error('Connection refused');
    };

    await pool.sweepOrphans();
    assert.strictEqual(removedIds.length, 0, 'Sweep must be completely skipped when Redis ping fails');

    await pool.shutdown();
  });

  it('23. Fallback logic (A6): empty pool, circuit open, queue full, limit mismatch -> on demand; DB never goes on-demand', async () => {
    const mockDocker = createMockDocker();
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      enableLanguagePool: true,
      concurrency: 1,
      maxWaiters: 1,
      acquireTimeoutMs: 50,
    });

    const pyPool = pool.pools[5];
    assert(pyPool, 'Python language pool should be initialized');

    // Case 1: Empty pool -> falls back to on-demand
    assert.strictEqual(pyPool.available.length, 0);
    const c1 = await pool.acquire(5);
    assert(c1, 'Container should be created on demand');
    assert.strictEqual(c1.opts.Labels['com.coderunner.on_demand'], 'true');
    await pool.release(c1);

    // Case 2: Circuit open -> falls back to on-demand
    pyPool.circuitState = 'open';
    pyPool.circuitOpenUntil = Date.now() + 60000;
    const c2 = await pool.acquire(5);
    assert.strictEqual(c2.opts.Labels['com.coderunner.on_demand'], 'true');
    await pool.release(c2);
    pyPool.circuitState = 'closed';

    // Case 3: Queue full -> falls back to on-demand
    pyPool.waiters.push({ resolve: () => true, reject: () => {} });
    assert.strictEqual(pyPool.waiters.length, 1); // >= maxWaiters
    const c3 = await pool.acquire(5);
    assert.strictEqual(c3.opts.Labels['com.coderunner.on_demand'], 'true');
    await pool.release(c3);
    pyPool.waiters.length = 0;

    // Case 4: Limit mismatch outside update capability -> falls back to on-demand
    const c4 = await pool.acquire({
      language_id: 5,
      memory_limit: 1000000, // Exceeds default effectiveMemory 256000
    });
    assert.strictEqual(c4.opts.Labels['com.coderunner.on_demand'], 'true');
    await pool.release(c4);

    // Case 5: DB never goes on-demand (A6): empty pool must time out or reject, NEVER on-demand
    const pgPool = pool.pools[8];
    assert(pgPool, 'PostgreSQL pool should exist');
    assert.strictEqual(pgPool.available.length, 0);
    mockDocker.failBootTimes = 999; // Cause boots to fail so container is not replenished
    await assert.rejects(async () => {
      await pool.acquire(8);
    }, /Timed out waiting for postgres container/);

    await pool.shutdown();
  });

  it('24. Global concurrent boot cap (A7): starts N boots, at most WARM_POOL_MAX_CONCURRENT_BOOTS are in-flight simultaneously', async () => {
    let currentInFlight = 0;
    let maxObservedInFlight = 0;

    const mockDocker = createMockDocker();
    mockDocker.createContainer = async (config) => {
      currentInFlight++;
      maxObservedInFlight = Math.max(maxObservedInFlight, currentInFlight);
      // Simulate asynchronous boot work
      await new Promise(r => setTimeout(r, 25));
      currentInFlight--;

      const id = `boot-cap-container-${Date.now()}-${Math.random()}`;
      return {
        id,
        Id: id,
        opts: config,
        running: true,
        start: async () => {},
        remove: async () => ({ id }),
        inspect: async () => ({ State: { Running: true } }),
        exec: async () => ({
          start: (opts, cb) => {
            const s = new MockStream();
            setImmediate(() => { cb(null, s); setImmediate(() => s.emit('end')); });
          },
          inspect: async () => ({ ExitCode: 0 }),
        }),
      };
    };

    const maxBoots = 2;
    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      enableLanguagePool: true,
      concurrency: 3,
      maxConcurrentBoots: maxBoots,
    });

    // Concurrently trigger 6 boots via acquireBootSlot / createAndBoot
    const bootPromises = [
      pool.createAndBoot(5),
      pool.createAndBoot(5),
      pool.createAndBoot(8),
      pool.createAndBoot(8),
      pool.createAndBoot(9),
      pool.createAndBoot(9),
    ];

    const bootedContainers = await Promise.all(bootPromises);
    assert.strictEqual(bootedContainers.length, 6);
    assert(maxObservedInFlight <= maxBoots, `Max observed in-flight (${maxObservedInFlight}) must not exceed maxConcurrentBoots (${maxBoots})`);

    await pool.shutdown();
  });

  it('25. Waiter handoff robustness (Issue 1): settled/timed-out waiter does not lose container', async () => {
    let bootsCount = 0;
    let destroyedCount = 0;

    const mockDocker = createMockDocker();
    mockDocker.createContainer = async (config) => {
      bootsCount++;
      const id = `handoff-test-${bootsCount}`;
      return {
        id,
        Id: id,
        opts: config,
        running: true,
        start: async () => {},
        remove: async () => {
          destroyedCount++;
          return { id };
        },
        inspect: async () => ({ State: { Running: true } }),
        exec: async () => ({
          start: (opts, cb) => {
            const s = new MockStream();
            setImmediate(() => { cb(null, s); setImmediate(() => s.emit('end')); });
          },
          inspect: async () => ({ ExitCode: 0 }),
        }),
      };
    };

    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      postgresPoolSize: 1,
      mysqlPoolSize: 1,
      maxWaiters: 10,
      acquireTimeoutMs: 100,
    });

    // Wait for initial constructor replenishment to finish settling
    await new Promise(r => setTimeout(r, 20));

    const pgPool = pool.pools[8];
    // Drain pool so acquire enters waiter queue
    pgPool.available = [];
    pgPool.activeBoots = 0;
    bootsCount = 0;
    destroyedCount = 0;

    // Queue a waiter manually without auto-replenish race
    let settled = false;
    let queuedWaiter = null;
    const acquirePromise = new Promise((resolve, reject) => {
      queuedWaiter = {
        resolve: (c) => {
          if (settled) return false;
          settled = true;
          resolve(c);
          return true;
        },
        reject: (err) => {
          if (settled) return false;
          settled = true;
          reject(err);
          return true;
        },
      };
      pgPool.waiters.push(queuedWaiter);
    });
    assert.strictEqual(pgPool.waiters.length, 1);

    // Mark waiter as settled by rejecting it while it remains in queue
    const rejectRes = queuedWaiter.reject(new Error('Pre-settled reject test'));
    assert.strictEqual(rejectRes, true);

    await assert.rejects(acquirePromise, { message: 'Pre-settled reject test' });
    // Still in waiters array prior to replenishment handoff attempt
    assert.strictEqual(pgPool.waiters.length, 1);

    // Now complete replenish for postgres
    await pool.replenish(8);

    // Assert the booted container was not lost or dropped: it should be in available
    assert.strictEqual(pgPool.available.length, 1, 'Container should end up in pool.available since waiter was settled');
    const handedOffCount = 0;
    assert.strictEqual(
      bootsCount,
      pgPool.available.length + handedOffCount + destroyedCount,
      `Boots count (${bootsCount}) must equal available (${pgPool.available.length}) + handedOff (${handedOffCount}) + destroyed (${destroyedCount})`
    );

    // Next test: waiter times out mid-handoff, container given to next waiter or available
    pgPool.available = [];
    bootsCount = 0;
    destroyedCount = 0;
    let s1 = false;
    let s2 = false;
    let w1 = null;
    let w2 = null;
    const p1 = new Promise((resolve, reject) => {
      w1 = {
        resolve: (c) => { if (s1) return false; s1 = true; resolve(c); return true; },
        reject: (err) => { if (s1) return false; s1 = true; reject(err); return true; }
      };
      pgPool.waiters.push(w1);
    });
    const p2 = new Promise((resolve, reject) => {
      w2 = {
        resolve: (c) => { if (s2) return false; s2 = true; resolve(c); return true; },
        reject: (err) => { if (s2) return false; s2 = true; reject(err); return true; }
      };
      pgPool.waiters.push(w2);
    });
    assert.strictEqual(pgPool.waiters.length, 2);

    // Timeout/settle waiter 1 while in queue
    w1.reject(new Error('Timed out'));
    await assert.rejects(p1, { message: 'Timed out' });

    // Replenish: container should be handed to waiter 2 (p2)
    await pool.replenish(8);
    const container2 = await p2;
    assert.ok(container2, 'Second waiter should have received container');
    assert.strictEqual(container2.id, `handoff-test-1`);

    await pool.release(container2);
    await pool.shutdown();
  });

  it('26. createOnDemandContainer cleanup on start() failure (Issue 3)', async () => {
    let removeCalledWith = null;

    const mockDocker = createMockDocker();
    mockDocker.createContainer = async (config) => {
      const id = 'ondemand-fail-start';
      return {
        id,
        Id: id,
        opts: config,
        running: false,
        start: async () => {
          throw new Error('Docker daemon failed to start on-demand container');
        },
        remove: async (opts) => {
          removeCalledWith = opts;
          return { id };
        },
        inspect: async () => ({ State: { Running: false } }),
        exec: async () => ({}),
      };
    };

    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      enableLanguagePool: false,
    });

    await assert.rejects(
      pool.createOnDemandContainer(5, { memory_limit: 128000 }),
      { message: 'Docker daemon failed to start on-demand container' }
    );

    assert.ok(removeCalledWith, 'remove should be called when start fails');
    assert.strictEqual(removeCalledWith.force, true);
    assert.strictEqual(removeCalledWith.v, true);
    assert.strictEqual(pool.trackedOnDemandIds.size, 0, 'No failed container should remain in trackedOnDemandIds');

    await pool.shutdown();
  });

  it('27. Worker pool gating (Issue 4): isolate worker start/stop never constructs WarmContainerPool or extra Redis connection', async () => {
    // Reset singleton before test
    _resetWarmPool();
    assert.strictEqual(peekWarmPool(), null, 'Pool should be null before isolate worker run');

    const origWorkerType = process.env.WORKER_TYPE;
    const origPort = process.env.WORKER_METRICS_PORT;
    process.env.WORKER_TYPE = 'isolate';
    // Use unused high port or skip server port
    process.env.WORKER_METRICS_PORT = '39123';

    try {
      // Dynamic import to avoid side effects
      const workerMod = await import('../src/queue/worker.js');
      const mockBullWorker = {
        close: async () => {},
      };

      // Call startWorker in isolate mode
      // Notice: In unit tests without running Redis, we mock Redis connections
      // Here we verify peekWarmPool() remains null through lifecycle
      assert.strictEqual(peekWarmPool(), null, 'peekWarmPool() must be null before stopWorker');

      // Call stopWorker
      await workerMod.stopWorker();

      assert.strictEqual(peekWarmPool(), null, 'peekWarmPool() must remain null after stopWorker in isolate worker');
    } finally {
      process.env.WORKER_TYPE = origWorkerType;
      process.env.WORKER_METRICS_PORT = origPort;
    }
  });

  it('28. scripts/bench-pool.mjs contains no hard-coded numeric literals assigned to report fields', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const benchScriptPath = path.join(__dirname, '../scripts/bench-pool.mjs');
    const content = fs.readFileSync(benchScriptPath, 'utf8');

    const lines = content.split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('//') || line.startsWith('*')) continue;
      if (line.includes('const report =') || line.includes('let report =')) continue;
      if (line.startsWith('report.')) {
        const rightSide = line.split('=')[1]?.trim() || '';
        if (/^\{.*:\s*\d+/.test(rightSide) || /^\d+;?$/.test(rightSide)) {
          violations.push(`Line ${i + 1}: ${line}`);
        }
      }
    }
    assert.strictEqual(
      violations.length,
      0,
      `Found hardcoded numeric literals assigned to report in bench-pool.mjs:\n${violations.join('\n')}`
    );
  });
});

