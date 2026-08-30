'use strict';

/**
 * Optional PostHog analytics.
 *
 * This module took the whole site down. It required 'posthog-node' at the top
 * level, the Dockerfile never ran `npm install` (this app was built with zero
 * dependencies on purpose), so the package was absent from the image, the
 * require threw MODULE_NOT_FOUND, and the server exited before it could ever
 * listen. Fly restarted it, it crashed again, and the machine ended up stopped
 * with the site returning nothing.
 *
 * Two separate faults, both fixed:
 *   1. The Dockerfile now installs dependencies, so the package is present.
 *   2. Analytics is never load-bearing. Nothing about counting page views
 *      should be able to stop students studying, so the require is guarded and
 *      a missing or broken package degrades to "no analytics" rather than
 *      "no website".
 */
let PostHog = null;
try {
  ({ PostHog } = require('posthog-node'));
} catch {
  // Not installed. Not worth crashing over.
}

const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;

let posthog = null;

if (PostHog && token && host) {
  try {
    posthog = new PostHog(token, { host, enableExceptionAutocapture: true });
  } catch (err) {
    console.warn(`  PostHog failed to initialise, continuing without it: ${err.message}`);
  }
} else if (process.env.NODE_ENV !== 'production') {
  // A one-line note in development only. Printing a stack trace at boot for an
  // optional integration teaches people to ignore stack traces.
  const missing = [
    !PostHog && 'the posthog-node package',
    !token && 'POSTHOG_PROJECT_TOKEN',
    !host && 'POSTHOG_HOST',
  ].filter(Boolean);
  console.log(`  PostHog disabled (missing: ${missing.join(', ')}).`);
}

module.exports = { posthog };
