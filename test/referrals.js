'use strict';

/**
 * Referral program tests.
 *
 * The interesting cases here are all abuse cases. A referral program that pays
 * on signup, pays twice for the same friend, or lets an account refer itself is
 * not a growth channel, it is a way to give Premium away for free. Each of
 * those has a test.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP_DB = path.join(require('node:os').tmpdir(), `keen-ref-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
}

const db = require('../lib/db');
db.init(TMP_DB);

const auth = require('../lib/auth');
const referrals = require('../lib/referrals');
const plans = require('../lib/plans');

let passed = 0;
let failed = 0;
const checks = [];
function check(label, fn) { checks.push({ label, fn }); }

let seq = 0;
function makeUser() {
  seq += 1;
  return auth.createUser({
    email: `ref${seq}.${process.pid}@example.com`,
    password: 'password123',
    displayName: `Ref ${seq}`,
    birthYear: 2009,
  });
}

function verifyEmail(userId) {
  db.getDb().prepare('UPDATE users SET email_verified_at = ? WHERE id = ?')
    .run(new Date().toISOString(), userId);
}

// One synthetic question, referenced by every synthetic attempt. Attempts have
// a foreign key onto questions, and seeding the real 27k-question bank for a
// rules test would cost far more time than it proves.
const TEST_QUESTION_ID = `ref-test-q-${process.pid}`;
db.getDb().prepare(`
  INSERT OR IGNORE INTO questions (id, subject, topic, difficulty, prompt, choices, answer, explanation)
  VALUES (?, 'Test Subject', 'Test Topic', 'easy', 'Synthetic prompt', '["a","b"]', 0, 'Synthetic explanation')
`).run(TEST_QUESTION_ID);

function answerQuestions(userId, n) {
  // Attempts are written directly rather than through the quiz endpoint: this
  // suite is about the referral rules, and driving the full adaptive loop would
  // make each case slow and couple it to question-bank contents.
  const insert = db.getDb().prepare(
    `INSERT INTO attempts (user_id, question_id, subject, topic, correct, mode, answered_at)
     VALUES (?, ?, 'Test Subject', 'Test Topic', 1, 'learn', ?)`
  );
  for (let i = 0; i < n; i += 1) {
    insert.run(userId, TEST_QUESTION_ID, new Date().toISOString());
  }
}

// ------------------------------------------------------------------- codes

check('a referral code is allocated once and then reused', () => {
  const user = makeUser();
  const first = referrals.codeFor(user.id);
  const second = referrals.codeFor(user.id);
  assert.strictEqual(first, second, 'a second call issued a different code');
  assert.match(first, /^[A-Z2-9]{7}$/, `unexpected code shape: ${first}`);
});

check('codes avoid characters that are ambiguous when read aloud', () => {
  const codes = new Set();
  for (let i = 0; i < 25; i += 1) codes.add(referrals.codeFor(makeUser().id));
  for (const code of codes) {
    assert.ok(!/[OI01]/.test(code), `code contains an ambiguous character: ${code}`);
  }
  assert.ok(codes.size >= 20, 'codes are colliding far more than they should');
});

// -------------------------------------------------------------- attachment

check('a referred account gets its free days immediately', () => {
  const referrer = makeUser();
  const code = referrals.codeFor(referrer.id);
  const friend = makeUser();

  const result = referrals.attachReferral(friend.id, code);
  assert.ok(result, 'referral was not attached');
  assert.strictEqual(result.days, referrals.REFERRED_DAYS);

  const row = db.getDb().prepare('SELECT premium_until FROM users WHERE id = ?').get(friend.id);
  assert.ok(row.premium_until, 'no premium window was granted to the friend');
  assert.ok(new Date(row.premium_until) > new Date(), 'granted window is already in the past');
  assert.strictEqual(plans.effectivePlan(friend.id).id, 'premium', 'friend is not on Premium');
});

check('a lowercase or padded code still resolves', () => {
  const referrer = makeUser();
  const code = referrals.codeFor(referrer.id);
  const friend = makeUser();
  assert.ok(referrals.attachReferral(friend.id, `  ${code.toLowerCase()} `), 'code matching is too strict');
});

check('an account cannot refer itself', () => {
  const user = makeUser();
  const code = referrals.codeFor(user.id);
  assert.strictEqual(referrals.attachReferral(user.id, code), null, 'self-referral was accepted');
});

check('an unknown code is ignored rather than throwing', () => {
  const friend = makeUser();
  assert.strictEqual(referrals.attachReferral(friend.id, 'ZZZZZZZ'), null);
});

check('an account can only be referred once', () => {
  const a = makeUser();
  const b = makeUser();
  const friend = makeUser();
  assert.ok(referrals.attachReferral(friend.id, referrals.codeFor(a.id)));
  assert.strictEqual(
    referrals.attachReferral(friend.id, referrals.codeFor(b.id)),
    null,
    'a second referrer claimed the same account'
  );
});

// ------------------------------------------------------------------ payout

check('the referrer is not paid at signup', () => {
  const referrer = makeUser();
  const friend = makeUser();
  referrals.attachReferral(friend.id, referrals.codeFor(referrer.id));

  assert.strictEqual(referrals.maybeReward(friend.id), null, 'paid out before activation');
  const row = db.getDb().prepare('SELECT premium_until FROM users WHERE id = ?').get(referrer.id);
  assert.ok(!row.premium_until, 'referrer was granted days at signup');
});

check('an unverified email blocks the payout even after enough questions', () => {
  const referrer = makeUser();
  const friend = makeUser();
  referrals.attachReferral(friend.id, referrals.codeFor(referrer.id));
  answerQuestions(friend.id, referrals.ACTIVATION_QUESTIONS + 5);

  assert.strictEqual(referrals.maybeReward(friend.id), null, 'unverified account triggered a payout');
});

check('the payout lands once the friend verifies and actually studies', () => {
  const referrer = makeUser();
  const friend = makeUser();
  referrals.attachReferral(friend.id, referrals.codeFor(referrer.id));
  verifyEmail(friend.id);
  answerQuestions(friend.id, referrals.ACTIVATION_QUESTIONS);

  const reward = referrals.maybeReward(friend.id);
  assert.ok(reward, 'no payout after activation');
  assert.strictEqual(reward.days, referrals.REFERRER_DAYS);
  assert.strictEqual(plans.effectivePlan(referrer.id).id, 'premium');
});

check('one question short of the threshold does not pay', () => {
  const referrer = makeUser();
  const friend = makeUser();
  referrals.attachReferral(friend.id, referrals.codeFor(referrer.id));
  verifyEmail(friend.id);
  answerQuestions(friend.id, referrals.ACTIVATION_QUESTIONS - 1);
  assert.strictEqual(referrals.maybeReward(friend.id), null, 'paid out below the activation threshold');
});

check('a referral pays exactly once however often it is checked', () => {
  const referrer = makeUser();
  const friend = makeUser();
  referrals.attachReferral(friend.id, referrals.codeFor(referrer.id));
  verifyEmail(friend.id);
  answerQuestions(friend.id, referrals.ACTIVATION_QUESTIONS);

  assert.ok(referrals.maybeReward(friend.id), 'first payout did not happen');
  for (let i = 0; i < 5; i += 1) {
    assert.strictEqual(referrals.maybeReward(friend.id), null, 'paid out more than once');
  }
  const rewarded = db.getDb().prepare(
    "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'rewarded'"
  ).get(referrer.id).n;
  assert.strictEqual(rewarded, 1);
});

// ------------------------------------------------------------------- grants

check('stacked rewards extend the window instead of replacing it', () => {
  const user = makeUser();
  const first = referrals.grantPremiumDays(user.id, 14);
  const second = referrals.grantPremiumDays(user.id, 14);
  const gap = (new Date(second) - new Date(first)) / (24 * 60 * 60 * 1000);
  assert.ok(gap > 13.9 && gap < 14.1, `second grant did not stack: gap was ${gap} days`);
});

check('an expired window is rebuilt from now, not from the past', () => {
  const user = makeUser();
  const longAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  db.getDb().prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(longAgo, user.id);

  const until = new Date(referrals.grantPremiumDays(user.id, 14));
  const days = (until - new Date()) / (24 * 60 * 60 * 1000);
  assert.ok(days > 13.9 && days < 14.1, `expected ~14 days from now, got ${days}`);
});

check('expired referral premium drops the account back to Free', () => {
  const user = makeUser();
  const past = new Date(Date.now() - 1000).toISOString();
  db.getDb().prepare('UPDATE users SET premium_until = ? WHERE id = ?').run(past, user.id);
  assert.strictEqual(plans.effectivePlan(user.id).id, 'free', 'expired grant still counts as Premium');
});

check('rewards stop at the cap', () => {
  const referrer = makeUser();
  const code = referrals.codeFor(referrer.id);

  for (let i = 0; i < referrals.MAX_REWARDED_REFERRALS + 2; i += 1) {
    const friend = makeUser();
    referrals.attachReferral(friend.id, code);
    verifyEmail(friend.id);
    answerQuestions(friend.id, referrals.ACTIVATION_QUESTIONS);
    referrals.maybeReward(friend.id);
  }

  const rewarded = db.getDb().prepare(
    "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'rewarded'"
  ).get(referrer.id).n;
  assert.strictEqual(rewarded, referrals.MAX_REWARDED_REFERRALS, 'the cap did not hold');
});

// ------------------------------------------------------------------ summary

check('the summary reports a usable link and honest counts', () => {
  const referrer = makeUser();
  const pendingFriend = makeUser();
  const activeFriend = makeUser();
  const code = referrals.codeFor(referrer.id);

  referrals.attachReferral(pendingFriend.id, code);
  referrals.attachReferral(activeFriend.id, code);
  verifyEmail(activeFriend.id);
  answerQuestions(activeFriend.id, referrals.ACTIVATION_QUESTIONS);
  referrals.maybeReward(activeFriend.id);

  const summary = referrals.summaryFor(referrer.id, 'https://keen.study');
  assert.strictEqual(summary.link, `https://keen.study/?ref=${summary.code}`);
  assert.strictEqual(summary.pending, 1);
  assert.strictEqual(summary.rewarded, 1);
  assert.ok(summary.shareMessage.includes(summary.link), 'share message omits the link');
  assert.ok(summary.daysRemaining > 0, 'earned days are not reflected in the summary');
});

// ---------------------------------------------------------------------- run

(async () => {
  console.log('\nKeen referral tests\n');
  for (const { label, fn } of checks) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${label}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${label}`);
      console.log(`        ${err.message}`);
    }
  }

  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
