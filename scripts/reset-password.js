#!/usr/bin/env node
'use strict';

/**
 * Reset a student's password by hand.
 *
 * Passwords are hashed with scrypt, which is one-way on purpose: you cannot
 * look up what someone's password was, not even from the server. That is the
 * correct design, but it means that while email delivery is off, a forgotten
 * password is a permanently lost account with no way back in.
 *
 * This closes that hole without weakening anything. It runs on the server, by
 * the operator, with shell access. It is not an endpoint and cannot be reached
 * from the internet.
 *
 * Usage, on the live machine:
 *
 *   fly ssh console --app keen-study -C "node /app/scripts/reset-password.js someone@example.com"
 *
 * It generates a strong temporary password, prints it once, and destroys every
 * existing session for that account. Give the password to the student over a
 * channel you trust and tell them to change it in Settings.
 *
 * Delete this need, rather than this script, by finishing the Resend setup:
 * once RESEND_API_KEY is configured, students reset their own passwords and
 * nobody has to ask you.
 */

const crypto = require('node:crypto');
const path = require('node:path');

const email = process.argv[2];

if (!email || !email.includes('@')) {
  console.error(`
  Reset a password for one account.

    node scripts/reset-password.js <email>

  On the live server:
    fly ssh console --app keen-study -C "node /app/scripts/reset-password.js you@example.com"
`);
  process.exit(1);
}

const dbPath = process.env.DATABASE_PATH
  || path.join(__dirname, '..', 'data', 'keen.db');

const { init, getDb } = require(path.join(__dirname, '..', 'lib', 'db'));
const auth = require(path.join(__dirname, '..', 'lib', 'auth'));

init(dbPath);
const db = getDb();

const user = db.prepare('SELECT id, email, display_name FROM users WHERE lower(email) = lower(?)').get(email);

if (!user) {
  console.error(`\n  No account found for ${email}\n`);
  // Show near-misses, because "no account" is usually a typo or the student
  // signed up with a different address than the one they emailed you from.
  const like = db.prepare("SELECT email FROM users WHERE email LIKE ? LIMIT 5")
    .all(`%${String(email).split('@')[0].slice(0, 4)}%`);
  if (like.length) {
    console.error('  Did you mean one of these?');
    for (const r of like) console.error(`    ${r.email}`);
    console.error('');
  }
  process.exit(1);
}

// Readable but strong: 4 groups of 4 from an unambiguous alphabet, so it can be
// read aloud or typed from a text message without confusing O for 0.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const bytes = crypto.randomBytes(16);
const raw = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
const temp = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;

// setPassword also destroys every existing session for the user, which matters:
// a reset may be happening precisely because someone else has access.
auth.setPassword(user.id, temp);

console.log(`
  ────────────────────────────────────────────────────────────
  Password reset for ${user.display_name} <${user.email}>
  ────────────────────────────────────────────────────────────

  Temporary password:   ${temp}

  All existing sessions for this account have been signed out.

  Send this to them over something you trust, and tell them to change it
  in Settings once they are in. It is shown here once and is not recoverable
  afterwards, because it is hashed the moment it is stored.
`);
