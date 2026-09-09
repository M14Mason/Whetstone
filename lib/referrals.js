'use strict';

/**
 * Referral program.
 *
 * Design decisions worth knowing, because each one is a trade-off:
 *
 * 1. The reward is Premium days, never cash. Keen has no payout account and
 *    cannot legally have one yet, and cash rewards attract people who want the
 *    cash rather than the product. Days cost nothing marginal to grant and are
 *    only valuable to someone who actually studies.
 *
 * 2. It is double-sided. The friend arrives with 14 free days rather than an
 *    empty offer, which is what makes the share message worth sending: "here,
 *    have two weeks free" beats "help me get a discount".
 *
 * 3. The reward pays on ACTIVATION, not on signup. A referred account only
 *    counts once it has confirmed its email and answered 10 questions. Paying
 *    on signup is what turns every referral program into a fake-account farm,
 *    and 10 questions is roughly the point where a real student has seen the
 *    product work.
 *
 * 4. Rewards are capped. An uncapped ladder is an invitation to automate it.
 */

const crypto = require('node:crypto');
const { getDb } = require('./db');

// Reward sizing. Both sides get the same amount: an asymmetric split reads as
// the referrer profiting off their friend, which makes people share less.
const REFERRER_DAYS = 14;
const REFERRED_DAYS = 14;

// Questions a referred account must answer before the referral pays out.
const ACTIVATION_QUESTIONS = 10;

// Ceiling on rewarded referrals per account. Roughly six months of Premium,
// which is generous for a real student and uninteresting to a script.
const MAX_REWARDED_REFERRALS = 12;

// Ambiguous characters are left out so a code read aloud or copied off a phone
// screen does not turn into a support conversation.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 7;

class ReferralError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function generateCode() {
  const bytes = crypto.randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return out;
}

/**
 * The user's referral code, created on first request.
 *
 * Generating lazily rather than at signup keeps the signup path fast and means
 * accounts that never open the referral screen never consume a code.
 */
function codeFor(userId) {
  const db = getDb();
  const row = db.prepare('SELECT referral_code FROM users WHERE id = ?').get(userId);
  if (!row) throw new ReferralError('No such user.', 404);
  if (row.referral_code) return row.referral_code;

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateCode();
    const taken = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(code);
    if (taken) continue;
    db.prepare('UPDATE users SET referral_code = ? WHERE id = ?').run(code, userId);
    return code;
  }
  throw new ReferralError('Could not allocate a referral code.', 500);
}

function userByCode(code) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) return null;
  return getDb().prepare('SELECT * FROM users WHERE referral_code = ?').get(clean) || null;
}

/**
 * Add days of Premium to an account.
 *
 * Extends from whichever is later: now, or an existing expiry. Extending from
 * "now" would silently delete unused days from someone who earned two rewards
 * in the same week.
 */
function grantPremiumDays(userId, days) {
  const db = getDb();
  const row = db.prepare('SELECT premium_until FROM users WHERE id = ?').get(userId);
  const existing = row && row.premium_until ? new Date(row.premium_until) : null;
  const base = existing && existing > new Date() ? existing : new Date();
  const until = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  db.prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(until.toISOString(), userId);
  return until.toISOString();
}

/**
 * Record that a new account arrived through someone's code.
 *
 * Called during signup. The referred side's free days are granted immediately,
 * because that is the promise the landing message made. The referrer's reward
 * waits for activation.
 */
function attachReferral(referredUserId, code) {
  const db = getDb();
  const referrer = userByCode(code);
  if (!referrer) return null;
  if (referrer.id === referredUserId) return null; // self-referral

  const already = db.prepare('SELECT id FROM referrals WHERE referred_id = ?').get(referredUserId);
  if (already) return null; // an account can only ever be referred once

  db.prepare(`
    INSERT INTO referrals (referrer_id, referred_id, code, status, created_at)
    VALUES (?, ?, ?, 'pending', ?)
  `).run(referrer.id, referredUserId, String(code).trim().toUpperCase(), new Date().toISOString());

  grantPremiumDays(referredUserId, REFERRED_DAYS);
  return { referrerId: referrer.id, referrerName: referrer.display_name, days: REFERRED_DAYS };
}

/**
 * Pay out any referral this user has now qualified for.
 *
 * Safe to call on every answer: it exits immediately unless there is a pending
 * referral, and the status flip is what makes it idempotent.
 */
function maybeReward(referredUserId) {
  const db = getDb();
  const pending = db.prepare(
    "SELECT * FROM referrals WHERE referred_id = ? AND status = 'pending'"
  ).get(referredUserId);
  if (!pending) return null;

  const user = db.prepare('SELECT email_verified_at FROM users WHERE id = ?').get(referredUserId);
  if (!user || !user.email_verified_at) return null;

  const answered = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ?')
    .get(referredUserId).n;
  if (answered < ACTIVATION_QUESTIONS) return null;

  const rewarded = db.prepare(
    "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'rewarded'"
  ).get(pending.referrer_id).n;

  if (rewarded >= MAX_REWARDED_REFERRALS) {
    db.prepare("UPDATE referrals SET status = 'capped', rewarded_at = ? WHERE id = ?")
      .run(new Date().toISOString(), pending.id);
    return null;
  }

  grantPremiumDays(pending.referrer_id, REFERRER_DAYS);
  db.prepare("UPDATE referrals SET status = 'rewarded', rewarded_at = ? WHERE id = ?")
    .run(new Date().toISOString(), pending.id);

  return { referrerId: pending.referrer_id, days: REFERRER_DAYS };
}

/**
 * Everything the referral screen needs: the code, the link, and honest counts.
 *
 * "Pending" is shown separately from "joined" on purpose. A referrer who sees
 * "1 friend joined, waiting on them to answer 10 questions" knows to nudge
 * their friend; a single blended number tells them nothing actionable.
 */
function summaryFor(userId, origin) {
  const db = getDb();
  const code = codeFor(userId);

  const rows = db.prepare(
    'SELECT status, COUNT(*) AS n FROM referrals WHERE referrer_id = ? GROUP BY status'
  ).all(userId);
  const counts = Object.fromEntries(rows.map((r) => [r.status, r.n]));

  const user = db.prepare('SELECT premium_until FROM users WHERE id = ?').get(userId);
  const until = user && user.premium_until ? new Date(user.premium_until) : null;
  const active = until && until > new Date();

  return {
    code,
    link: `${origin}/?ref=${code}`,
    pending: counts.pending || 0,
    rewarded: counts.rewarded || 0,
    capped: counts.capped || 0,
    remaining: Math.max(0, MAX_REWARDED_REFERRALS - (counts.rewarded || 0)),
    daysPerReferral: REFERRER_DAYS,
    friendDays: REFERRED_DAYS,
    activationQuestions: ACTIVATION_QUESTIONS,
    premiumUntil: active ? until.toISOString() : null,
    daysRemaining: active ? Math.ceil((until - new Date()) / (24 * 60 * 60 * 1000)) : 0,
    shareMessage:
      `I've been using Keen to study - it works out which units you keep getting wrong `
      + `and drills those instead of the stuff you already know. Here's 14 days of Premium free: `
      + `${origin}/?ref=${code}`,
  };
}

module.exports = {
  ReferralError,
  codeFor,
  userByCode,
  attachReferral,
  maybeReward,
  grantPremiumDays,
  summaryFor,
  REFERRER_DAYS,
  REFERRED_DAYS,
  ACTIVATION_QUESTIONS,
  MAX_REWARDED_REFERRALS,
};
