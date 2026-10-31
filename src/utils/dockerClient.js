import Docker from 'dockerode';
import config from './config.js';

export function createDockerClient(options = {}) {
  if (process.env.DOCKER_HOST) {
    try {
      const url = new URL(process.env.DOCKER_HOST);
      return new Docker({
        host: url.hostname,
        port: parseInt(url.port, 10) || 2375,
        protocol: url.protocol.replace(':', ''),
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

