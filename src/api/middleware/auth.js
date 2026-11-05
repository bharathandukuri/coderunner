import config from '../../utils/config.js';

/**
 * Authentication middleware
 * Validates auth token from any of the configured headers (X-Auth-Token, x-rapidapi-key, etc.)
 */
export function authMiddleware(req, res, next) {
  // Fail-closed in production if no tokens are configured
  if (config.auth.tokens.length === 0) {
    if (config.server.nodeEnv === 'production') {
      return res.status(500).json({
        error: 'Authentication configuration error',
        message: 'AUTH_TOKEN is not configured on the server',
      });
    }
    // Skip auth only in non-production environments when explicitly unconfigured
    return next();
  }

  let token = null;
  for (const header of config.auth.headers) {
    token = req.get(header);
    if (token) break;
  }

  // Also support standard Authorization: Bearer <token>
  if (!token) {
    const authHeader = req.get('authorization');
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
      } else {
        token = authHeader.trim();
      }
    }
  }

  if (!token) {
    return res.status(401).json({
      error: 'Authentication required',
      message: 'Missing authentication header',
    });
  }

  if (!config.auth.tokens.includes(token)) {
    return res.status(401).json({
      error: 'Authentication failed',
      message: 'Invalid authentication token',
    });
  }

  next();
}

export default authMiddleware;
