import Docker from 'dockerode';
import config from './config.js';

export function createDockerClient(options = {}) {
  if (process.env.DOCKER_HOST) {
    try {
      // Normalize tcp:// to http:// because docker-modem requires protocol to be 'http' or 'https'
      const normalizedHost = process.env.DOCKER_HOST.replace(/^tcp:\/\//, 'http://');
      const url = new URL(normalizedHost);
      const isHttps = url.protocol === 'https:';
      return new Docker({
        host: url.hostname,
        port: parseInt(url.port, 10) || 2375,
        protocol: isHttps ? 'https' : 'http',
        ...options,
      });
    } catch {
      return new Docker(options);
    }
  }

  return new Docker({
    socketPath: config.docker.socketPath,
    ...options,
  });
}

export default createDockerClient;

