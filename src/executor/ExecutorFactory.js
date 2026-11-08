import fs from 'fs';
import { execFileSync } from 'child_process';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import { isDatabaseLanguage, getLanguageById, getLanguagePoolFlag } from '../languages/index.js';
import DockerExecutor from './DockerExecutor.js';
import IsolateExecutor from './IsolateExecutor.js';

let executorInstance = null;
let executorType = null;
let dockerExecutorInstance = null;
const loggedIgnoredPoolSlugs = new Set();

function checkIgnoredPoolFlag(languageId) {
  if (languageId !== undefined && languageId !== null) {
    const lang = getLanguageById(languageId);
    if (lang && !isDatabaseLanguage(lang) && getLanguagePoolFlag(lang) && !loggedIgnoredPoolSlugs.has(lang.slug)) {
      loggedIgnoredPoolSlugs.add(lang.slug);
      logger.info({ language: lang.slug }, `Language pool flag for ${lang.slug} ignored because Isolate executor is active`);
    }
  }
}

function getDockerExecutor() {
  if (!dockerExecutorInstance) {
    dockerExecutorInstance = new DockerExecutor();
  }
  return dockerExecutorInstance;
}

export function setDockerExecutorInstance(instance) {
  dockerExecutorInstance = instance;
}

/**
 * Detect if isolate is available on the system
 */
function isIsolateAvailable() {
  try {
    execFileSync('isolate', ['--version'], { stdio: 'pipe', timeout: 5000 });
    return { available: true, reason: null };
  } catch {
    return { available: false, reason: 'isolate binary not found or not working' };
  }
}

/**
 * Get the appropriate executor based on language and system capabilities.
 * Database languages (PostgreSQL, MySQL, MongoDB) must always use DockerExecutor.
 * Other languages auto-select: Isolate if available, otherwise Docker.
 */
export function getExecutor(languageId) {
  if (isDatabaseLanguage(languageId)) {
    return getDockerExecutor();
  }

  if (executorInstance) {
    if (executorType === 'isolate') {
      checkIgnoredPoolFlag(languageId);
    }
    return executorInstance;
  }

  // Check explicit EXECUTOR_TYPE override
  const explicitType = process.env.EXECUTOR_TYPE || config.executor?.type;
  if (explicitType === 'docker') {
    executorType = 'docker';
    executorInstance = getDockerExecutor();
    logger.info('Selected Docker executor (explicitly configured via EXECUTOR_TYPE=docker)');
    return executorInstance;
  }

  // Auto-detect: isolate > docker
  const iso = isIsolateAvailable();
  if (iso.available) {
    executorType = 'isolate';
    executorInstance = new IsolateExecutor();
    logger.info('Auto-selected Isolate executor (cgroup sandbox)');
    checkIgnoredPoolFlag(languageId);
  } else {
    executorType = 'docker';
    executorInstance = getDockerExecutor();
    logger.info({ isoReason: iso.reason }, 'Auto-selected Docker executor');
  }

  return executorInstance;
}

/**
 * Get the current executor type
 */
export function getExecutorType(languageId) {
  if (isDatabaseLanguage(languageId)) {
    return 'docker';
  }

  if (!executorType) {
    getExecutor();
  }
  return executorType;
}

/**
 * Check system capabilities and return info
 */
export function getSystemCapabilities() {
  const docker = {
    available: !!(config.docker.host || (config.docker.socketPath && fs.existsSync(config.docker.socketPath))),
    socketPath: config.docker.socketPath,
    host: config.docker.host,
  };

  const isolate = isIsolateAvailable();

  return {
    platform: process.platform,
    arch: process.arch,
    isolate: {
      available: isolate.available,
      reason: isolate.reason,
    },
    docker,
    recommended: isolate.available ? 'isolate' : 'docker',
    current: executorType || 'not initialized',
  };
}

export function _resetExecutor() {
  executorInstance = null;
  executorType = null;
  dockerExecutorInstance = null;
  loggedIgnoredPoolSlugs.clear();
}

export default {
  getExecutor,
  getExecutorType,
  getSystemCapabilities,
  _resetExecutor,
};
