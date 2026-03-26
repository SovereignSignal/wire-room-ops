/**
 * In-memory rate limiter
 */

const rateLimitStore = new Map<string, number[]>();

// Cleanup stale rate limit entries every 15 minutes
const rateLimitCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of rateLimitStore.entries()) {
    const recent = timestamps.filter(t => now - t < 15 * 60 * 1000);
    if (recent.length === 0) {
      rateLimitStore.delete(key);
    }
  }
}, 15 * 60 * 1000);
rateLimitCleanupTimer.unref();

export function rateLimit(key: string, maxRequests: number, windowMs: number): boolean {
  const now = Date.now();
  const timestamps = rateLimitStore.get(key) || [];
  const recent = timestamps.filter(t => now - t < windowMs);
  if (recent.length >= maxRequests) {
    rateLimitStore.set(key, recent);
    return false;
  }
  recent.push(now);
  rateLimitStore.set(key, recent);
  return true;
}
