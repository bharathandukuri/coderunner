#!/usr/bin/env node
/**
 * scripts/dev/language-config.mjs
 * Prints enabled languages, needed images, pool plan, and sizing.
 * Used by scripts/build-images.sh, scripts/deploy.sh, and scripts/preflight.sh.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  initLanguageConfig,
  getEnabledLanguages,
  getLanguagePoolFlag,
  describeLanguagePlan,
  isDatabaseLanguage,
  getLanguageById,
} from '../../src/languages/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

// If .env exists in project root, populate missing environment variables
const envFile = path.join(projectRoot, '.env');
if (fs.existsSync(envFile)) {
  const content = fs.readFileSync(envFile, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  }
}

// Initialize language config
initLanguageConfig(process.env);

const command = process.argv[2] || 'plan';

switch (command) {
  case 'languages':
  case '--languages': {
    const enabled = getEnabledLanguages();
    console.log(enabled.map(l => l.slug).join(' '));
    break;
  }

  case 'images':
  case '--images': {
    const enabled = getEnabledLanguages();
    const images = [...new Set(enabled.map(l => l.image).filter(Boolean))];
    console.log(images.join(' '));
    break;
  }

  case 'pools':
  case '--pools': {
    const plan = describeLanguagePlan();
    const pooled = plan.filter(p => p.strategy === 'pooled');
    console.log(pooled.map(p => p.slug).join(' '));
    break;
  }

  case 'plan':
  case '--plan': {
    const plan = describeLanguagePlan();
    if (process.argv.includes('--json')) {
      console.log(JSON.stringify(plan, null, 2));
    } else {
      console.table(plan);
    }
    break;
  }

  case 'sizing':
  case '--sizing': {
    const enabled = getEnabledLanguages();
    const plan = describeLanguagePlan();

    const wConcurrency = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
    const wDbConcurrency = parseInt(process.env.WORKER_DB_CONCURRENCY || '2', 10);
    const pgPoolSize = parseInt(process.env.POSTGRES_POOL_SIZE || String(wDbConcurrency), 10);
    const myPoolSize = parseInt(process.env.MYSQL_POOL_SIZE || String(wDbConcurrency), 10);
    const mongoPoolSize = parseInt(process.env.MONGODB_POOL_SIZE || String(wDbConcurrency), 10);

    const baseMem = process.env.ENABLE_MONITORING === 'false' ? 150 : 360;
    const osReserve = 350;

    // Warm RAM: only for pools that will exist
    let warmRamMb = 0;
    const pooledLanguages = plan.filter(p => p.strategy === 'pooled');
    const pooledImages = new Set();

    for (const p of pooledLanguages) {
      const lang = getLanguageById(p.slug);
      if (lang && isDatabaseLanguage(lang)) {
        if (p.slug === 'postgresql') {
          warmRamMb += pgPoolSize * 75;
        } else if (p.slug === 'mysql') {
          warmRamMb += myPoolSize * 280;
        } else if (p.slug === 'mongodb') {
          const mongoMeasuredFile = path.join(projectRoot, 'docs/benchmarks/mongodb-footprint/measured_idle_mb.txt');
          let mongoIdleMb = 90;
          if (fs.existsSync(mongoMeasuredFile)) {
            const measured = parseInt(fs.readFileSync(mongoMeasuredFile, 'utf-8').trim(), 10);
            if (!isNaN(measured)) mongoIdleMb = measured;
          }
          warmRamMb += mongoPoolSize * mongoIdleMb;
        }
      } else if (lang && lang.image) {
        if (!pooledImages.has(lang.image)) {
          pooledImages.add(lang.image);
          warmRamMb += wConcurrency * 35; // ~35MB per non-db warm container
        }
      }
    }

    // Per-job memory: for enabled languages
    let perJobRamMb = 0;
    const hasEnabledNonDb = enabled.some(l => !isDatabaseLanguage(l));
    if (hasEnabledNonDb) {
      perJobRamMb += wConcurrency * 250;
    }

    const enabledDb = enabled.filter(l => isDatabaseLanguage(l));
    if (enabledDb.length > 0) {
      let maxDbJobMb = 75;
      if (enabledDb.some(l => l.slug === 'postgresql')) maxDbJobMb = Math.max(maxDbJobMb, 75);
      if (enabledDb.some(l => l.slug === 'mysql')) maxDbJobMb = Math.max(maxDbJobMb, 280);
      if (enabledDb.some(l => l.slug === 'mongodb')) maxDbJobMb = Math.max(maxDbJobMb, 512);
      perJobRamMb += wDbConcurrency * maxDbJobMb;
    }

    const minRecommendedRam = baseMem + osReserve + warmRamMb + perJobRamMb;

    let minVcpus = 1;
    if (wConcurrency + wDbConcurrency > 3) minVcpus = 2;
    if (wConcurrency >= 4) minVcpus = 4;
    if (wConcurrency >= 8) minVcpus = 8;

    if (process.argv.includes('--shell') || process.argv.includes('--env')) {
      console.log(`BASE_MEM=${baseMem}`);
      console.log(`OS_RESERVE=${osReserve}`);
      console.log(`WARM_RAM_MB=${warmRamMb}`);
      console.log(`PER_JOB_RAM_MB=${perJobRamMb}`);
      console.log(`MEM_MIN_RECOMMENDED=${minRecommendedRam}`);
      console.log(`MIN_VCPUS_RECOMMENDED=${minVcpus}`);
    } else if (process.argv.includes('--json')) {
      console.log(JSON.stringify({
        baseMem,
        osReserve,
        warmRamMb,
        perJobRamMb,
        minRecommendedRam,
        minVcpus,
        enabledLanguages: enabled.map(l => l.slug),
        neededImages: [...new Set(enabled.map(l => l.image).filter(Boolean))],
        pooledLanguages: pooledLanguages.map(l => l.slug),
      }, null, 2));
    } else {
      console.log(minRecommendedRam);
    }
    break;
  }

  default:
    console.error(`Unknown command: ${command}`);
    console.error('Available commands: languages, images, pools, plan, sizing');
    process.exit(1);
}
