'use strict';

/**
 * Single-use, expiring tokens for password reset and email verification.
 *
 * Design notes, all of which matter for security:
 *
 *  - The token is 32 random bytes. Guessing is not feasible.
 *  - Only a SHA-256 hash is stored. A database leak therefore does not hand an
 *    attacker working reset links. (Plain SHA-256 is fine here, unlike for
 *    passwords, because the input is already high-entropy random.)
 *  - Tokens are single use: consuming one marks it used, so a link forwarded or
 *    left in a browser history cannot be replayed.
 *  - Issuing a new token of a purpose invalidates that user's older ones, so a
 *    stolen older link stops working as soon as the user requests a new one.
 *  - Password reset also destroys all existing sessions, on the assumption that
 *    a reset may be happening because someone else has access.
 */

const crypto = require('node:crypto');
const { getDb } = require('./db');

const PURPOSE = {
  RESET: 'password_reset',
  VERIFY: 'email_verify',
};

const TTL_MS = {
  [PURPOSE.RESET]: 60 * 60 * 1000,           // 1 hour
  [PURPOSE.VERIFY]: 24 * 60 * 60 * 1000,     // 24 hours
};

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function issue(userId, purpose, now = new Date()) {
  if (!Object.values(PURPOSE).includes(purpose)) {
    throw new Error(`Unknown token purpose: ${purpose}`);
  }
  const db = getDb();

  // Supersede any outstanding tokens of the same purpose for this user.
  db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND purpose = ?').run(userId, purpose);

  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(now.getTime() + TTL_MS[purpose]);

  db.prepare(`
    INSERT INTO auth_tokens (token_hash, user_id, purpose, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(hashToken(token), userId, purpose, now.toISOString(), expires.toISOString());

  return { token, expiresAt: expires };
}

/**
 * Validate and consume a token. Returns the user id, or null for any failure
 * (unknown, wrong purpose, expired, already used). Callers should not
 * distinguish these cases to the client.
 */
function consume(token, purpose, now = new Date()) {
  if (!token) return null;
  const db = getDb();
  const row = db.prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(hashToken(token));

  if (!row) return null;
  if (row.purpose !== purpose) return null;
  if (row.used_at) return null;
  if (new Date(row.expires_at) < now) return null;

  db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ?')
    .run(now.toISOString(), row.token_hash);

  return row.user_id;
}

/** Look up a token without consuming it, so a form can be shown before submit. */
function peek(token, purpose, now = new Date()) {
  if (!token) return null;
  const row = getDb().prepare('SELECT * FROM auth_tokens WHERE token_hash = ?').get(hashToken(token));
  if (!row || row.purpose !== purpose || row.used_at) return null;
  if (new Date(row.expires_at) < now) return null;
  return row.user_id;
}

function purgeExpired(now = new Date()) {
  const result = getDb()
    .prepare('DELETE FROM auth_tokens WHERE expires_at < ? OR used_at IS NOT NULL')
    .run(now.toISOString());
  return Number(result.changes || 0);
}

module.exports = { issue, consume, peek, purgeExpired, hashToken, PURPOSE, TTL_MS };
