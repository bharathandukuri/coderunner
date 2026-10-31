import config from '../../utils/config.js';

// Simple in-memory rate limiter for general routes
const clients = new Map();
// In-memory rate limiter specifically for submission creations
const submissionClients = new Map();

// Cleanup old entries periodically
const cleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [key, value] of clients) {
    if (now - value.windowStart > config.rateLimit.windowMs) {
      clients.delete(key);
    }
  }
  for (const [key, value] of submissionClients) {
    if (now - value.windowStart > config.rateLimit.submissionsWindowMs) {
      submissionClients.delete(key);
    }
  }
}, 60000);
if (cleanupInterval.unref) {
  cleanupInterval.unref();
}

/**
 * Rate limiting middleware
 * Limits requests per IP within a time window
 */
export function rateLimitMiddleware(req, res, next) {
  const clientKey = req.ip || req.connection.remoteAddress;
  const now = Date.now();

  let client = clients.get(clientKey);

  if (!client || now - client.windowStart > config.rateLimit.windowMs) {
    client = { windowStart: now, count: 0 };
    clients.set(clientKey, client);
  }

  client.count++;

  // Set rate limit headers
  res.set('X-RateLimit-Limit', config.rateLimit.maxRequests);
  res.set('X-RateLimit-Remaining', Math.max(0, config.rateLimit.maxRequests - client.count));
  res.set('X-RateLimit-Reset', Math.ceil((client.windowStart + config.rateLimit.windowMs) / 1000));

  if (client.count > config.rateLimit.maxRequests) {
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded. Please try again later.',
      retryAfter: Math.ceil((client.windowStart + config.rateLimit.windowMs - now) / 1000),
    });
  }

  next();
}

/**
 * Submissions rate limiting middleware
 * Dedicated rate limiter for POST /submissions endpoints
 */
export function submissionsRateLimitMiddleware(req, res, next) {
  const clientKey = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = config.rateLimit.submissionsWindowMs;
  const maxRequests = config.rateLimit.submissionsMax;

  let client = submissionClients.get(clientKey);

  if (!client || now - client.windowStart > windowMs) {
    client = { windowStart: now, count: 0 };
    submissionClients.set(clientKey, client);
  }

  client.count++;

  res.set('X-RateLimit-Submissions-Limit', maxRequests);
  res.set('X-RateLimit-Submissions-Remaining', Math.max(0, maxRequests - client.count));
  res.set('X-RateLimit-Submissions-Reset', Math.ceil((client.windowStart + windowMs) / 1000));

  if (client.count > maxRequests) {
    return res.status(429).json({
      error: 'Too Many Requests',
      message: 'Submissions rate limit exceeded. Please slow down.',
      retryAfter: Math.ceil((client.windowStart + windowMs - now) / 1000),
    });
  }

  next();
}

export default rateLimitMiddleware;
