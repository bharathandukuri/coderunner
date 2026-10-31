import config from '../utils/config.js';

export const MASKED_PATHS = [
  '/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow',
  '/etc/hostname', '/etc/hosts', '/etc/resolv.conf',
  '/proc/kcore', '/proc/keys', '/proc/latency_stats',
  '/proc/timer_list', '/proc/timer_stats', '/proc/sched_debug',
  '/proc/scsi', '/proc/acpi', '/proc/bus',
  '/proc/1/environ', '/proc/1/cmdline', '/proc/1/maps',
  '/sys/firmware', '/sys/devices',
];

export const READONLY_PATHS = ['/proc', '/sys'];

/**
 * Builds container configuration for both pooled boots and on-demand sandboxes (C3).
 * Ensures identical hardening across pooled and on-demand containers.
 *
 * @param {object} params
 * @param {object} [params.language] - Language definition
 * @param {object} [params.pool] - Warm pool definition if pooled
 * @param {object} [params.submission] - User submission object if on-demand or execution
 * @param {string} params.instanceId - Worker instance identifier
 * @param {boolean} [params.isDaemon] - Whether container runs a background daemon (Postgres/MySQL)
 * @param {boolean} [params.isPool] - Whether container is a pre-warmed pool container
 * @returns {object} Docker container configuration
 */
export function buildContainerConfig({
  language,
  pool,
  submission = {},
  instanceId,
  isDaemon = false,
  isPool = false,
}) {
  const lang = submission.language || language || {};
  const isDb = lang.category === 'database' || isDaemon;
  const enableNetwork = Boolean(submission.enable_network);

  // Effective memory calculation (C3):
  // max(requested memory_limit, language.min_memory || 0).
  // Do NOT raise requests below 256MB to 256MB; TypeScript needs its min_memory.
  let effectiveMemoryKb;
  if (isDb && !lang.min_memory && isDaemon) {
    effectiveMemoryKb = 512000; // 512MB for DB daemons
  } else if (submission.memory_limit != null) {
    effectiveMemoryKb = Math.max(submission.memory_limit, lang.min_memory || 0);
  } else if (pool && pool.effectiveMemory) {
    effectiveMemoryKb = pool.effectiveMemory;
  } else if (lang.min_memory) {
    effectiveMemoryKb = lang.min_memory;
  } else {
    effectiveMemoryKb = config.execution.defaultMemoryLimit || 256000;
  }

  // Tmpfs box size derived from memory (at least 128MB)
  const boxSize = Math.max(Math.ceil(effectiveMemoryKb / 1024), 128);
  const effectiveMemoryBytes = effectiveMemoryKb > 0 ? effectiveMemoryKb * 1024 : 0;

  // Pids limit from request or language or pool or default 64
  const pidsLimit = submission.max_processes_and_or_threads
    || (pool && pool.pidsLimit)
    || lang.pids_limit
    || config.execution.maxProcesses
    || 64;

  const image = (pool && pool.image) || lang.image || `coderunner/language:${lang.id}`;
  const langName = (pool && pool.name) || (lang.name ? lang.name.toLowerCase().split(/[\s(]/)[0] : String(lang.id));

  const labels = {
    'com.coderunner.pool': isPool ? 'true' : 'false',
    'com.coderunner.instance_id': instanceId,
    'com.coderunner.worker_slot': instanceId,
    'com.coderunner.created_at': Date.now().toString(),
    'com.coderunner.language': langName,
  };
  if (!isPool) {
    labels['com.coderunner.on_demand'] = 'true';
  }

  const tmpfs = isDaemon ? {
    '/box': 'rw,exec,nosuid,size=256m,mode=1777',
    '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
  } : {
    '/box': `rw,exec,nosuid,size=${boxSize}m,mode=1777`,
    '/tmp': 'rw,noexec,nosuid,size=64m,mode=1777',
    '/home': 'rw,noexec,nosuid,size=16m,mode=1777',
  };

  const containerConfig = {
    Image: image,
    WorkingDir: '/box',
    NetworkDisabled: !enableNetwork,
    Labels: labels,
    HostConfig: {
      Memory: effectiveMemoryBytes,
      MemorySwap: effectiveMemoryBytes,
      CpuPeriod: 100000,
      CpuQuota: 100000,
      PidsLimit: pidsLimit,
      NetworkMode: enableNetwork ? 'bridge' : 'none',
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      ...(config.docker.runtime ? { Runtime: config.docker.runtime } : {}),
      MaskedPaths: [...MASKED_PATHS],
      ReadonlyPaths: [...READONLY_PATHS],
      Tmpfs: tmpfs,
      Binds: [],
    },
    Tty: false,
    OpenStdin: true,
    StdinOnce: true,
  };

  if (isDaemon) {
    if (pool && pool.user) {
      containerConfig.User = pool.user;
    }
  } else {
    containerConfig.Cmd = ['/bin/sh', '-c', 'sleep infinity'];
  }

  return containerConfig;
}

export default {
  buildContainerConfig,
  MASKED_PATHS,
  READONLY_PATHS,
};
