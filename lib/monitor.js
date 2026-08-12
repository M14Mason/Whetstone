'use strict';

/**
 * Error reporting and lightweight request metrics.
 *
 * Without this you find out the app is broken when a user tells you, which for
 * a product with no users means never. Two layers:
 *
 *   1. Structured JSON error logs, so hosting platforms can index them.
 *   2. Optional Sentry reporting over its plain HTTP "store" endpoint, so there
 *      is no SDK dependency. Set SENTRY_DSN to enable.
 *
 * An in-memory counter also powers /api/health, which is enough to answer "is
 * anything erroring right now" without any external service at all.
 */

const stats = {
  startedAt: new Date().toISOString(),
  requests: 0,
  errors: 0,
  errorsByRoute: new Map(),
  recentErrors: [],
};

const MAX_RECENT = 20;

/** Parse a Sentry DSN into the pieces needed to post an event. */
function parseDsn(dsn) {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, '');
    if (!projectId || !url.username) return null;
    return {
      endpoint: `${url.protocol}//${url.host}/api/${projectId}/store/`,
      publicKey: url.username,
    };
  } catch {
    return null;
  }
}

const sentry = process.env.SENTRY_DSN ? parseDsn(process.env.SENTRY_DSN) : null;
if (process.env.SENTRY_DSN && !sentry) {
  console.warn('  WARNING: SENTRY_DSN is set but could not be parsed. Error reporting is off.');
}

function isMonitoringLive() {
  return Boolean(sentry);
}

async function sendToSentry(error, context) {
  if (!sentry) return;
  try {
    await fetch(sentry.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': [
          'Sentry sentry_version=7',
          'sentry_client=whetstone/1.0',
          `sentry_key=${sentry.publicKey}`,
        ].join(', '),
      },
      body: JSON.stringify({
        timestamp: new Date().toISOString(),
        platform: 'node',
        level: 'error',
        environment: process.env.NODE_ENV || 'production',
        server_name: process.env.FLY_APP_NAME || undefined,
        exception: {
          values: [{
            type: error.name || 'Error',
            value: error.message,
            stacktrace: { frames: parseStack(error.stack) },
          }],
        },
        extra: context,
      }),
    });
  } catch (err) {
    // Never let the reporter become the outage.
    console.error('[monitor] failed to report error:', err.message);
  }
}

function parseStack(stack) {
  if (!stack) return [];
  return String(stack)
    .split('\n')
    .slice(1, 21)
    .map((line) => {
      const m = line.match(/at\s+(.*?)\s+\((.*):(\d+):(\d+)\)/);
      if (!m) return { function: line.trim() };
      return { function: m[1], filename: m[2], lineno: Number(m[3]), colno: Number(m[4]) };
    })
    .reverse(); // Sentry expects oldest frame first
}

function recordRequest() {
  stats.requests++;
}

function recordError(error, context = {}) {
  stats.errors++;
  const route = context.route || 'unknown';
  stats.errorsByRoute.set(route, (stats.errorsByRoute.get(route) || 0) + 1);

  stats.recentErrors.push({
    at: new Date().toISOString(),
    route,
    message: error.message,
  });
  while (stats.recentErrors.length > MAX_RECENT) stats.recentErrors.shift();

  // Structured single-line JSON so log aggregators can parse it.
  console.error(JSON.stringify({
    level: 'error',
    at: new Date().toISOString(),
    route,
    message: error.message,
    stack: error.stack ? String(error.stack).split('\n').slice(0, 6).join(' | ') : undefined,
    ...context,
  }));

  // Fire and forget; do not make the user wait on the reporter.
  void sendToSentry(error, context);
}

function snapshot() {
  return {
    startedAt: stats.startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    requests: stats.requests,
    errors: stats.errors,
    errorRate: stats.requests === 0 ? 0 : Math.round((stats.errors / stats.requests) * 10000) / 100,
    topErrorRoutes: [...stats.errorsByRoute]
      .sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([route, count]) => ({ route, count })),
    monitoring: isMonitoringLive() ? 'sentry' : 'logs only',
    memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
}

function reset() {
  stats.requests = 0;
  stats.errors = 0;
  stats.errorsByRoute.clear();
  stats.recentErrors.length = 0;
}

module.exports = { recordRequest, recordError, snapshot, reset, isMonitoringLive, parseDsn };
