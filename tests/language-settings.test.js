import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  initLanguageConfig,
  _resetLanguageConfig,
  isLanguageEnabled,
  getLanguagePoolFlag,
  getEnabledLanguages,
  describeLanguagePlan,
  getActiveLanguages,
  getLanguageById,
  getStatusById,
} from '../src/languages/index.js';
import { validateRun, validateBatchRun } from '../src/api/middleware/validation.js';
import { WarmContainerPool } from '../src/executor/pool/WarmContainerPool.js';
import { getExecutor, _resetExecutor } from '../src/executor/ExecutorFactory.js';
import { processJob } from '../src/queue/worker.js';
import metrics, { recordPoolBootDuration, recordPoolAcquireWait } from '../src/api/metrics.js';

class MockStream extends EventEmitter {
  resume() {}
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

function createMockDocker(options = {}) {
  let containerCount = 0;
  const createdContainers = [];

  const docker = {
    createdContainers,
    failBootTimes: options.failBootTimes || 0,
    createContainer: async (opts) => {
      containerCount++;
      const id = `mock-container-${containerCount}`;
      const container = {
        id,
        Id: id,
        opts,
        running: false,
        removed: false,
        start: async () => {
          if (docker.failBootTimes > 0) {
            docker.failBootTimes--;
            throw new Error('Simulated Docker boot failure');
          }
          container.running = true;
        },
        remove: async () => {
          container.removed = true;
          container.running = false;
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
  };
  return docker;
}

describe('Language Enable & Pool Settings (Section 1 & 2)', () => {
  it('1. Strict parsing: valid values set flags, invalid values throw naming the variable', () => {
    // Valid custom config
    initLanguageConfig({
      LANGUAGE_PYTHON_ENABLED: 'true',
      LANGUAGE_PYTHON_POOL: 'true',
      LANGUAGE_POSTGRESQL_ENABLED: 'true',
      LANGUAGE_POSTGRESQL_POOL: 'false',
    }, true);
    assert.strictEqual(isLanguageEnabled('python'), true);
    assert.strictEqual(getLanguagePoolFlag('python'), true);
    assert.strictEqual(isLanguageEnabled('postgresql'), true);
    assert.strictEqual(getLanguagePoolFlag('postgresql'), false);

    // Invalid boolean throws naming the variable
    assert.throws(() => {
      initLanguageConfig({
        LANGUAGE_PYTHON_ENABLED: 'yes',
      }, true);
    }, /LANGUAGE_PYTHON_ENABLED/);

    assert.throws(() => {
      initLanguageConfig({
        LANGUAGE_POSTGRESQL_POOL: '1',
      }, true);
    }, /LANGUAGE_POSTGRESQL_POOL/);

    // ENABLED_LANGUAGES is rejected with helpful message
    assert.throws(() => {
      initLanguageConfig({
        ENABLED_LANGUAGES: 'python,c',
      }, true);
    }, /ENABLED_LANGUAGES is not supported/);

    // Reset to defaults
    _resetLanguageConfig();
    initLanguageConfig(process.env, true);
  });

  it('2. Startup fails if no languages are enabled', () => {
    const allDisabled = {};
    const allLangs = ['c', 'cpp', 'java', 'javascript', 'typescript', 'python', 'sqlite', 'postgresql', 'mysql', 'mongodb'];
    for (const slug of allLangs) {
      allDisabled[`LANGUAGE_${slug.toUpperCase()}_ENABLED`] = 'false';
    }
    assert.throws(() => {
      initLanguageConfig(allDisabled, true);
    }, /At least one language must be enabled/);

    _resetLanguageConfig();
    initLanguageConfig(process.env, true);
  });

  it('3. describeLanguagePlan outputs execution plan table for GET /system and startup', () => {
    _resetLanguageConfig();
    initLanguageConfig(process.env, true);
    const plan = describeLanguagePlan();
    assert(Array.isArray(plan));
    assert(plan.length > 0);
    const pythonPlan = plan.find(p => p.slug === 'python');
    assert.ok(pythonPlan);
    assert.strictEqual(typeof pythonPlan.slug, 'string');
    assert.strictEqual(typeof pythonPlan.executor, 'string');
    assert.ok(['pooled', 'on-demand', 'on-demand-boot'].includes(pythonPlan.strategy));
  });

  it('4. API validation rejects submissions with disabled languages (422 { error, language_id, enabled_languages })', () => {
    initLanguageConfig({
      ...process.env,
      LANGUAGE_PYTHON_ENABLED: 'false',
      LANGUAGE_POSTGRESQL_ENABLED: 'true',
    }, true);

    let status = null;
    let body = null;
    const res = {
      status: (s) => { status = s; return res; },
      json: (b) => { body = b; return res; },
    };

    // Single submission with disabled language
    validateRun({ body: { language_id: 5, source_code: 'print(1)' } }, res, () => {});
    assert.strictEqual(status, 422);
    assert.strictEqual(body.language_id, 5);
    assert.ok(Array.isArray(body.enabled_languages));
    assert(!body.enabled_languages.includes('python'));
    assert(body.enabled_languages.includes('postgresql'));

    // Batch submission containing disabled language is rejected as a whole listing indexes
    let batchStatus = null;
    let batchBody = null;
    const batchRes = {
      status: (s) => { batchStatus = s; return batchRes; },
      json: (b) => { batchBody = b; return batchRes; },
    };
    validateBatchRun({
      body: {
        submissions: [
          { language_id: 8, source_code: 'SELECT 1' },
          { language_id: 5, source_code: 'print(1)' },
        ],
      },
    }, batchRes, () => {});

    assert.strictEqual(batchStatus, 422);
    assert.deepStrictEqual(batchBody.disabled_indexes, [1]);
    assert.ok(Array.isArray(batchBody.enabled_languages));

    _resetLanguageConfig();
    initLanguageConfig(process.env, true);
  });

  it('5. Worker processes job for disabled language gracefully: status 13 and increments metric', async () => {
    initLanguageConfig({
      ...process.env,
      LANGUAGE_PYTHON_ENABLED: 'false',
    }, true);

    const job = {
      id: 'job-dis-1',
      data: {
        token: 'token-dis-1',
        type: 'single',
        language_id: 5,
        source_code: 'print(1)',
      },
    };

    const result = await processJob(job);
    assert.strictEqual(result.status.id, 13, 'Job must end in status 13 (Internal Error)');
    assert.match(result.stderr, /disabled on this worker/);

    const metricsStr = await metrics.register.metrics();
    assert.ok(
      metricsStr.includes('coderunner_disabled_language_jobs_total'),
      'coderunner_disabled_language_jobs_total metric must be recorded'
    );

    _resetLanguageConfig();
    initLanguageConfig(process.env, true);
  });

  it('6. Database POOL=false boots single-use container with daemon config and destroys on release', async () => {
    const mockDocker = createMockDocker();
    const mockRedis = createMockRedis();

    const pool = new WarmContainerPool(mockDocker, {
      redis: mockRedis,
      concurrency: 2,
      languagePoolFlags: {
        postgresql: false, // POOL=false for PostgreSQL
        mysql: true,
      },
    });

    // PostgreSQL has no pool created
    assert.strictEqual(pool.pools[8], undefined, 'No warm pool created for PostgreSQL when POOL=false');
    assert.ok(pool.pools[9], 'MySQL warm pool created when POOL=true');

    // Acquire PostgreSQL container boots single-use container
    const container = await pool.acquire({ language_id: 8 });
    assert.ok(container);
    assert.strictEqual(container.opts.Labels['com.coderunner.on_demand'], 'true');
    assert.strictEqual(container.opts.User, '70:70');
    assert.ok(container.opts.HostConfig.Tmpfs['/data/db'], 'Must have daemon tmpfs mounts');
    assert.notStrictEqual(container.opts.Cmd?.[2], 'sleep infinity', 'Must NEVER use sleep infinity path');

    // Release container destroys it
    await pool.release(container);
    assert.strictEqual(container.removed, true, 'Container must be destroyed on release');

    await pool.shutdown();
  });

  it('7. Shared image pool (C and C++): only languages with POOL=true acquire from pool', async () => {
    const mockDocker = createMockDocker();
    const mockRedis = createMockRedis();

    const pool = new WarmContainerPool(mockDocker, {
      redis: mockRedis,
      concurrency: 2,
      languagePoolFlags: {
        c: true,
        cpp: false,
      },
    });

    // C gets pool
    assert.ok(pool.pools[1], 'Pool created for C');
    // C++ does not acquire from pool
    assert.strictEqual(pool.pools[2], undefined, 'No pool assigned to C++');

    // Pre-warm C container
    await pool.replenish(1);
    assert.strictEqual(pool.pools[1].available.length, 1);

    // C acquires from pool
    const cContainer = await pool.acquire({ language_id: 1 });
    assert.strictEqual(pool.pools[1].available.length, 0);

    // C++ acquires on-demand
    const cppContainer = await pool.acquire({ language_id: 2 });
    assert.strictEqual(cppContainer.opts.Labels['com.coderunner.on_demand'], 'true');

    await pool.release(cContainer);
    await pool.release(cppContainer);
    await pool.shutdown();
  });

  it('8. Metric label mode=pooled|on_demand on boot-time and acquire histograms', async () => {
    recordPoolBootDuration('test-engine', 0.25, 'on_demand');
    recordPoolBootDuration('test-engine', 0.15, 'pooled');
    recordPoolAcquireWait('test-engine', 0.05, 'on_demand');
    recordPoolAcquireWait('test-engine', 0.01, 'pooled');

    const metricsStr = await metrics.register.metrics();
    assert.ok(metricsStr.includes('coderunner_pool_boot_duration_seconds'));
    assert.ok(metricsStr.includes('mode="on_demand"'));
    assert.ok(metricsStr.includes('mode="pooled"'));
    assert.ok(metricsStr.includes('coderunner_pool_acquire_wait_duration_seconds'));
  });

  it('9. On-demand boot failure counts metric and leaks no container', async () => {
    const mockDocker = createMockDocker({ failBootTimes: 1 });
    const mockRedis = createMockRedis();

    const pool = new WarmContainerPool(mockDocker, {
      redis: mockRedis,
      concurrency: 2,
      languagePoolFlags: {
        postgresql: false,
      },
    });

    let threw = false;
    try {
      await pool.acquire({ language_id: 8 });
    } catch (err) {
      threw = true;
      assert.match(err.message, /Simulated Docker boot failure/);
    }
    assert.strictEqual(threw, true, 'Boot failure must throw');

    // Verify container was removed and not leaked
    const created = mockDocker.createdContainers[0];
    assert.ok(created);
    assert.strictEqual(created.removed, true, 'Failed container must be removed');
    assert.strictEqual(pool.trackedOnDemandIds.size, 0, 'No container leaked in trackedOnDemandIds');

    await pool.shutdown();
  });

  it('10. scripts/dev/language-config.mjs outputs enabled languages, images, and sizing', async () => {
    const { execSync } = await import('node:child_process');

    const languagesOut = execSync('node scripts/dev/language-config.mjs languages', { encoding: 'utf-8' }).trim();
    assert.ok(languagesOut.includes('python'));
    assert.ok(languagesOut.includes('postgresql'));

    const imagesOut = execSync('node scripts/dev/language-config.mjs images', { encoding: 'utf-8' }).trim();
    assert.ok(imagesOut.includes('coderunner/python:3.8'));
    assert.ok(imagesOut.includes('coderunner/postgres:16'));

    const sizingOut = execSync('node scripts/dev/language-config.mjs sizing --shell', { encoding: 'utf-8' }).trim();
    assert.match(sizingOut, /MEM_MIN_RECOMMENDED=\d+/);
    assert.match(sizingOut, /WARM_RAM_MB=\d+/);
  });

  it('11. scripts/preflight.sh --sizing-only runs hermetically without Docker', async () => {
    const { execSync } = await import('node:child_process');
    const out = execSync('bash scripts/preflight.sh --sizing-only', { encoding: 'utf-8' }).trim();
    assert.match(out, /Host RAM and CPU Sizing/);
    assert.match(out, /min recommended: \d+MB/);
  });

  it('12. Language 89 removed: submission with language_id 89 returns 422, empty source_code with ZIP returns 422', async () => {
    const { validateSubmission } = await import('../src/api/middleware/validation.js');

    // 1. Language 89 rejected
    let res89Status = null;
    let res89Json = null;
    const req89 = {
      body: {
        source_code: 'print("hello")',
        language_id: 89,
      },
    };
    const res89 = {
      status(code) {
        res89Status = code;
        return this;
      },
      json(data) {
        res89Json = data;
        return this;
      },
    };
    validateSubmission(req89, res89, () => {});
    assert.strictEqual(res89Status, 422, 'Submission with language_id 89 must return 422');

    // 2. Empty source_code with additional_files rejected with 422 ("source_code is required")
    let resZipStatus = null;
    let resZipJson = null;
    const reqZip = {
      body: {
        source_code: '',
        language_id: 5,
        additional_files: 'UEsDBBQAAAAIAAA=',
      },
    };
    const resZip = {
      status(code) {
        resZipStatus = code;
        return this;
      },
      json(data) {
        resZipJson = data;
        return this;
      },
    };
    validateSubmission(reqZip, resZip, () => {});
    assert.strictEqual(resZipStatus, 422, 'Submission with empty source_code must return 422');
    assert.match(resZipJson.message, /source_code is required/i);
  });

  it('13. Multi image removed from build and deploy scripts', () => {
    const buildImagesSrc = fs.readFileSync(path.resolve('scripts/build-images.sh'), 'utf-8');
    const deploySrc = fs.readFileSync(path.resolve('scripts/deploy.sh'), 'utf-8');

    assert.doesNotMatch(buildImagesSrc, /coderunner\/multi/);
    assert.doesNotMatch(deploySrc, /coderunner\/multi/);
  });
});
