#!/usr/bin/env node
'use strict';

/**
 * Mark the owner account's email as confirmed.
 *
 * The metrics dashboard requires a confirmed email, which is the right rule:
 * it means knowing the admin address is not enough to reach it, you need the
 * inbox. But it locks out the owner when confirmation mail has not arrived,
 * and that is a chicken-and-egg you cannot solve from inside the app.
 *
 * This is deliberately a server-side script rather than a web route. Running
 * it requires shell access to the machine, which is a far higher bar than
 * anything reachable over HTTP, so adding it does not widen the attack
 * surface of the dashboard at all.
 *
 * It will only ever touch the single account named by ADMIN_EMAIL, and it
 * refuses to create one.
 *
 *   fly ssh console -C "node /app/scripts/verify-admin.js"
 */

const { init, getDb } = require('../lib/db');
const { config } = require('../lib/config');

init();
const db = getDb();

const email = config.adminEmail;
const user = db.prepare('SELECT id, email, email_verified_at FROM users WHERE lower(email) = ?').get(email);

if (!user) {
  console.error(`\n  No account exists for ${email}.`);
  console.error('  Sign up with that address first, then run this again.\n');
  process.exit(1);
}

if (user.email_verified_at) {
  console.log(`\n  ${user.email} was already confirmed on ${user.email_verified_at}.`);
  console.log('  Nothing to do. /admin should already open for you.\n');
  process.exit(0);
}

const now = new Date().toISOString();
db.prepare('UPDATE users SET email_verified_at = ? WHERE id = ?').run(now, user.id);

console.log(`\n  Confirmed ${user.email}.`);
console.log('  Open https://keenlearning.org/admin while signed in as that account.\n');
