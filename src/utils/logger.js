import pino from 'pino';
import config from './config.js';

const logger = pino({
  level: config.server.nodeEnv === 'production' ? 'info' : 'debug',
  transport: config.server.nodeEnv === 'development'
    ? { target: 'pino-pretty', options: { colorize: true } }
    : undefined,
  base: {
    service: 'coderunner',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
