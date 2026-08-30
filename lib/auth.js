'use strict';

const crypto = require('node:crypto');
const { getDb } = require('./db');

const SESSION_DAYS = 30;
const SCRYPT_KEYLEN = 64;

/**
 * Passwords are hashed with scrypt (memory-hard) and a per-user random salt.
 * Format: scrypt$<salt-hex>$<hash-hex>
 */
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length);
    // Constant-time compare to avoid leaking information via timing.
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function validatePassword(password) {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (password.length > 200) return 'Password is too long.';
  return null;
}

/**
 * COPPA: services must not knowingly collect personal information from
 * children under 13 without verifiable parental consent. Keen is 13+ only,
 * enforced here at the point of account creation.
 */
const MIN_AGE = 13;

function validateBirthYear(birthYear) {
  const year = Number(birthYear);
  const currentYear = new Date().getUTCFullYear();
  if (!Number.isInteger(year) || year < 1900 || year > currentYear) {
    return 'Enter a valid birth year.';
  }
  if (currentYear - year < MIN_AGE) {
    return `You must be at least ${MIN_AGE} years old to create an account.`;
  }
  return null;
}

/** Clamp to the real-world range of UTC offsets (-14h to +14h). */
function normalizeTimezoneOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-840, Math.min(840, Math.round(n)));
}

function createUser({ email, password, displayName, birthYear, timezoneOffsetMinutes = 0 }) {
  const db = getDb();
  const normalizedEmail = String(email).trim().toLowerCase();

  if (!validateEmail(normalizedEmail)) throw new AuthError('Enter a valid email address.');
  const pwError = validatePassword(password);
  if (pwError) throw new AuthError(pwError);
  const ageError = validateBirthYear(birthYear);
  if (ageError) throw new AuthError(ageError);

  const name = String(displayName || '').trim() || normalizedEmail.split('@')[0];
  if (name.length > 40) throw new AuthError('Display name is too long.');

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) throw new AuthError('An account with that email already exists.');

  const result = db.prepare(`
    INSERT INTO users (email, display_name, password_hash, plan, birth_year, timezone_offset_minutes, created_at)
    VALUES (?, ?, ?, 'free', ?, ?, ?)
  `).run(
    normalizedEmail,
    name,
    hashPassword(password),
    Number(birthYear),
    normalizeTimezoneOffset(timezoneOffsetMinutes),
    new Date().toISOString()
  );

  return getUserById(Number(result.lastInsertRowid));
}

function getUserById(id) {
  return getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
}

function getUserByEmail(email) {
  return getDb().prepare('SELECT * FROM users WHERE email = ?')
    .get(String(email).trim().toLowerCase()) || null;
}

function authenticate(email, password) {
  const user = getUserByEmail(email);
  // Always run a hash comparison so a missing account and a wrong password
  // take a similar amount of time (avoids user enumeration by timing).
  const stored = user ? user.password_hash : hashPassword('dummy-password-for-timing');
  const ok = verifyPassword(password, stored);
  if (!user || !ok) return null;
  return user;
}

/**
 * Session tokens are stored hashed, never raw.
 *
 * They used to be stored exactly as issued, which meant the sessions table was
 * a list of working passwords. Anyone who got a copy of the database -- a
 * leaked backup, a stolen volume snapshot, a mis-shared file -- could paste any
 * row straight into a cookie and be signed in as that student, with no password
 * needed and nothing in the logs to show it.
 *
 * lib/tokens.js already hashed password-reset tokens for exactly this reason.
 * Sessions were the inconsistency.
 *
 * SHA-256 rather than scrypt here on purpose. Slow hashing exists to make
 * guessing a human-chosen password expensive; this token is 32 bytes of
 * crypto-grade randomness, so guessing is not the threat and a fast digest is
 * the right tool. The raw token exists only in the user's cookie.
 */
function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function createSession(userId) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  // The column holds the HASH. The raw token is returned to the caller, goes
  // into the Set-Cookie header, and is never written down anywhere.
  db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(hashSessionToken(token), userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires };
}

function getSessionUser(token) {
  if (!token) return null;
  const db = getDb();
  const hashed = hashSessionToken(token);
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(hashed);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(hashed);
    return null;
  }
  return getUserById(session.user_id);
}

function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(hashSessionToken(token));
}

/**
 * Change a password and invalidate every existing session for that user.
 *
 * The session wipe is deliberate: a reset may be happening precisely because
 * someone else has access to the account, and leaving their session alive would
 * defeat the point of the reset.
 */
function setPassword(userId, newPassword) {
  const error = validatePassword(newPassword);
  if (error) throw new AuthError(error);
  const db = getDb();
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .run(hashPassword(newPassword), userId);
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return { sessionsRevoked: Number(result.changes || 0) };
}

function markEmailVerified(userId, now = new Date()) {
  getDb().prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
    .run(now.toISOString(), userId);
}

function isEmailVerified(userId) {
  const row = getDb().prepare('SELECT email_verified_at FROM users WHERE id = ?').get(userId);
  return Boolean(row && row.email_verified_at);
}

/**
 * Expired rows are harmless but accumulate forever without this.
 * Called on a timer from the server, and on demand in tests.
 */
function purgeExpiredSessions(now = new Date()) {
  const result = getDb()
    .prepare('DELETE FROM sessions WHERE expires_at < ?')
    .run(now.toISOString());
  return Number(result.changes || 0);
}

/**
 * Pin the question currently issued to a user, so an answer can be checked
 * against what was actually served. Without this, a client could POST any
 * question id repeatedly and inflate its own ability ratings, which would
 * quietly corrupt the adaptive model for that student.
 */
function setPendingQuestion(userId, questionId, now = new Date()) {
  getDb()
    .prepare('UPDATE users SET pending_question_id = ?, pending_issued_at = ? WHERE id = ?')
    .run(questionId, now.toISOString(), userId);
}

function consumePendingQuestion(userId, questionId) {
  const db = getDb();
  const row = db.prepare('SELECT pending_question_id FROM users WHERE id = ?').get(userId);
  if (!row || !row.pending_question_id) return false;
  if (row.pending_question_id !== questionId) return false;
  db.prepare('UPDATE users SET pending_question_id = NULL, pending_issued_at = NULL WHERE id = ?')
    .run(userId);
  return true;
}

class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
    this.statusCode = 400;
  }
}

module.exports = {
  hashPassword,
  verifyPassword,
  createUser,
  getUserById,
  getUserByEmail,
  authenticate,
  createSession,
  getSessionUser,
  destroySession,
  purgeExpiredSessions,
  setPassword,
  markEmailVerified,
  isEmailVerified,
  setPendingQuestion,
  consumePendingQuestion,
  normalizeTimezoneOffset,
  validateEmail,
  validatePassword,
  validateBirthYear,
  AuthError,
  MIN_AGE,
};
