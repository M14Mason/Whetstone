#!/usr/bin/env node
'use strict';

/**
 * Pre-launch readiness check.
 *
 * Run this before you tell anyone the URL. It reports BLOCKERS (things that
 * will lose data, leak, or take money incorrectly) separately from WARNINGS
 * (things you can live with for a soft launch).
 *
 *   node scripts/launch-check.js
 *
 * Exit code is 1 if any blocker is present, so CI or a deploy hook can gate on
 * it. It only reads configuration and files; it changes nothing.
 */

const fs = require('fs');
const path = require('path');
const { config } = require('../lib/config');

const blockers = [];
const warnings = [];
const ok = [];

// ---------------------------------------------------------------- database
const dbPath = process.env.DATABASE_PATH || '';
if (!dbPath) {
  warnings.push('DATABASE_PATH is unset; the app will use its default local path.');
} else if (dbPath.startsWith('/tmp')) {
  blockers.push(
    `DATABASE_PATH points at ${dbPath}. On a container this is wiped on every ` +
    'deploy and every sleep, so ALL accounts and progress are lost. Move it to ' +
    'a mounted persistent disk (for example /data/whetstone.db).');
} else {
  ok.push(`Database path is ${dbPath}`);
}

// ---------------------------------------------------------------- secrets
if (config.sessionSecret === 'dev-only-insecure-secret'
    || config.sessionSecret === 'change-me-in-production') {
  blockers.push('SESSION_SECRET is still the default. Anyone who reads the source can forge a session cookie.');
} else if (config.sessionSecret.length < 32) {
  warnings.push(`SESSION_SECRET is only ${config.sessionSecret.length} characters. Use 32 or more.`);
} else {
  ok.push('SESSION_SECRET is set');
}

if (!config.publicUrl.startsWith('https://')) {
  const local = config.publicUrl.includes('localhost') || config.publicUrl.includes('127.0.0.1');
  (local ? warnings : blockers).push(
    `PUBLIC_URL is ${config.publicUrl}. Without https, session cookies are not marked Secure.`);
} else {
  ok.push('PUBLIC_URL is https');
}

// ---------------------------------------------------------------- legal
for (const file of ['TERMS.md', 'PRIVACY.md']) {
  const p = path.join(__dirname, '..', 'legal', file);
  if (!fs.existsSync(p)) {
    blockers.push(`legal/${file} is missing. /api/legal will 404 and your Terms link will not open.`);
    continue;
  }
  const text = fs.readFileSync(p, 'utf8');
  if (text.includes('PARENT_OR_GUARDIAN_LEGAL_NAME')) {
    blockers.push(`legal/${file} still names PARENT_OR_GUARDIAN_LEGAL_NAME as the operator. ` +
      'An adult must be named before you take money.');
  }
  const leftovers = [...new Set((text.match(/\[[A-Z][A-Z ./-]{2,}\]/g) || [])
    .filter((t) => t !== '[BRACKETED]'))];
  if (leftovers.length) {
    blockers.push(`legal/${file} has unfilled placeholders: ${leftovers.join(', ')}`);
  }
}

// ---------------------------------------------------------------- billing
const live = Boolean(config.stripe && config.stripe.secretKey);
if (!live) {
  warnings.push('Billing is in DEMO mode. "Upgrade" grants Premium without charging. ' +
    'Fine for a free launch; a blocker the moment you advertise a price.');
} else {
  ok.push('Stripe keys are present');
  if (!config.stripe.webhookSecret) {
    blockers.push('STRIPE_WEBHOOK_SECRET is missing. Payments will succeed and subscriptions will never activate.');
  }
}

// ---------------------------------------------------------------- email
if (!process.env.RESEND_API_KEY) {
  blockers.push('RESEND_API_KEY is unset. Password resets and verification emails only print to the ' +
    'server log, so a user who forgets their password can never get back in.');
} else {
  ok.push('Email sending is configured');
  if (!process.env.MAIL_FROM) warnings.push('MAIL_FROM is unset; emails will come from the provider default.');
}

// ---------------------------------------------------------------- misc
if (process.env.TRUST_PROXY === '1') ok.push('TRUST_PROXY is on (correct behind Render/Fly)');
else warnings.push('TRUST_PROXY is off. Behind a proxy, rate limiting sees the proxy IP, ' +
  'so one abusive user can rate-limit everybody.');

// ---------------------------------------------------------------- report
const line = (s) => console.log(s);
line('');
line('  WHETSTONE LAUNCH CHECK');
line('  ' + '='.repeat(60));
if (ok.length) {
  line('');
  for (const m of ok) line(`  [ ok ]  ${m}`);
}
if (warnings.length) {
  line('');
  for (const m of warnings) line(`  [warn]  ${m}`);
}
if (blockers.length) {
  line('');
  for (const m of blockers) line(`  [STOP]  ${m}`);
}
line('');
line('  ' + '='.repeat(60));
if (blockers.length) {
  line(`  NOT READY: ${blockers.length} blocker(s). Fix these before launching.`);
  line('');
  process.exit(1);
}
line(`  READY TO LAUNCH${warnings.length ? ` (${warnings.length} warning(s) worth reading)` : ''}.`);
line('');
