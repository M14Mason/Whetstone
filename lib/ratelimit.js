'use strict';

/**
 * In-memory sliding-window rate limiter.
 *
 * Without this, the login endpoint is an open door for credential stuffing:
 * an attacker can try passwords as fast as the network allows. scrypt hashing
 * makes each guess expensive for the server too, so unlimited attempts are
 * also a cheap denial-of-service.
 *
 * Scope: this counts per process. Running several instances behind a load
 * balancer means each gets its own allowance, so move to Redis (or a shared
 * store) before scaling horizontally.
 */

const buckets = new Map();

function hit(key, { limit, windowMs }, now = Date.now()) {
  const cutoff = now - windowMs;
  const timestamps = (buckets.get(key) || []).filter((t) => t > cutoff);
  timestamps.push(now);
  buckets.set(key, timestamps);

  const allowed = timestamps.length <= limit;
  const retryAfterMs = allowed ? 0 : Math.max(0, timestamps[0] + windowMs - now);

  return {
    allowed,
    remaining: Math.max(0, limit - timestamps.length),
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  };
}

function reset(key) {
  if (key === undefined) buckets.clear();
  else buckets.delete(key);
}

/** Drop empty buckets so the map does not grow without bound. */
function sweep(windowMs = 60 * 60 * 1000, now = Date.now()) {
  const cutoff = now - windowMs;
  for (const [key, timestamps] of buckets) {
    const live = timestamps.filter((t) => t > cutoff);
    if (live.length === 0) buckets.delete(key);
    else buckets.set(key, live);
  }
  return buckets.size;
}

// Tuned to be invisible to real students and painful for scripts.
const LIMITS = {
  login: { limit: 10, windowMs: 15 * 60 * 1000 },   // 10 attempts / 15 min / IP
  signup: { limit: 5, windowMs: 60 * 60 * 1000 },   // 5 new accounts / hour / IP
  // Reset and verification send email. Unlimited requests would let someone
  // use the app to spam a third party's inbox.
  reset: { limit: 5, windowMs: 60 * 60 * 1000 },
  verify: { limit: 5, windowMs: 60 * 60 * 1000 },
  // Bug reports are unauthenticated-friendly, so cap them or the table becomes
  // a spam target.
  bugs: { limit: 12, windowMs: 60 * 60 * 1000 },
  write: { limit: 240, windowMs: 60 * 1000 },       // general write ceiling
};

module.exports = { hit, reset, sweep, LIMITS };
