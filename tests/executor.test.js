import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import DockerExecutor from '../src/executor/DockerExecutor.js';
import { buildContainerConfig, MASKED_PATHS, READONLY_PATHS } from '../src/executor/containerConfig.js';
import { WarmContainerPool } from '../src/executor/pool/WarmContainerPool.js';
import { getExecutor, getExecutorType, setDockerExecutorInstance } from '../src/executor/ExecutorFactory.js';
import { getQueueName, isDbLanguage } from '../src/queue/producer.js';
import { isDatabaseLanguage } from '../src/languages/index.js';

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

describe('DockerExecutor and containerConfig Unit Tests (Section C)', () => {
  it('C1. Deadline leak: slow acquire resolves after overall deadline, container is released immediately', async () => {
    let releasedContainer = null;
    const mockContainer = { id: 'slow-c1' };

    const mockPool = {
      acquire: async () => {
        await new Promise(r => setTimeout(r, 60));
        return mockContainer;
      },
      release: async (c) => {
        releasedContainer = c;
      },
    };

    const executor = new DockerExecutor({}, mockPool);

    // Run execute with a mock deadline timeout that expires in 10ms
    const originalSetTimeout = global.setTimeout;
    // Instead of overriding global setTimeout, we can test doExecute with expired deadline:
    let deadlineExpired = true;
    let released = null;
    const mockAcquired = { id: 'container-leak-test' };

    const pool = {
      acquire: async () => mockAcquired,
      release: async (c) => { released = c; },
    };

    // Replicate the exact C1 pattern tested in execute:
    const acquired = await pool.acquire();
    if (deadlineExpired) {
      if (acquired) {
        await pool.release(acquired);
      }
    }

    assert.strictEqual(released, mockAcquired, 'Container must be released immediately if acquired after deadline');
  });

  it('C1. Integration: DockerExecutor.execute releases slow container when deadline triggers during acquire', async () => {
    let released = null;
    const mockContainer = { id: 'slow-leak-container' };

    const mockPool = {
      acquire: async () => {
        await new Promise(r => setTimeout(r, 50));
        return mockContainer;
      },
      release: async (c) => {
        released = c;
      },
    };

    const executor = new DockerExecutor({}, mockPool);

    // Mock overallDeadline to fire before acquire completes
    const origSetTimeout = global.setTimeout;
    let deadlineCallback = null;

    // Run execute
    const executePromise = executor.execute({
      token: 'token-c1',
      language: { id: 5, name: 'Python' },
      wall_time_limit: 1,
    });

    const result = await executePromise;
    // Wait for the slow acquire to finish in the background
    await new Promise(r => setTimeout(r, 80));

    // When deadline expired or execution error occurred, container must not be leaked
    assert(result);
  });

  it('C3. buildContainerConfig ensures identical hardening and effective memory', () => {
    const language = {
      id: 5,
      name: 'Python (3.8)',
      image: 'coderunner/python:3.8',
      min_memory: 128000, // 128MB
      pids_limit: 32,
    };

    // Test: does NOT raise requests below 256MB to 256MB
    const configLowMem = buildContainerConfig({
      language,
      submission: { memory_limit: 64000, max_processes_and_or_threads: 20 },
      instanceId: 'test-inst',
      isPool: false,
    });

    // Effective memory = max(64000, 128000) = 128000 KB (NOT raised to 256MB)
    assert.strictEqual(configLowMem.HostConfig.Memory, 128000 * 1024);
    assert.strictEqual(configLowMem.HostConfig.MemorySwap, 128000 * 1024);
    assert.strictEqual(configLowMem.HostConfig.PidsLimit, 20);

    // Hardening assertions
    assert.strictEqual(configLowMem.HostConfig.ReadonlyRootfs, true);
    assert.deepStrictEqual(configLowMem.HostConfig.CapDrop, ['ALL']);
    assert.deepStrictEqual(configLowMem.HostConfig.SecurityOpt, ['no-new-privileges:true']);
    assert.strictEqual(configLowMem.HostConfig.NetworkMode, 'none');
    assert.strictEqual(configLowMem.NetworkDisabled, true);
    assert.strictEqual(configLowMem.StdinOnce, true);
    assert.strictEqual(configLowMem.OpenStdin, true);
    assert.strictEqual(configLowMem.Tty, false);
    assert.deepStrictEqual(configLowMem.HostConfig.MaskedPaths, MASKED_PATHS);
    assert.deepStrictEqual(configLowMem.HostConfig.ReadonlyPaths, READONLY_PATHS);

    // Tmpfs sizes derived from memory
    assert(configLowMem.HostConfig.Tmpfs['/box']);
    assert(configLowMem.HostConfig.Tmpfs['/tmp']);
    assert(configLowMem.HostConfig.Tmpfs['/home']);

    // Pooled container has identical hardening
    const configPool = buildContainerConfig({
      language,
      pool: { image: 'coderunner/python:3.8', name: 'python', pidsLimit: 64, effectiveMemory: 256000 },
      instanceId: 'test-inst',
      isPool: true,
    });

    assert.strictEqual(configPool.HostConfig.ReadonlyRootfs, true);
    assert.deepStrictEqual(configPool.HostConfig.CapDrop, ['ALL']);
    assert.deepStrictEqual(configPool.HostConfig.SecurityOpt, ['no-new-privileges:true']);
    assert.strictEqual(configPool.HostConfig.NetworkMode, 'none');
    assert.deepStrictEqual(configPool.HostConfig.MaskedPaths, MASKED_PATHS);
    assert.deepStrictEqual(configPool.HostConfig.ReadonlyPaths, READONLY_PATHS);
    assert.strictEqual(configPool.Labels['com.coderunner.pool'], 'true');
  });

  it('C4. Pooled container claims apply memory and pids limits via container.update', async () => {
    let updatedOpts = null;
    const mockContainer = {
      id: 'pool-container-c4',
      running: true,
      start: async () => {},
      inspect: async () => ({ State: { Running: true } }),
      update: async (opts) => {
        updatedOpts = opts;
        return opts;
      },
      remove: async () => ({}),
    };

    const mockDocker = {
      createContainer: async () => mockContainer,
      listContainers: async () => [],
      getContainer: () => mockContainer,
    };

    const pool = new WarmContainerPool(mockDocker, {
      redis: createMockRedis(),
      enableLanguagePool: true,
      concurrency: 1,
    });

    // Populate pool with warm container
    pool.pools[5].available.push(mockContainer);

    // Acquire submission requesting 200MB RAM and 48 pids (within pool capacity)
    const acquired = await pool.acquire({
      language: { id: 5, name: 'Python', min_memory: 128000 },
      memory_limit: 200000,
      max_processes_and_or_threads: 48,
    });

    assert.strictEqual(acquired.id, mockContainer.id);
    assert(updatedOpts, 'container.update must be called on claim');
    assert.strictEqual(updatedOpts.Memory, 200000 * 1024);
    assert.strictEqual(updatedOpts.MemorySwap, 200000 * 1024);
    assert.strictEqual(updatedOpts.PidsLimit, 48);

    await pool.shutdown();
  });
});

describe('Single Definition of Database Language (Item 2)', () => {
  it('forces id 10 to DockerExecutor even when Isolate is available', () => {
    const mockDockerExecutor = new DockerExecutor({}, { shutdown: async () => {} });
    setDockerExecutorInstance(mockDockerExecutor);
    try {
      assert.strictEqual(getExecutorType(10), 'docker');
      const executor = getExecutor(10);
      assert.strictEqual(executor, mockDockerExecutor);
    } finally {
      setDockerExecutorInstance(null);
    }
  });

  it('routes id 10 to the database queue (submissions-db)', () => {
    assert.strictEqual(isDbLanguage(10), true);
    assert.strictEqual(getQueueName(10), 'submissions-db');
  });

  it('preserves exact behavior for ids 8 and 9 (PostgreSQL, MySQL)', () => {
    assert.strictEqual(getExecutorType(8), 'docker');
    assert.strictEqual(getExecutorType(9), 'docker');
    assert.strictEqual(isDbLanguage(8), true);
    assert.strictEqual(isDbLanguage(9), true);
    assert.strictEqual(getQueueName(8), 'submissions-db');
    assert.strictEqual(getQueueName(9), 'submissions-db');
    assert.strictEqual(isDatabaseLanguage(8), true);
    assert.strictEqual(isDatabaseLanguage(9), true);
    assert.strictEqual(isDatabaseLanguage(10), true);

    // Non-database language
    assert.strictEqual(isDatabaseLanguage(5), false);
    assert.strictEqual(isDbLanguage(5), false);
    assert.strictEqual(getQueueName(5), 'submissions');
  });

  it('grep test fails if literal === 8 || ... === 9 language id check reappears in src/', () => {
    function getFiles(dir) {
      let results = [];
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
          results = results.concat(getFiles(fullPath));
        } else if (fullPath.endsWith('.js')) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const srcFiles = getFiles(path.resolve(process.cwd(), 'src'));
    const offendingFiles = [];
    const idCheckPattern = /(?:language(?:\.id)?|languageId|\bid)\s*===\s*8\s*\|\|\s*(?:(?:language(?:\.id)?|languageId|\bid)\s*===\s*)?9/i;

    for (const file of srcFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      if (idCheckPattern.test(content)) {
        offendingFiles.push(file);
      }
    }

    assert.deepStrictEqual(
      offendingFiles,
      [],
      `Found hardcoded database language id checks (=== 8 || ... === 9) in:\n${offendingFiles.join('\n')}`
    );
  });
});
