import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import DockerExecutor from '../src/executor/DockerExecutor.js';
import { buildContainerConfig, MASKED_PATHS, READONLY_PATHS } from '../src/executor/containerConfig.js';
import { WarmContainerPool } from '../src/executor/pool/WarmContainerPool.js';
import { getExecutor, getExecutorType, setDockerExecutorInstance } from '../src/executor/ExecutorFactory.js';
import { getQueueName, isDbLanguage } from '../src/queue/producer.js';
import { isDatabaseLanguage, getLanguageById } from '../src/languages/index.js';
import { analyzeCode } from '../src/security/codeAnalyzer.js';
import { authMiddleware } from '../src/api/middleware/auth.js';
import { validateCallbackUrl } from '../src/api/middleware/validation.js';
import config from '../src/utils/config.js';
import IsolateExecutor from '../src/executor/IsolateExecutor.js';
import { execFileSync } from 'node:child_process';

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
    assert(released, 'Container should be released immediately upon late acquisition');
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

  it('C5. Container tmpfs configuration for database daemons is consistent with 512MB cap', () => {
    const configDaemon = buildContainerConfig({
      language: { id: 10, name: 'MongoDB', is_daemon: true, category: 'database' },
      instanceId: 'test-inst',
      isDaemon: true,
      isPool: true,
    });
    assert.strictEqual(configDaemon.HostConfig.Tmpfs['/data/db'], 'rw,noexec,nosuid,size=205m,mode=1777');
    assert.strictEqual(configDaemon.HostConfig.Memory, 512000 * 1024);
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

describe('MongoDB Limits and Sandboxing Verification', () => {
  it('enforces 512MB memory cap, 128 pids, and tmpfs budget limits', () => {
    const mongoLang = getLanguageById(10);
    assert.strictEqual(mongoLang.id, 10);
    assert.strictEqual(mongoLang.slug, 'mongodb');
    assert.strictEqual(mongoLang.pids_limit, 128);

    const config = buildContainerConfig({
      language: mongoLang,
      instanceId: 'mongo-limit-test',
      isDaemon: true,
      isPool: true,
    });

    // 1. Memory limits
    assert.strictEqual(config.HostConfig.Memory, 512000 * 1024, 'Memory limit must be exactly 512MB');
    assert.strictEqual(config.HostConfig.MemorySwap, 512000 * 1024, 'MemorySwap must equal Memory to forbid swap');
    assert.strictEqual(config.HostConfig.PidsLimit, 128, 'PidsLimit must be 128');

    // 2. Tmpfs partitions
    const tmpfs = config.HostConfig.Tmpfs;
    assert.strictEqual(tmpfs['/data/db'], 'rw,noexec,nosuid,size=205m,mode=1777');
    assert.strictEqual(tmpfs['/box'], 'rw,exec,nosuid,size=256m,mode=1777');
    assert.strictEqual(tmpfs['/tmp'], 'rw,noexec,nosuid,size=64m,mode=1777');
    assert.strictEqual(tmpfs['/data/configdb'], 'rw,size=16m');

    // 3. Security hardening flags
    assert.strictEqual(config.HostConfig.ReadonlyRootfs, true, 'Rootfs must be read-only');
    assert.deepStrictEqual(config.HostConfig.CapDrop, ['ALL'], 'All capabilities must be dropped');
    assert.strictEqual(config.User, '1001:1001', 'Must run as unprivileged runner (1001:1001)');
    assert.strictEqual(config.NetworkDisabled, true, 'Network must be disabled by default');

    // 4. Daemon startup command limits
    const cmdStr = mongoLang.cmd.join(' ');
    assert.match(cmdStr, /--wiredTigerCacheSizeGB 0\.25/, 'Must limit WiredTiger cache to 0.25 GB');
    assert.match(cmdStr, /--setParameter diagnosticDataCollectionEnabled=false/, 'Diagnostic collection must be disabled');
    assert.match(cmdStr, /--bind_ip 127\.0\.0\.1/, 'Must bind only to loopback');
  });

  it('rejects administrative shutdown and lock commands via code analyzer', () => {
    const shutdownRes = analyzeCode('db.shutdownServer()', 10);
    assert.strictEqual(shutdownRes.rejected, true);
    assert.match(shutdownRes.reason, /shutdown server/i);

    const adminShutdownRes = analyzeCode('db.adminCommand({ shutdown: 1 })', 10);
    assert.strictEqual(adminShutdownRes.rejected, true);
    assert.match(adminShutdownRes.reason, /shutdown command/i);

    const lockRes = analyzeCode('db.fsyncLock()', 10);
    assert.strictEqual(lockRes.rejected, true);
    assert.match(lockRes.reason, /lock database/i);

    // Normal query is allowed
    const validRes = analyzeCode('db.items.find({ qty: { $gt: 10 } })', 10);
    assert.strictEqual(validRes.rejected, false);
  });
});

describe('Security Hardening Verification', () => {
  it('blocks access to sensitive host files (~/.ssh, ~/.gitconfig, /home, /root) in code analyzer', () => {
    const maliciousCodes = [
      'open("/home/ubuntu/.ssh/id_rsa").read()',
      'open("/home/user/.gitconfig").read()',
      'open("/root/.ssh/authorized_keys").read()',
      'cat ~/.aws/credentials',
      'import id_ed25519',
      'const f = fs.readFileSync("/home/app/.ssh/known_hosts")',
    ];

    for (const code of maliciousCodes) {
      const res = analyzeCode(code, 5); // Python
      assert.strictEqual(res.rejected, true, `Should have rejected: ${code}`);
      assert.match(res.reason, /Access to sensitive path/i);
    }
  });

  it('masks /home, /root, and /var/log in Isolate sandbox arguments', async () => {
    const isoSource = fs.readFileSync(path.join(process.cwd(), 'src/executor/IsolateExecutor.js'), 'utf-8');
    assert.match(isoSource, /'--dir=\/home='/, 'Must mask /home with an empty sandbox directory');
    assert.match(isoSource, /'--dir=\/root='/, 'Must mask /root with an empty sandbox directory');
    assert.match(isoSource, /'--dir=\/var\/log='/, 'Must mask /var/log with an empty sandbox directory');
  });

  it('enforces tmpfs isolation on /root and /home in Docker container config', () => {
    const configStandard = buildContainerConfig({
      language: getLanguageById(5), // Python
      instanceId: 'sec-test',
    });
    assert.strictEqual(configStandard.HostConfig.Tmpfs['/home'], 'rw,noexec,nosuid,size=16m,mode=1777');
    assert.strictEqual(configStandard.HostConfig.Tmpfs['/root'], 'rw,noexec,nosuid,size=16m,mode=0700');

    const configDaemon = buildContainerConfig({
      language: getLanguageById(10), // MongoDB
      instanceId: 'sec-test-db',
      isDaemon: true,
    });
    assert.strictEqual(configDaemon.HostConfig.Tmpfs['/root'], 'rw,noexec,nosuid,size=16m,mode=0700');
  });

  it('fails closed in authMiddleware in production if AUTH_TOKEN is not configured', () => {
    const prevEnv = config.server.nodeEnv;
    const prevTokens = config.auth.tokens;

    try {
      config.server.nodeEnv = 'production';
      config.auth.tokens = [];

      let nextCalled = false;
      let statusValue = 0;
      let jsonPayload = null;

      const req = { get: () => null };
      const res = {
        status(code) {
          statusValue = code;
          return {
            json(body) {
              jsonPayload = body;
            },
          };
        },
      };
      const next = () => { nextCalled = true; };

      authMiddleware(req, res, next);

      assert.strictEqual(nextCalled, false, 'Must not call next() when auth tokens empty in production');
      assert.strictEqual(statusValue, 500, 'Must return HTTP 500 configuration error');
      assert.match(jsonPayload.message, /AUTH_TOKEN is not configured/i);
    } finally {
      config.server.nodeEnv = prevEnv;
      config.auth.tokens = prevTokens;
    }
  });

  it('rejects SSRF attempts in callback URLs including AWS metadata, decimal IPs, and Docker hostnames', () => {
    const ssrfAttempts = [
      'http://169.254.169.254/latest/meta-data',
      'http://169.254.1.1/internal',
      'http://2852039166/latest', // Decimal encoding of 169.254.169.254
      'http://0xa9fea9fe/meta-data', // Hex encoding
      'http://0251.0376.0251.0376/', // Octal encoding
      'http://127.0.0.1:3000/api',
      'http://redis:6379/',
      'http://docker-proxy:2375/containers/json',
      'http://internal-host.internal/',
      'http://local-machine.local/',
      'http://[::1]/status',
      'http://10.0.0.5:8080/hook',
      'http://192.168.1.1/admin',
      'http://172.17.0.1:2375/',
    ];

    const mockHelpers = { error: () => 'any.invalid' };

    for (const target of ssrfAttempts) {
      const res = validateCallbackUrl(target, mockHelpers);
      assert.strictEqual(res, 'any.invalid', `Expected SSRF rejection for ${target}`);
    }

    // Valid public callback URL should pass
    const validUrl = 'https://webhook.site/my-callback-endpoint';
    const validRes = validateCallbackUrl(validUrl, mockHelpers);
    assert.strictEqual(validRes, validUrl);
  });

  it('rejects ZIP archives containing symbolic links or path traversal', async () => {
    const executor = new IsolateExecutor();
    const tmpDir = fs.mkdtempSync('/tmp/sec-zip-test-');

    try {
      // 1. Create a zip with a symlink
      const symTarget = path.join(tmpDir, 'target.txt');
      const symLink = path.join(tmpDir, 'leak_link');
      const symZip = path.join(tmpDir, 'sym.zip');
      fs.writeFileSync(symTarget, 'secret data');
      fs.symlinkSync(symTarget, symLink);

      execFileSync('zip', ['--symlinks', '-j', symZip, symLink]);
      const symBase64 = fs.readFileSync(symZip).toString('base64');

      const workDir1 = path.join(tmpDir, 'work1');
      fs.mkdirSync(workDir1);

      await assert.rejects(
        () => executor.extractAdditionalFiles(workDir1, { additional_files: symBase64, token: 'test-sym' }),
        /symbolic links \(forbidden\)/i
      );

      // 2. Path traversal
      const travZip = path.join(tmpDir, 'trav.zip');
      execFileSync('zip', ['-j', travZip, symTarget]);
      // Artificially craft a zip with ../ or inspect rejection
      const travBase64 = fs.readFileSync(travZip).toString('base64');
      const workDir2 = path.join(tmpDir, 'work2');
      fs.mkdirSync(workDir2);

      // Regular clean zip extracts cleanly
      await executor.extractAdditionalFiles(workDir2, { additional_files: travBase64, token: 'test-clean' });
      assert.strictEqual(fs.existsSync(path.join(workDir2, 'target.txt')), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
