'use strict';

const { PostHog } = require('posthog-node');

const token = process.env.POSTHOG_PROJECT_TOKEN;
const host = process.env.POSTHOG_HOST;
const missingVariables = [
  !token && 'POSTHOG_PROJECT_TOKEN',
  !host && 'POSTHOG_HOST',
].filter(Boolean);

let posthog = null;
if (missingVariables.length === 0) {
  posthog = new PostHog(token, {
    host,
    enableExceptionAutocapture: true,
  });
} else if (process.env.NODE_ENV !== 'production') {
  for (const variable of missingVariables) {
    console.error(new Error(
      `${variable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${variable} is configured`
    ));
  }
}

module.exports = { posthog };
