import { execFileSync } from 'node:child_process';
import python from './python.js';
import javascript from './javascript.js';
import cpp from './cpp.js';
import c from './c.js';
import java from './java.js';
import typescript from './typescript.js';
import sqlite from './sqlite.js';
import postgres from './postgres.js';
import mysql from './mysql.js';
import mongodb from './mongodb.js';

// Map of all supported languages by ID and slug
const languagesById = new Map();
const languagesBySlug = new Map();
const languagesList = [c, cpp, java, javascript, python, typescript, sqlite, postgres, mysql, mongodb];

languagesList.forEach(lang => {
  languagesById.set(lang.id, lang);
  if (lang.slug) {
    languagesBySlug.set(lang.slug.toLowerCase(), lang);
  }
});

let parsedConfig = null;

function parseBooleanStrict(val, varName) {
  if (val === undefined || val === null || val === '') return undefined;
  if (val === 'true') return true;
  if (val === 'false') return false;
  throw new Error(`Invalid value "${val}" for ${varName}: must be "true" or "false"`);
}

/**
 * Initialize and validate language configuration from environment
 * @param {object} env - Environment variables object
 * @param {boolean} force - Force re-initialization
 * @returns {object} Parsed configuration maps and warnings
 */
export function initLanguageConfig(env = process.env, force = false) {
  if (parsedConfig && !force) return parsedConfig;

  if (env.ENABLED_LANGUAGES !== undefined) {
    throw new Error('ENABLED_LANGUAGES is not supported. Use per-language variables like LANGUAGE_<SLUG>_ENABLED instead.');
  }

  if (env.ENABLE_LANGUAGE_POOL !== undefined) {
    throw new Error('ENABLE_LANGUAGE_POOL is not supported. Use per-language variables like LANGUAGE_<SLUG>_POOL and LANGUAGE_<SLUG>_POOL_SIZE instead.');
  }

  if (env.ENABLE_MONGODB !== undefined) {
    throw new Error('ENABLE_MONGODB is not supported. Use LANGUAGE_MONGODB_ENABLED instead.');
  }

  if (env.POSTGRES_POOL_SIZE !== undefined) {
    throw new Error('POSTGRES_POOL_SIZE is not supported. Use LANGUAGE_POSTGRESQL_POOL_SIZE instead.');
  }

  if (env.MYSQL_POOL_SIZE !== undefined) {
    throw new Error('MYSQL_POOL_SIZE is not supported. Use LANGUAGE_MYSQL_POOL_SIZE instead.');
  }

  if (env.MONGODB_POOL_SIZE !== undefined) {
    throw new Error('MONGODB_POOL_SIZE is not supported. Use LANGUAGE_MONGODB_POOL_SIZE instead.');
  }

  const enabledMap = new Map();
  const poolMap = new Map();
  const poolSizeMap = new Map();
  const warnings = [];

  for (const lang of languagesList) {
    const slugUpper = lang.slug.toUpperCase();
    const enabledVar = `LANGUAGE_${slugUpper}_ENABLED`;
    const poolVar = `LANGUAGE_${slugUpper}_POOL`;
    const poolSizeVar = `LANGUAGE_${slugUpper}_POOL_SIZE`;

    // 1. Resolve Enabled flag
    let enabled;
    const rawEnabled = env[enabledVar];
    if (rawEnabled !== undefined && rawEnabled !== '') {
      enabled = parseBooleanStrict(rawEnabled, enabledVar);
    } else {
      enabled = lang.slug !== 'mongodb'; // default true, except mongodb = false
    }

    // 2. Resolve Pool flag
    let pool;
    const isDb = isDatabaseLanguage(lang);
    const rawPool = env[poolVar];
    const explicitPoolSet = rawPool !== undefined && rawPool !== '';

    if (explicitPoolSet) {
      pool = parseBooleanStrict(rawPool, poolVar);
    } else {
      pool = isDb; // default true for database languages, false for all others
    }

    // A POOL flag set for a disabled language logs a warning and is ignored
    if (!enabled && explicitPoolSet && pool) {
      warnings.push(`POOL flag set for disabled language ${lang.slug} (${poolVar}) is ignored`);
      pool = false;
    } else if (!enabled) {
      pool = false;
    }

    // 3. Resolve Pool Size
    let poolSize = undefined;
    const rawPoolSize = env[poolSizeVar];

    if (rawPoolSize !== undefined && rawPoolSize !== '') {
      const parsedSize = Number(rawPoolSize);
      if (!Number.isInteger(parsedSize) || parsedSize < 1) {
        throw new Error(`${poolSizeVar} must be an integer >= 1, got ${rawPoolSize}`);
      }
      poolSize = parsedSize;
    }

    if (poolSize !== undefined && (!enabled || !pool)) {
      warnings.push(`POOL_SIZE set for ${lang.slug} (${poolSizeVar}) where pool is not enabled`);
    }

    enabledMap.set(lang.id, enabled);
    enabledMap.set(lang.slug, enabled);
    poolMap.set(lang.id, pool);
    poolMap.set(lang.slug, pool);
    poolSizeMap.set(lang.id, poolSize);
    poolSizeMap.set(lang.slug, poolSize);
  }

  // Log warnings
  for (const w of warnings) {
    console.warn(`[WARN] ${w}`);
  }

  // Startup fails if no language is enabled
  const anyEnabled = languagesList.some(lang => enabledMap.get(lang.id));
  if (!anyEnabled) {
    throw new Error('At least one language must be enabled. No languages are currently enabled.');
  }

  parsedConfig = { enabledMap, poolMap, poolSizeMap, warnings };
  return parsedConfig;
}

/**
 * Reset language config (for test suites)
 */
export function _resetLanguageConfig() {
  parsedConfig = null;
}

function ensureConfig() {
  if (!parsedConfig) {
    initLanguageConfig(process.env);
  }
}

/**
 * Check if a language is enabled
 * @param {object|number|string} languageOrId - Language object, ID, or slug
 * @returns {boolean} True if enabled
 */
export function isLanguageEnabled(languageOrId) {
  ensureConfig();
  if (!languageOrId) return false;
  if (typeof languageOrId === 'object') {
    return parsedConfig.enabledMap.get(languageOrId.id) ?? false;
  }
  if (typeof languageOrId === 'number' || /^\d+$/.test(languageOrId)) {
    return parsedConfig.enabledMap.get(Number(languageOrId)) ?? false;
  }
  return parsedConfig.enabledMap.get(String(languageOrId).toLowerCase()) ?? false;
}

/**
 * Get language POOL flag value
 * @param {object|number|string} languageOrId - Language object, ID, or slug
 * @returns {boolean} True if pool flag is active
 */
export function getLanguagePoolFlag(languageOrId) {
  ensureConfig();
  if (!languageOrId) return false;
  if (typeof languageOrId === 'object') {
    return parsedConfig.poolMap.get(languageOrId.id) ?? false;
  }
  if (typeof languageOrId === 'number' || /^\d+$/.test(languageOrId)) {
    return parsedConfig.poolMap.get(Number(languageOrId)) ?? false;
  }
  return parsedConfig.poolMap.get(String(languageOrId).toLowerCase()) ?? false;
}

/**
 * Get configured language pool size override
 * @param {object|number|string} languageOrId - Language object, ID, or slug
 * @returns {number|undefined} Configured pool size or undefined if not set
 */
export function getLanguagePoolSize(languageOrId) {
  ensureConfig();
  if (!languageOrId) return undefined;
  if (typeof languageOrId === 'object') {
    return parsedConfig.poolSizeMap.get(languageOrId.id);
  }
  if (typeof languageOrId === 'number' || /^\d+$/.test(languageOrId)) {
    return parsedConfig.poolSizeMap.get(Number(languageOrId));
  }
  return parsedConfig.poolSizeMap.get(String(languageOrId).toLowerCase());
}

/**
 * Get list of all enabled languages
 * @returns {object[]} List of enabled language configurations
 */
export function getEnabledLanguages() {
  ensureConfig();
  return languagesList.filter(lang => isLanguageEnabled(lang));
}

/**
 * Describe the execution and pooling strategy plan per enabled language
 * @param {object} options - Options override (e.g. executor: 'isolate' | 'docker')
 * @returns {Array<{ slug: string, executor: string, strategy: string, poolSize: number }>}
 */
export function describeLanguagePlan(options = {}) {
  ensureConfig();
  const enabled = getEnabledLanguages();

  let isolateAvailable = options.isolateAvailable;
  if (isolateAvailable === undefined) {
    if (options.executor === 'isolate' || process.env.EXECUTOR_TYPE === 'isolate') {
      isolateAvailable = true;
    } else if (options.executor === 'docker' || process.env.EXECUTOR_TYPE === 'docker') {
      isolateAvailable = false;
    } else {
      try {
        execFileSync('isolate', ['--version'], { stdio: 'pipe', timeout: 5000 });
        isolateAvailable = true;
      } catch {
        isolateAvailable = false;
      }
    }
  }

  const rawConcurrency = options.concurrency !== undefined ? Number(options.concurrency) : Number(process.env.WORKER_CONCURRENCY);
  const baseWorkerConcurrency = Number.isInteger(rawConcurrency) && rawConcurrency > 0 ? rawConcurrency : 2;
  const rawDbConcurrency = options.dbConcurrency !== undefined ? Number(options.dbConcurrency) : Number(process.env.WORKER_DB_CONCURRENCY);
  const dbConcurrency = Number.isInteger(rawDbConcurrency) && rawDbConcurrency > 0 ? rawDbConcurrency : baseWorkerConcurrency;

  return enabled.map(lang => {
    const isDb = isDatabaseLanguage(lang);
    const poolFlag = options.languagePoolFlags?.[lang.slug] ?? options.languagePoolFlags?.[lang.id] ?? getLanguagePoolFlag(lang);
    const customSize = options.languagePoolSizes?.[lang.slug] ?? options.languagePoolSizes?.[lang.id] ?? getLanguagePoolSize(lang);

    let executor;
    let strategy;
    let poolSize = 0;

    if (isDb) {
      executor = 'docker';
      if (poolFlag) {
        strategy = 'pooled';
        poolSize = customSize !== undefined ? customSize : dbConcurrency;
      } else {
        strategy = 'on-demand-boot';
        poolSize = 0;
      }
    } else {
      if (isolateAvailable) {
        executor = 'isolate';
        strategy = 'on-demand';
        poolSize = 0;
      } else {
        executor = 'docker';
        if (poolFlag) {
          strategy = 'pooled';
          poolSize = customSize !== undefined ? customSize : baseWorkerConcurrency;
        } else {
          strategy = 'on-demand';
          poolSize = 0;
        }
      }
    }

    return {
      slug: lang.slug,
      executor,
      strategy,
      poolSize,
    };
  });
}

/**
 * Get language by ID
 * @param {number} id - Language ID
 * @returns {object|null} Language configuration
 */
export function getLanguageById(id) {
  return languagesById.get(id) || null;
}

/**
 * Get language by slug
 * @param {string} slug - Language slug
 * @returns {object|null} Language configuration
 */
export function getLanguageBySlug(slug) {
  if (!slug) return null;
  return languagesBySlug.get(slug.toLowerCase()) || null;
}

/**
 * Get all active (non-archived and enabled) languages
 * @returns {object[]} List of active languages
 */
export function getActiveLanguages() {
  ensureConfig();
  return languagesList.filter(lang => {
    if (!isLanguageEnabled(lang)) return false;
    return !lang.is_archived;
  });
}

/**
 * Get all languages (marking disabled or archived ones as archived)
 * @returns {object[]} List of all languages
 */
export function getAllLanguages() {
  ensureConfig();
  return languagesList.map(lang => {
    if (!isLanguageEnabled(lang) || lang.is_archived) {
      return { ...lang, is_archived: true };
    }
    return lang;
  });
}

/**
 * Check if a language ID is valid
 * @param {number} id - Language ID
 * @returns {boolean} True if valid
 */
export function isValidLanguageId(id) {
  return languagesById.has(id);
}

/**
 * Check if a language is a database language (requires dedicated container/daemon/pool)
 * @param {object|number|string} languageOrId - Language object or ID
 * @returns {boolean} True if database language
 */
export function isDatabaseLanguage(languageOrId) {
  if (!languageOrId) return false;
  const lang = typeof languageOrId === 'object'
    ? languageOrId
    : (languagesById.get(typeof languageOrId === 'string' ? parseInt(languageOrId, 10) : languageOrId)
      || languagesBySlug.get(String(languageOrId).toLowerCase()));
  return Boolean(lang && lang.is_daemon);
}

// Status codes (Judge0 compatible)
export const STATUSES = {
  1: { id: 1, description: 'In Queue' },
  2: { id: 2, description: 'Processing' },
  3: { id: 3, description: 'Accepted' },
  4: { id: 4, description: 'Wrong Answer' },
  5: { id: 5, description: 'Time Limit Exceeded' },
  6: { id: 6, description: 'Compilation Error' },
  7: { id: 7, description: 'Runtime Error (SIGSEGV)' },
  8: { id: 8, description: 'Runtime Error (SIGXFSZ)' },
  9: { id: 9, description: 'Runtime Error (SIGFPE)' },
  10: { id: 10, description: 'Runtime Error (SIGABRT)' },
  11: { id: 11, description: 'Runtime Error (NZEC)' },
  12: { id: 12, description: 'Runtime Error (Other)' },
  13: { id: 13, description: 'Internal Error' },
  14: { id: 14, description: 'Exec Format Error' },
};

/**
 * Get status by ID
 * @param {number} id - Status ID
 * @returns {object|null} Status object
 */
export function getStatusById(id) {
  return STATUSES[id] || null;
}

/**
 * Get all statuses
 * @returns {object[]} List of all statuses
 */
export function getAllStatuses() {
  return Object.values(STATUSES);
}

export default {
  initLanguageConfig,
  _resetLanguageConfig,
  isLanguageEnabled,
  getLanguagePoolFlag,
  getLanguagePoolSize,
  getEnabledLanguages,
  describeLanguagePlan,
  getLanguageById,
  getLanguageBySlug,
  getActiveLanguages,
  getAllLanguages,
  isValidLanguageId,
  isDatabaseLanguage,
  getStatusById,
  getAllStatuses,
  STATUSES,
};
