import fs from 'fs';
import { execFileSync } from 'child_process';
import config from '../utils/config.js';
import logger from '../utils/logger.js';
import DockerExecutor from './DockerExecutor.js';
import IsolateExecutor from './IsolateExecutor.js';

let executorInstance = null;
let executorType = null;
let dockerExecutorInstance = null;

function getDockerExecutor() {
  if (!dockerExecutorInstance) {
    dockerExecutorInstance = new DockerExecutor();
  }
  return dockerExecutorInstance;
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
 * Languages 8 and 9 (PostgreSQL, MySQL) must always use DockerExecutor.
 * Other languages auto-select: Isolate if available, otherwise Docker.
 */
export function getExecutor(languageId) {
  if (languageId === 8 || languageId === 9) {
    return getDockerExecutor();
  }

  if (executorInstance) {
    return executorInstance;
  }

  // Auto-detect: isolate > docker
  const iso = isIsolateAvailable();
  if (iso.available) {
    executorType = 'isolate';
    executorInstance = new IsolateExecutor();
    logger.info('Auto-selected Isolate executor (cgroup sandbox)');
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
  if (languageId === 8 || languageId === 9) {
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

export default {
  getExecutor,
  getExecutorType,
  getSystemCapabilities,
};
