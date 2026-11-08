import Joi from 'joi';
import config from '../../utils/config.js';
import { isValidLanguageId, isLanguageEnabled, getEnabledLanguages, getLanguageById } from '../../languages/index.js';
import logger from '../../utils/logger.js';

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'redis',
  'docker-proxy',
  'api',
  'worker',
  'worker-db',
  'caddy',
  'prometheus',
  'grafana',
  'cadvisor',
  'alertmanager',
  'node-exporter',
  'redis-exporter',
]);

/**
 * Hardened SSRF validator for callback URLs.
 * Rejects loopback, private RFC1918, link-local (AWS metadata 169.254.0.0/16),
 * carrier-grade NAT, non-standard IP encodings (decimal, hex, octal), and Docker services.
 */
export function validateCallbackUrl(value, helpers) {
  if (!value) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return helpers.error('any.invalid');
    }

    let hostname = url.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    if (BLOCKED_HOSTNAMES.has(hostname)) {
      return helpers.error('any.invalid');
    }

    if (!hostname.includes('.')) {
      return helpers.error('any.invalid');
    }

    if (
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.lan') ||
      hostname.endsWith('.home.arpa')
    ) {
      return helpers.error('any.invalid');
    }

    // Decimal, octal, or hex raw integer IP
    if (/^(0x[0-9a-f]+|\d+)$/i.test(hostname)) {
      return helpers.error('any.invalid');
    }

    const parts = hostname.split('.');
    if (parts.length === 4 && parts.every(p => /^(0x[0-9a-f]+|0[0-7]+|\d+)$/i.test(p))) {
      const octets = parts.map(p => {
        if (/^0x/i.test(p)) return parseInt(p, 16);
        if (/^0\d/.test(p)) return parseInt(p, 8);
        return parseInt(p, 10);
      });
      if (octets.some(o => isNaN(o) || o < 0 || o > 255)) {
        return helpers.error('any.invalid');
      }
      const [o0, o1, o2] = octets;
      if (o0 === 0) return helpers.error('any.invalid'); // 0.0.0.0/8
      if (o0 === 10) return helpers.error('any.invalid'); // 10.0.0.0/8
      if (o0 === 127) return helpers.error('any.invalid'); // 127.0.0.0/8
      if (o0 === 169 && o1 === 254) return helpers.error('any.invalid'); // 169.254.0.0/16
      if (o0 === 172 && o1 >= 16 && o1 <= 31) return helpers.error('any.invalid'); // 172.16.0.0/12
      if (o0 === 192 && o1 === 168) return helpers.error('any.invalid'); // 192.168.0.0/16
      if (o0 === 100 && o1 >= 64 && o1 <= 127) return helpers.error('any.invalid'); // 100.64.0.0/10
      if (o0 === 192 && o1 === 0 && o2 === 2) return helpers.error('any.invalid');
      if (o0 === 198 && o1 === 51 && o2 === 100) return helpers.error('any.invalid');
      if (o0 === 203 && o1 === 0 && o2 === 113) return helpers.error('any.invalid');
      if (o0 >= 224) return helpers.error('any.invalid'); // Multicast & reserved
    }

    if (
      hostname === '::1' ||
      hostname === '::' ||
      hostname.startsWith('fe80:') ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      hostname.startsWith('::ffff:')
    ) {
      return helpers.error('any.invalid');
    }

    return value;
  } catch {
    return helpers.error('any.invalid');
  }
}

// Run validation schema (single file execution)
const runSchema = Joi.object({
  source_code: Joi.string().max(config.execution.maxSourceSize).required().messages({
    'string.empty': 'source_code is required',
    'any.required': 'source_code is required',
  }),
  language_id: Joi.number().integer().required().custom((value, helpers) => {
    if (!isValidLanguageId(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }),
  stdin: Joi.string().allow('', null).default(''),
  time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  timelimit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  cpu_time_limit: Joi.number().greater(0).max(config.execution.maxCpuTimeLimit).allow(null),
  cpu_extra_time: Joi.number().min(0).max(5).default(1),
  wall_time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit).allow(null),
  stack_limit: Joi.number().min(0).max(config.execution.defaultStackLimit)
    .default(config.execution.defaultStackLimit),
  max_processes_and_or_threads: Joi.number().min(1).max(config.execution.maxProcesses)
    .default(config.execution.maxProcesses),
  max_file_size: Joi.number().min(0).max(4096).default(1024),
  compiler_options: Joi.string().allow('', null).default(null),
  command_line_arguments: Joi.string().allow('', null).default(null),
  redirect_stderr_to_stdout: Joi.boolean().default(false),
  enable_network: Joi.any().strip().default(false),
  callback_url: Joi.string().uri().allow('', null).default(null).custom(validateCallbackUrl),
  additional_files: Joi.string().allow('', null).default(null),
});

// Batch run validation
export function getBatchRunSchema(maxBatch = config.execution?.maxBatchSize || 20) {
  return Joi.object({
    runs: Joi.array().items(runSchema).min(1).max(maxBatch),
    submissions: Joi.array().items(runSchema).min(1).max(maxBatch),
  }).or('runs', 'submissions');
}
export const batchRunSchema = getBatchRunSchema();

// Multi-file run schema
const multiFileRunSchema = Joi.object({
  language_id: Joi.number().integer().required().custom((value, helpers) => {
    if (!isValidLanguageId(value)) {
      return helpers.error('any.invalid');
    }
    return value;
  }),
  time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  timelimit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  cpu_time_limit: Joi.number().greater(0).max(config.execution.maxCpuTimeLimit).allow(null),
  wall_time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
  memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit).allow(null),
  files: Joi.array().items(
    Joi.object({
      path: Joi.string().required().custom((value, helpers) => {
        const normalized = value.trim();
        if (
          !normalized ||
          normalized.startsWith('/') ||
          normalized.startsWith('\\') ||
          normalized.includes('..') ||
          /^[a-zA-Z]:/.test(normalized)
        ) {
          return helpers.error('any.invalid');
        }
        return normalized;
      }),
      content: Joi.string().allow('').required(),
    })
  ).min(1).required(),
  compileOrder: Joi.array().items(Joi.string()).default(null),
  executions: Joi.array().items(
    Joi.object({
      entryPoint: Joi.string().required(),
      stdin: Joi.string().allow('', null).default(''),
      args: Joi.array().items(Joi.string()).default([]),
      time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
      timelimit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
      cpu_time_limit: Joi.number().greater(0).max(config.execution.maxCpuTimeLimit).allow(null),
      cpu_extra_time: Joi.number().min(0).max(5).default(1),
      wall_time_limit: Joi.number().greater(0).max(config.execution.maxWallTimeLimit).allow(null),
      memory_limit: Joi.number().min(0).max(config.execution.maxMemoryLimit).allow(null),
      stack_limit: Joi.number().min(0).max(config.execution.defaultStackLimit)
        .default(config.execution.defaultStackLimit),
      max_processes_and_or_threads: Joi.number().min(1).max(config.execution.maxProcesses)
        .default(config.execution.maxProcesses),
      max_file_size: Joi.number().min(0).max(4096).default(1024),
    })
  ).min(1).max(20).required(),
  compiler_options: Joi.string().allow('', null).default(null),
  redirect_stderr_to_stdout: Joi.boolean().default(false),
  enable_network: Joi.any().strip().default(false),
  callback_url: Joi.string().uri().allow('', null).default(null).custom(validateCallbackUrl),
});

// Batch multi-file run validation
export function getBatchMultiFileRunSchema(maxBatch = config.execution?.maxBatchSize || 20) {
  return Joi.object({
    runs: Joi.array().items(multiFileRunSchema).min(1).max(maxBatch),
    submissions: Joi.array().items(multiFileRunSchema).min(1).max(maxBatch),
  }).or('runs', 'submissions');
}
export const batchMultiFileRunSchema = getBatchMultiFileRunSchema();

/**
 * Validate run request
 */
export function validateRun(req, res, next) {
  if (req.body && req.body.language_id !== undefined) {
    if (isValidLanguageId(req.body.language_id) && !isLanguageEnabled(req.body.language_id)) {
      const lang = getLanguageById(req.body.language_id);
      const langName = lang?.name ? lang.name.split(' (')[0] : 'Language';
      const enableVar = `LANGUAGE_${lang?.slug ? lang.slug.toUpperCase() : 'UNKNOWN'}_ENABLED=true`;
      return res.status(422).json({
        error: 'Language is disabled',
        message: `${langName} (language_id: ${req.body.language_id}) is disabled. Set ${enableVar} to enable it.`,
        language_id: req.body.language_id,
        enabled_languages: getEnabledLanguages().map(l => l.slug),
      });
    }
  }

  const { error, value } = runSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = value;
  next();
}

export const validateSubmission = validateRun;

/**
 * Validate batch run request
 */
export function validateBatchRun(req, res, next) {
  const items = req.body?.runs || req.body?.submissions;
  if (Array.isArray(items)) {
    const offendingIndexes = [];
    items.forEach((item, idx) => {
      if (item && item.language_id !== undefined && isValidLanguageId(item.language_id) && !isLanguageEnabled(item.language_id)) {
        offendingIndexes.push(idx);
      }
    });
    if (offendingIndexes.length > 0) {
      return res.status(422).json({
        error: 'Batch contains disabled languages',
        message: `Batch contains disabled languages at indexes: ${offendingIndexes.join(', ')}`,
        disabled_indexes: offendingIndexes,
        offending_indexes: offendingIndexes,
        enabled_languages: getEnabledLanguages().map(l => l.slug),
      });
    }
  }

  const schema = getBatchRunSchema(config.execution?.maxBatchSize || 20);
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const list = req.body?.runs || req.body?.submissions;
    logger.warn({
      event: 'batch_validation_error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
      count: list?.length,
      languageIds: list?.map(s => s.language_id),
    });
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  // Normalize to runs
  req.validatedBody = {
    runs: value.runs || value.submissions,
  };
  next();
}

export const validateBatchSubmission = validateBatchRun;
export const validateMultiSubmission = validateMultiRun;
export const validateBatchMultiSubmission = validateBatchMultiRun;

/**
 * Validate multi-file run request
 */
export function validateMultiRun(req, res, next) {
  if (req.body && req.body.language_id !== undefined) {
    if (isValidLanguageId(req.body.language_id) && !isLanguageEnabled(req.body.language_id)) {
      const lang = getLanguageById(req.body.language_id);
      const langName = lang?.name ? lang.name.split(' (')[0] : 'Language';
      const enableVar = `LANGUAGE_${lang?.slug ? lang.slug.toUpperCase() : 'UNKNOWN'}_ENABLED=true`;
      return res.status(422).json({
        error: 'Language is disabled',
        message: `${langName} (language_id: ${req.body.language_id}) is disabled. Set ${enableVar} to enable it.`,
        language_id: req.body.language_id,
        enabled_languages: getEnabledLanguages().map(l => l.slug),
      });
    }
  }

  const { error, value } = multiFileRunSchema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = value;
  next();
}

/**
 * Validate batch multi-file run request
 */
export function validateBatchMultiRun(req, res, next) {
  const items = req.body?.runs || req.body?.submissions;
  if (Array.isArray(items)) {
    const offendingIndexes = [];
    items.forEach((item, idx) => {
      if (item && item.language_id !== undefined && isValidLanguageId(item.language_id) && !isLanguageEnabled(item.language_id)) {
        offendingIndexes.push(idx);
      }
    });
    if (offendingIndexes.length > 0) {
      return res.status(422).json({
        error: 'Batch contains disabled languages',
        message: `Batch contains disabled languages at indexes: ${offendingIndexes.join(', ')}`,
        disabled_indexes: offendingIndexes,
        offending_indexes: offendingIndexes,
        enabled_languages: getEnabledLanguages().map(l => l.slug),
      });
    }
  }

  const schema = getBatchMultiFileRunSchema(config.execution?.maxBatchSize || 20);
  const { error, value } = schema.validate(req.body, {
    abortEarly: false,
    stripUnknown: true,
  });

  if (error) {
    const list = req.body?.runs || req.body?.submissions;
    logger.warn({
      event: 'batch_multi_validation_error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
      count: list?.length,
    });
    return res.status(422).json({
      error: 'Validation Error',
      message: error.details.map(d => d.message).join(', '),
      details: error.details,
    });
  }

  req.validatedBody = {
    runs: value.runs || value.submissions,
  };
  next();
}

/**
 * Sanitize compiler options to prevent command injection.
 * Whitelist approach: only allow alphanumeric, hyphens, dots, equals, slashes,
 * plus, underscores, and spaces. Reject everything else including newlines.
 */
export function sanitizeCompilerOptions(options) {
  if (!options) return null;
  // Strip any character not in the safe set
  const sanitized = options.replace(/[^a-zA-Z0-9\s\-_.=+/]/g, '');
  // Collapse multiple spaces and trim
  return sanitized.replace(/\s+/g, ' ').trim() || null;
}

/**
 * Sanitize command line arguments to prevent command injection.
 * Same whitelist approach as compiler options.
 */
export function sanitizeCommandLineArgs(args) {
  if (!args) return null;
  const sanitized = args.replace(/[^a-zA-Z0-9\s\-_.=+/]/g, '');
  return sanitized.replace(/\s+/g, ' ').trim() || null;
}

export default {
  validateSubmission,
  validateBatchSubmission,
  sanitizeCompilerOptions,
  sanitizeCommandLineArgs,
};
