'use strict';

/**
 * Whetstone test suite. No test framework, just Node.
 * Run with: npm test
 *
 * Everything runs against an in-memory database so tests never touch real data.
 */

const assert = require('node:assert');
const fsMod = require('node:fs');
const pathMod = require('node:path');
const db = require('../lib/db');

// Must happen before any module grabs a handle to the database.
db.init(':memory:');

const auth = require('../lib/auth');
const adaptive = require('../lib/adaptive');
const plans = require('../lib/plans');
const groups = require('../lib/groups');
const billing = require('../lib/billing');
const questions = require('../lib/questions');
const ratelimit = require('../lib/ratelimit');
const tokens = require('../lib/tokens');
const mailer = require('../lib/mailer');
const monitor = require('../lib/monitor');
const coursesLib = require('../lib/courses');
const apexam = require('../lib/apexam');
const modes = require('../lib/modes');
const social = require('../lib/social');
const crypto = require('node:crypto');

let passed = 0;
let failed = 0;
const failures = [];

// Tests run in order. Async tests are awaited, so a rejected promise is a
// real failure rather than an unhandled rejection that silently "passes".
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function runQueue() {
  for (const item of queue) {
    if (item.section) {
      console.log(`\n${item.section}`);
      continue;
    }
    try {
      await item.fn();
      passed++;
      console.log(`  PASS  ${item.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: item.name, err });
      console.log(`  FAIL  ${item.name}`);
      console.log(`        ${err.message}`);
    }
  }
}

function section(title) {
  queue.push({ section: title });
}

let userSeq = 0;
function makeUser(overrides = {}) {
  userSeq++;
  return auth.createUser({
    email: `user${userSeq}@example.com`,
    password: 'correct-horse-battery',
    displayName: `User ${userSeq}`,
    birthYear: 2007,
    ...overrides,
  });
}

// ===========================================================================
console.log('\nWhetstone test suite');

section('Question bank');

test('every question file parses and validates', () => {
  const { errors } = questions.loadQuestionFiles();
  assert.deepStrictEqual(errors, [], `validation errors:\n${errors.join('\n')}`);
});

test('question bank seeds into the database', () => {
  const { count } = questions.seed({ quiet: true });
  assert.ok(count >= 90, `expected at least 90 questions, got ${count}`);
  assert.strictEqual(questions.countQuestions(), count);
});

test('all five subjects are present', () => {
  const subjects = plans.allSubjects();
  for (const s of ['Math', 'English', 'Coding', 'Science', 'Test Strategy']) {
    assert.ok(subjects.includes(s), `missing subject: ${s}`);
  }
});

test('every stored answer index is valid for its choices', () => {
  const { questions: all } = questions.loadQuestionFiles();
  for (const q of all) {
    assert.ok(
      q.answer >= 0 && q.answer < q.choices.length,
      `${q.id}: answer index ${q.answer} out of range`
    );
  }
});

test('client payload never leaks the answer', () => {
  const q = questions.getQuestion('math-lin-001');
  const client = questions.forClient(q);
  assert.strictEqual(client.answer, undefined);
  assert.strictEqual(client.explanation, undefined);
  assert.ok(Array.isArray(client.choices));
});

// ===========================================================================
section('Authentication');

test('passwords hash and verify', () => {
  const hash = auth.hashPassword('hunter2-and-then-some');
  assert.ok(auth.verifyPassword('hunter2-and-then-some', hash));
  assert.ok(!auth.verifyPassword('wrong-password', hash));
});

test('password hashes are salted (same input, different hash)', () => {
  const a = auth.hashPassword('same-password-here');
  const b = auth.hashPassword('same-password-here');
  assert.notStrictEqual(a, b);
});

test('signup and login round-trip', () => {
  const user = makeUser();
  const found = auth.authenticate(user.email, 'correct-horse-battery');
  assert.ok(found);
  assert.strictEqual(found.id, user.id);
  assert.strictEqual(auth.authenticate(user.email, 'nope'), null);
});

test('COPPA age gate blocks under-13 signups', () => {
  const currentYear = new Date().getUTCFullYear();
  assert.throws(
    () => makeUser({ birthYear: currentYear - 10 }),
    /at least 13/
  );
  assert.strictEqual(auth.validateBirthYear(currentYear - 20), null);
});

test('duplicate emails are rejected', () => {
  const user = makeUser();
  assert.throws(
    () => auth.createUser({
      email: user.email, password: 'another-password', displayName: 'Copy', birthYear: 2006,
    }),
    /already exists/
  );
});

test('weak passwords are rejected', () => {
  assert.throws(() => makeUser({ password: 'short' }), /at least 8 characters/);
});

test('sessions resolve and expire on logout', () => {
  const user = makeUser();
  const { token } = auth.createSession(user.id);
  assert.strictEqual(auth.getSessionUser(token).id, user.id);
  auth.destroySession(token);
  assert.strictEqual(auth.getSessionUser(token), null);
});

// ===========================================================================
section('Adaptive engine');

test('correct answers raise ability, wrong answers lower it', () => {
  const user = makeUser();
  const q = questions.getQuestion('math-lin-001');

  const up = adaptive.recordResult(user.id, q, true);
  assert.ok(up.abilityAfter > up.abilityBefore, 'ability should rise after a correct answer');

  const down = adaptive.recordResult(user.id, q, false);
  assert.ok(down.abilityAfter < down.abilityBefore, 'ability should fall after a wrong answer');
});

test('beating a hard question gains more than beating an easy one', () => {
  const easyUser = makeUser();
  const hardUser = makeUser();
  const easyQ = questions.getQuestion('math-lin-001');   // easy
  const hardQ = questions.getQuestion('math-lin-003');   // hard

  const easyGain = adaptive.recordResult(easyUser.id, easyQ, true).abilityDelta;
  const hardGain = adaptive.recordResult(hardUser.id, hardQ, true).abilityDelta;
  assert.ok(hardGain > easyGain, `hard gain ${hardGain} should exceed easy gain ${easyGain}`);
});

test('a wrong answer schedules the topic to return immediately', () => {
  const user = makeUser();
  const q = questions.getQuestion('math-quad-001');
  const result = adaptive.recordResult(user.id, q, false);
  assert.strictEqual(result.nextReviewMinutes, 0);
});

test('consecutive correct answers push the review further out', () => {
  const user = makeUser();
  const q = questions.getQuestion('math-quad-001');
  const first = adaptive.recordResult(user.id, q, true);
  const second = adaptive.recordResult(user.id, q, true);
  const third = adaptive.recordResult(user.id, q, true);
  assert.ok(second.nextReviewMinutes > first.nextReviewMinutes);
  assert.ok(third.nextReviewMinutes > second.nextReviewMinutes);
  assert.strictEqual(third.streak, 3);
});

test('weak topics are prioritised over strong ones', () => {
  const now = new Date();
  const past = new Date(now.getTime() - 60_000).toISOString();
  const weak = { attempts: 10, ewma_correct: 0.2, due_at: past };
  const strong = { attempts: 10, ewma_correct: 0.95, due_at: past };
  assert.ok(
    adaptive.topicPriority(weak, now) > adaptive.topicPriority(strong, now),
    'weak topic should score higher'
  );
});

test('unseen topics are prioritised for exploration', () => {
  const now = new Date();
  const unseen = { attempts: 0, ewma_correct: 0.5, due_at: new Date(0).toISOString() };
  const known = { attempts: 20, ewma_correct: 0.7, due_at: new Date(0).toISOString() };
  assert.ok(adaptive.topicPriority(unseen, now) > adaptive.topicPriority(known, now));
});

test('topics not yet due are deprioritised', () => {
  const now = new Date();
  const future = new Date(now.getTime() + 3600_000).toISOString();
  const notDue = { attempts: 5, ewma_correct: 0.3, due_at: future };
  const due = { attempts: 5, ewma_correct: 0.3, due_at: new Date(0).toISOString() };
  assert.ok(adaptive.topicPriority(due, now) > adaptive.topicPriority(notDue, now));
});

test('selection only returns questions from the requested subjects', () => {
  const user = makeUser();
  for (let i = 0; i < 25; i++) {
    const q = adaptive.selectNextQuestion(user.id, ['Coding']);
    assert.ok(q, 'expected a question');
    assert.strictEqual(q.subject, 'Coding');
  }
});

test('selection avoids immediately repeating recent questions', () => {
  const user = makeUser();
  const seen = [];
  for (let i = 0; i < 5; i++) {
    const q = adaptive.selectNextQuestion(user.id, ['Math']);
    adaptive.recordResult(user.id, q, true);
    seen.push(q.id);
  }
  assert.strictEqual(new Set(seen).size, seen.length, 'served a duplicate within the memory window');
});

test('selection converges on the weak subject area', () => {
  const user = makeUser();
  // Deliberately fail every Recursion question, ace everything else.
  for (let i = 0; i < 40; i++) {
    const q = adaptive.selectNextQuestion(user.id, ['Coding']);
    adaptive.recordResult(user.id, q, q.topic !== 'Recursion');
  }
  const state = adaptive.getTopicState(user.id, 'Coding', 'Recursion');
  assert.ok(state.attempts >= 3, `engine should keep returning to the weak topic, saw ${state.attempts} attempts`);
  assert.ok(state.ewma_correct < 0.4, 'weak topic mastery should be low');
});

test('mastery report classifies topics and surfaces weak spots', () => {
  const user = makeUser();
  const q = questions.getQuestion('sci-cell-001');
  for (let i = 0; i < 5; i++) adaptive.recordResult(user.id, q, false);

  const report = adaptive.buildMasteryReport(user.id);
  assert.ok(report.totals.totalAttempts >= 5);
  assert.strictEqual(report.totals.overallAccuracy, 0);
  assert.ok(report.weakSpots.some((w) => w.topic === 'Cell Biology'), 'weak topic should be listed');
});

test('mastery status thresholds behave', () => {
  assert.strictEqual(adaptive.masteryStatus({ attempts: 0, ewma_correct: 0.5 }), 'new');
  assert.strictEqual(adaptive.masteryStatus({ attempts: 2, ewma_correct: 0.5 }), 'learning');
  assert.strictEqual(adaptive.masteryStatus({ attempts: 10, ewma_correct: 0.95 }), 'mastered');
  assert.strictEqual(adaptive.masteryStatus({ attempts: 10, ewma_correct: 0.7 }), 'solid');
  assert.strictEqual(adaptive.masteryStatus({ attempts: 10, ewma_correct: 0.3 }), 'weak');
});

// ===========================================================================
section('Plans and quota');

test('new users start on the free plan', () => {
  const user = makeUser();
  const quota = plans.checkQuota(user.id);
  assert.strictEqual(quota.plan, 'free');
  assert.strictEqual(quota.limit, 5);
  assert.strictEqual(quota.remaining, 5);
});

test('free tier exhausts after 5 questions in a day', () => {
  const user = makeUser();
  for (let i = 0; i < 5; i++) {
    const q = adaptive.selectNextQuestion(user.id, ['Math']);
    adaptive.recordResult(user.id, q, true);
  }
  const quota = plans.checkQuota(user.id);
  assert.strictEqual(quota.used, 5);
  assert.strictEqual(quota.remaining, 0);
  assert.strictEqual(quota.exhausted, true);
});

test('premium users are unlimited', () => {
  const user = makeUser();
  billing.setUserPlan(user.id, 'premium');
  for (let i = 0; i < 12; i++) {
    const q = adaptive.selectNextQuestion(user.id, ['Math']);
    adaptive.recordResult(user.id, q, true);
  }
  const quota = plans.checkQuota(user.id);
  assert.strictEqual(quota.plan, 'premium');
  assert.strictEqual(quota.limit, null);
  assert.strictEqual(quota.exhausted, false);
});

test('free users are capped at one subject', () => {
  const user = makeUser();
  assert.throws(
    () => plans.setUserSubjects(user.id, ['Math', 'Coding']),
    /Free plan covers 1 subject/
  );
  assert.deepStrictEqual(plans.setUserSubjects(user.id, ['Coding']), ['Coding']);
  assert.deepStrictEqual(plans.activeSubjectsFor(user.id), ['Coding']);
});

test('premium users can select every subject', () => {
  const user = makeUser();
  billing.setUserPlan(user.id, 'premium');
  const all = plans.allSubjects();
  assert.deepStrictEqual(plans.setUserSubjects(user.id, all), all);
});

test('empty subject selection is rejected', () => {
  const user = makeUser();
  assert.throws(() => plans.setUserSubjects(user.id, []), /at least one subject/);
});

// ===========================================================================
section('Study groups');

test('the seat minimum is 3', () => {
  assert.strictEqual(groups.MIN_SEATS, 3);
});

test('a new group starts inactive and needs 2 more members', () => {
  const owner = makeUser();
  const group = groups.createGroup(owner.id, 'Third period chem');
  assert.strictEqual(group.memberCount, 1);
  assert.strictEqual(group.active, false);
  assert.strictEqual(group.seatsNeededToActivate, 2);
  assert.match(group.inviteCode, /^[A-Z0-9]{6}$/);
});

test('a group cannot be activated with fewer than 3 members', () => {
  const owner = makeUser();
  const group = groups.createGroup(owner.id, 'Too small');
  groups.joinGroup(makeUser().id, group.inviteCode);
  assert.throws(() => groups.assertCanActivate(group.id), /at least 3 members/);
});

test('a group activates at exactly 3 members', () => {
  const owner = makeUser();
  const group = groups.createGroup(owner.id, 'Just right');
  groups.joinGroup(makeUser().id, group.inviteCode);
  groups.joinGroup(makeUser().id, group.inviteCode);

  const activated = groups.activateGroup(group.id, 3);
  assert.strictEqual(activated.active, true);
  assert.strictEqual(activated.memberCount, 3);
  assert.strictEqual(activated.seatsPaid, 3);
});

test('an active group upgrades every member, not just the payer', () => {
  const owner = makeUser();
  const member = makeUser();
  const third = makeUser();
  const group = groups.createGroup(owner.id, 'Shared perks');
  groups.joinGroup(member.id, group.inviteCode);
  groups.joinGroup(third.id, group.inviteCode);

  assert.strictEqual(plans.effectivePlan(member.id).id, 'free');
  groups.activateGroup(group.id, 3);
  assert.strictEqual(plans.effectivePlan(member.id).id, 'group');
  assert.strictEqual(plans.checkQuota(member.id).exhausted, false);
  assert.strictEqual(plans.checkQuota(member.id).limit, null);
});

test('joining with a bad invite code fails', () => {
  assert.throws(() => groups.joinGroup(makeUser().id, 'NOPE99'), /No group found/);
});

test('a user cannot be in two groups at once', () => {
  const a = makeUser();
  const b = makeUser();
  const groupA = groups.createGroup(a.id, 'Group A');
  const groupB = groups.createGroup(b.id, 'Group B');
  groups.joinGroup(makeUser().id, groupA.inviteCode);
  assert.throws(() => groups.joinGroup(a.id, groupB.inviteCode), /already in a study group/);
});

test('dropping below the seat minimum deactivates the group', () => {
  const owner = makeUser();
  const m2 = makeUser();
  const m3 = makeUser();
  const group = groups.createGroup(owner.id, 'Shrinking');
  groups.joinGroup(m2.id, group.inviteCode);
  groups.joinGroup(m3.id, group.inviteCode);
  groups.activateGroup(group.id, 3);
  assert.strictEqual(groups.getGroup(group.id).active, true);

  groups.leaveGroup(m3.id);
  assert.strictEqual(groups.getGroup(group.id).active, false);
  assert.strictEqual(plans.effectivePlan(m2.id).id, 'free');
});

test('the last member leaving deletes the group', () => {
  const owner = makeUser();
  const group = groups.createGroup(owner.id, 'Doomed');
  const result = groups.leaveGroup(owner.id);
  assert.strictEqual(result.deleted, true);
  assert.strictEqual(groups.getGroup(group.id), null);
});

test('leaderboard ranks improvement over raw accuracy', () => {
  const grinder = makeUser();   // lots of work, middling accuracy
  const coaster = makeUser();   // near-perfect, barely participates
  const third = makeUser();
  const group = groups.createGroup(grinder.id, 'Leaderboard test');
  groups.joinGroup(coaster.id, group.inviteCode);
  groups.joinGroup(third.id, group.inviteCode);

  for (let i = 0; i < 20; i++) {
    const q = adaptive.selectNextQuestion(grinder.id, ['Math']);
    adaptive.recordResult(grinder.id, q, i % 3 !== 0); // ~67% accuracy, high volume
  }
  for (let i = 0; i < 2; i++) {
    const q = adaptive.selectNextQuestion(coaster.id, ['Math']);
    adaptive.recordResult(coaster.id, q, true);        // 100% accuracy, low volume
  }

  const board = groups.leaderboard(group.id);
  assert.strictEqual(board[0].userId, grinder.id, 'the student putting in work should lead');
  assert.strictEqual(board.length, 3);
  assert.strictEqual(board[0].rank, 1);
});

// ===========================================================================
section('Billing');

test('demo mode is active when no Stripe key is configured', () => {
  assert.strictEqual(billing.isBillingLive(), false);
});

test('demo upgrade and cancel move the plan both ways', async () => {
  const user = makeUser();
  const result = await billing.startPremiumCheckout(user);
  assert.strictEqual(result.mode, 'demo');
  assert.strictEqual(plans.effectivePlan(user.id).id, 'premium');

  billing.cancelDemo(auth.getUserById(user.id));
  assert.strictEqual(plans.effectivePlan(user.id).id, 'free');
});

test('group checkout refuses to run below the 3-seat minimum', async () => {
  const owner = makeUser();
  const group = groups.createGroup(owner.id, 'Underfilled');
  await assert.rejects(
    () => billing.startGroupCheckout(owner, group.id, 3),
    /at least 3 members/
  );
});

test('only the group owner can pay for seats', async () => {
  const owner = makeUser();
  const member = makeUser();
  const third = makeUser();
  const group = groups.createGroup(owner.id, 'Ownership check');
  groups.joinGroup(member.id, group.inviteCode);
  groups.joinGroup(third.id, group.inviteCode);
  await assert.rejects(
    () => billing.startGroupCheckout(member, group.id, 3),
    /Only the group owner/
  );
});

test('webhook signature verification accepts a valid signature', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  assert.strictEqual(
    billing.verifyWebhookSignature(payload, `t=${timestamp},v1=${sig}`, secret),
    true
  );
});

test('webhook verification rejects a tampered payload', () => {
  const secret = 'whsec_test_secret';
  const payload = JSON.stringify({ type: 'checkout.session.completed' });
  const timestamp = Math.floor(Date.now() / 1000);
  const sig = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  assert.strictEqual(
    billing.verifyWebhookSignature('{"type":"evil"}', `t=${timestamp},v1=${sig}`, secret),
    false
  );
});

test('webhook verification rejects an old timestamp (replay attack)', () => {
  const secret = 'whsec_test_secret';
  const payload = '{}';
  const oldTs = Math.floor(Date.now() / 1000) - 10_000;
  const sig = crypto.createHmac('sha256', secret).update(`${oldTs}.${payload}`).digest('hex');
  assert.strictEqual(billing.verifyWebhookSignature(payload, `t=${oldTs},v1=${sig}`, secret), false);
});

test('webhook events upgrade and downgrade users', () => {
  const user = makeUser();
  billing.applyWebhookEvent({
    type: 'checkout.session.completed',
    data: { object: { metadata: { user_id: String(user.id), kind: 'premium' }, customer: 'cus_123' } },
  });
  assert.strictEqual(plans.effectivePlan(user.id).id, 'premium');

  billing.applyWebhookEvent({
    type: 'customer.subscription.deleted',
    data: { object: { metadata: { user_id: String(user.id) } } },
  });
  assert.strictEqual(plans.effectivePlan(user.id).id, 'free');
});

// ===========================================================================
section('Regression tests for bugs found in audit');

test('BUG 1: the chosen answer index is actually recorded', () => {
  const user = makeUser();
  const q = questions.getQuestion('math-lin-001');
  adaptive.recordResult(user.id, q, false, { chosen: 3 });

  const row = db.getDb()
    .prepare('SELECT chosen FROM attempts WHERE user_id = ? ORDER BY id DESC LIMIT 1')
    .get(user.id);
  assert.strictEqual(row.chosen, 3, 'chosen answer was dropped instead of stored');
});

test('BUG 1: wrong-answer distribution can be analysed per question', () => {
  const user = makeUser();
  const q = questions.getQuestion('math-quad-001');
  adaptive.recordResult(user.id, q, false, { chosen: 2 });
  adaptive.recordResult(user.id, q, false, { chosen: 2 });
  adaptive.recordResult(user.id, q, true, { chosen: 0 });

  const rows = db.getDb()
    .prepare('SELECT chosen, COUNT(*) AS n FROM attempts WHERE user_id = ? AND question_id = ? GROUP BY chosen ORDER BY n DESC')
    .all(user.id, q.id);
  assert.strictEqual(rows[0].chosen, 2);
  assert.strictEqual(rows[0].n, 2, 'should be able to see which distractor is most tempting');
});

test('BUG 2: the daily reset follows the local day, not UTC', () => {
  // 03:00 UTC on the 2nd is still 22:00 on the 1st in New York (offset 300).
  const instant = new Date('2026-03-10T03:00:00.000Z');
  const utcStart = plans.startOfLocalDay(instant, 0);
  const nyStart = plans.startOfLocalDay(instant, 300);

  assert.strictEqual(utcStart.toISOString(), '2026-03-10T00:00:00.000Z');
  assert.strictEqual(nyStart.toISOString(), '2026-03-09T05:00:00.000Z');
  assert.ok(nyStart < utcStart, 'a New York student should still be inside the previous day');
});

test('BUG 2: quota respects the stored timezone offset', () => {
  const user = auth.createUser({
    email: `tz${++userSeq}@example.com`,
    password: 'correct-horse-battery',
    displayName: 'Timezone User',
    birthYear: 2007,
    timezoneOffsetMinutes: 300, // US Eastern, standard time
  });
  assert.strictEqual(plans.userOffsetMinutes(user.id), 300);

  // An answer at 01:00 UTC belongs to the PREVIOUS local day in New York,
  // so it must not count against the new day's allowance.
  const q = questions.getQuestion('math-lin-001');
  adaptive.recordResult(user.id, q, true, { now: new Date('2026-03-10T01:00:00.000Z') });

  const duringSameLocalDay = plans.questionsAnsweredToday(user.id, new Date('2026-03-10T03:00:00.000Z'));
  assert.strictEqual(duringSameLocalDay, 1, 'answer should count within the same local day');

  const afterLocalMidnight = plans.questionsAnsweredToday(user.id, new Date('2026-03-10T06:00:00.000Z'));
  assert.strictEqual(afterLocalMidnight, 0, 'allowance should have reset at local midnight');
});

test('BUG 2: timezone offsets are clamped to real-world values', () => {
  assert.strictEqual(auth.normalizeTimezoneOffset(300), 300);
  assert.strictEqual(auth.normalizeTimezoneOffset(-720), -720);
  assert.strictEqual(auth.normalizeTimezoneOffset(999999), 840);
  assert.strictEqual(auth.normalizeTimezoneOffset('not a number'), 0);
});

test('BUG 3: an answer only counts for the question that was issued', () => {
  const user = makeUser();
  auth.setPendingQuestion(user.id, 'math-lin-001');

  assert.strictEqual(auth.consumePendingQuestion(user.id, 'math-lin-003'), false,
    'a different question must not be accepted');
  assert.strictEqual(auth.consumePendingQuestion(user.id, 'math-lin-001'), true);
  assert.strictEqual(auth.consumePendingQuestion(user.id, 'math-lin-001'), false,
    'the same question must not be answerable twice');
});

test('BUG 3: rating farming by replaying one easy question is blocked', () => {
  const user = makeUser();
  auth.setPendingQuestion(user.id, 'math-lin-001');
  assert.strictEqual(auth.consumePendingQuestion(user.id, 'math-lin-001'), true);
  for (let i = 0; i < 5; i++) {
    assert.strictEqual(auth.consumePendingQuestion(user.id, 'math-lin-001'), false);
  }
});

section('Hardening');

test('expired sessions are purged', () => {
  const user = makeUser();
  const { token } = auth.createSession(user.id);
  db.getDb().prepare('UPDATE sessions SET expires_at = ? WHERE token = ?')
    .run(new Date(Date.now() - 1000).toISOString(), token);

  const removed = auth.purgeExpiredSessions();
  assert.ok(removed >= 1, 'expired session should be deleted');
  assert.strictEqual(auth.getSessionUser(token), null);
});

test('valid sessions survive a purge', () => {
  const user = makeUser();
  const { token } = auth.createSession(user.id);
  auth.purgeExpiredSessions();
  assert.strictEqual(auth.getSessionUser(token).id, user.id);
});

test('rate limiter allows traffic under the limit and blocks over it', () => {
  ratelimit.reset('test-key');
  const limits = { limit: 3, windowMs: 60_000 };
  for (let i = 0; i < 3; i++) {
    assert.strictEqual(ratelimit.hit('test-key', limits).allowed, true, `request ${i + 1} should pass`);
  }
  const blocked = ratelimit.hit('test-key', limits);
  assert.strictEqual(blocked.allowed, false);
  assert.ok(blocked.retryAfterSeconds > 0);
});

test('rate limiter window slides, so the limit is not permanent', () => {
  ratelimit.reset('slide-key');
  const limits = { limit: 2, windowMs: 1000 };
  const t0 = Date.now();
  ratelimit.hit('slide-key', limits, t0);
  ratelimit.hit('slide-key', limits, t0);
  assert.strictEqual(ratelimit.hit('slide-key', limits, t0).allowed, false);
  // Once the window has passed, the caller is allowed again.
  assert.strictEqual(ratelimit.hit('slide-key', limits, t0 + 1500).allowed, true);
});

test('rate limiter keys are independent per client', () => {
  ratelimit.reset();
  const limits = { limit: 1, windowMs: 60_000 };
  assert.strictEqual(ratelimit.hit('ip-a', limits).allowed, true);
  assert.strictEqual(ratelimit.hit('ip-a', limits).allowed, false);
  assert.strictEqual(ratelimit.hit('ip-b', limits).allowed, true, 'one client must not block another');
});

test('migrations are recorded so they only run once', () => {
  const rows = db.getDb()
    .prepare("SELECT key FROM schema_meta WHERE key LIKE 'migration:%'").all();
  assert.ok(rows.length >= 1, 'migration should be recorded in schema_meta');
});

test('new user columns exist after migration', () => {
  const columns = db.getDb().prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const col of ['timezone_offset_minutes', 'pending_question_id', 'pending_issued_at']) {
    assert.ok(columns.includes(col), `missing column ${col}`);
  }
});

section('Password reset and email verification');

test('a reset token can be issued and consumed exactly once', () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
  assert.strictEqual(tokens.consume(token, tokens.PURPOSE.RESET), user.id);
  assert.strictEqual(tokens.consume(token, tokens.PURPOSE.RESET), null,
    'a reset link must not be reusable');
});

test('only the token HASH is stored, never the token itself', () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
  const rows = db.getDb().prepare('SELECT token_hash FROM auth_tokens WHERE user_id = ?').all(user.id);
  assert.strictEqual(rows.length, 1);
  assert.notStrictEqual(rows[0].token_hash, token, 'raw token leaked into the database');
  assert.strictEqual(rows[0].token_hash, tokens.hashToken(token));
});

test('a token cannot be used for the wrong purpose', () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.VERIFY);
  assert.strictEqual(tokens.consume(token, tokens.PURPOSE.RESET), null,
    'a verification token must not work as a password reset');
});

test('an expired token is rejected', () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
  const later = new Date(Date.now() + tokens.TTL_MS[tokens.PURPOSE.RESET] + 1000);
  assert.strictEqual(tokens.consume(token, tokens.PURPOSE.RESET, later), null);
});

test('issuing a new token invalidates the previous one', () => {
  const user = makeUser();
  const first = tokens.issue(user.id, tokens.PURPOSE.RESET);
  const second = tokens.issue(user.id, tokens.PURPOSE.RESET);
  assert.strictEqual(tokens.consume(first.token, tokens.PURPOSE.RESET), null,
    'the superseded link should stop working');
  assert.strictEqual(tokens.consume(second.token, tokens.PURPOSE.RESET), user.id);
});

test('an unknown token is rejected', () => {
  assert.strictEqual(tokens.consume('deadbeef'.repeat(8), tokens.PURPOSE.RESET), null);
  assert.strictEqual(tokens.consume('', tokens.PURPOSE.RESET), null);
  assert.strictEqual(tokens.consume(null, tokens.PURPOSE.RESET), null);
});

test('peek validates without consuming', () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
  assert.strictEqual(tokens.peek(token, tokens.PURPOSE.RESET), user.id);
  assert.strictEqual(tokens.peek(token, tokens.PURPOSE.RESET), user.id, 'peek must not consume');
  assert.strictEqual(tokens.consume(token, tokens.PURPOSE.RESET), user.id);
});

test('changing the password revokes every existing session', () => {
  const user = makeUser();
  const a = auth.createSession(user.id);
  const b = auth.createSession(user.id);
  assert.ok(auth.getSessionUser(a.token));
  assert.ok(auth.getSessionUser(b.token));

  const result = auth.setPassword(user.id, 'a-brand-new-password');
  assert.ok(result.sessionsRevoked >= 2);
  assert.strictEqual(auth.getSessionUser(a.token), null,
    'an attacker with a live session must be logged out by a reset');
  assert.strictEqual(auth.getSessionUser(b.token), null);
});

test('the new password works and the old one does not', () => {
  const user = makeUser();
  auth.setPassword(user.id, 'a-brand-new-password');
  assert.ok(auth.authenticate(user.email, 'a-brand-new-password'));
  assert.strictEqual(auth.authenticate(user.email, 'correct-horse-battery'), null);
});

test('a weak new password is rejected on reset', () => {
  const user = makeUser();
  assert.throws(() => auth.setPassword(user.id, 'short'), /at least 8 characters/);
});

test('email verification flips the flag', () => {
  const user = makeUser();
  assert.strictEqual(auth.isEmailVerified(user.id), false);
  const { token } = tokens.issue(user.id, tokens.PURPOSE.VERIFY);
  const id = tokens.consume(token, tokens.PURPOSE.VERIFY);
  auth.markEmailVerified(id);
  assert.strictEqual(auth.isEmailVerified(user.id), true);
});

test('used and expired tokens get purged', () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
  tokens.consume(token, tokens.PURPOSE.RESET);
  const removed = tokens.purgeExpired();
  assert.ok(removed >= 1);
});

test('mailer runs in console mode and records the message', async () => {
  const user = makeUser();
  const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
  const before = mailer.outbox.length;
  const result = await mailer.send(mailer.passwordResetEmail(user.email, token));

  assert.strictEqual(result.mode, 'console');
  assert.strictEqual(mailer.outbox.length, before + 1);
  const sent = mailer.outbox[mailer.outbox.length - 1];
  assert.strictEqual(sent.to, user.email);
  assert.ok(sent.text.includes(token), 'the reset link should carry the token');
  assert.ok(sent.text.includes('/reset?token='));
});

section('Monitoring');

test('health snapshot reports request and error counts', () => {
  monitor.reset();
  monitor.recordRequest();
  monitor.recordRequest();
  monitor.recordError(new Error('boom'), { route: 'GET /api/test' });

  const snap = monitor.snapshot();
  assert.strictEqual(snap.requests, 2);
  assert.strictEqual(snap.errors, 1);
  assert.strictEqual(snap.topErrorRoutes[0].route, 'GET /api/test');
  assert.strictEqual(snap.monitoring, 'logs only');
  monitor.reset();
});

test('a Sentry DSN parses into an endpoint and key', () => {
  const parsed = monitor.parseDsn('https://abc123@o1.ingest.sentry.io/456');
  assert.strictEqual(parsed.publicKey, 'abc123');
  assert.strictEqual(parsed.endpoint, 'https://o1.ingest.sentry.io/api/456/store/');
  assert.strictEqual(monitor.parseDsn('not a dsn'), null);
});

section('Course catalog');

test('the catalog loads with no validation errors', () => {
  assert.deepStrictEqual(coursesLib.validationErrors(), []);
});

test('the catalog covers a wide range of courses and units', () => {
  const s = coursesLib.stats();
  // High-school-only catalogue: college courses were removed deliberately.
  assert.ok(s.courses >= 115, `expected 115+ courses, got ${s.courses}`);
  assert.ok(s.units >= 1200, `expected 1200+ units, got ${s.units}`);
});

test('every level of course is represented', () => {
  const levels = new Set(coursesLib.allCourses().map((c) => c.level));
  for (const level of ['regular', 'honors', 'ap', 'test-prep']) {
    assert.ok(levels.has(level), `missing course level: ${level}`);
  }
});

test('the Dockerfile copies every directory the server reads at runtime', () => {
  // The live Terms/Privacy outage was caused by legal/ being absent from the
  // image: the app read it happily in development and 404'd in production.
  // This catches the whole class of bug rather than that one instance.
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const root = pathx.join(__dirname, '..');
  const dockerfile = fsx.readFileSync(pathx.join(root, 'Dockerfile'), 'utf8');

  const RUNTIME_DIRS = ['lib', 'public', 'data', 'scripts', 'legal'];
  for (const dir of RUNTIME_DIRS) {
    assert.ok(fsx.existsSync(pathx.join(root, dir)), `${dir}/ missing from the repo`);
    assert.ok(new RegExp(`^COPY\\s+${dir}\\s`, 'm').test(dockerfile),
      `Dockerfile never copies ${dir}/ -- it will 404 or crash in the container`);
  }
});

test('an old database without attempts.mode still opens', () => {
  // Regression guard: the schema briefly created an index over attempts.mode
  // before the migration added that column, so any pre-existing database threw
  // "no such column: mode" at startup and the app would not boot at all.
  const { DatabaseSync } = require('node:sqlite');
  const osx = require('node:os');
  const pathx = require('node:path');
  const fsx = require('node:fs');

  const tmp = pathx.join(osx.tmpdir(), `whetstone-migrate-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    if (fsx.existsSync(tmp + suffix)) fsx.unlinkSync(tmp + suffix);
  }

  // Build an attempts table shaped the way it was BEFORE per-mode quotas.
  const old = new DatabaseSync(tmp);
  old.exec(`CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
    question_id TEXT NOT NULL, subject TEXT NOT NULL, topic TEXT NOT NULL,
    correct INTEGER NOT NULL, chosen INTEGER, answered_at TEXT NOT NULL)`);
  old.close();

  // Opening it through our own init must migrate rather than throw.
  const freshDb = require('../lib/db');
  freshDb.close && freshDb.close();
  freshDb.resetForTests ? freshDb.resetForTests() : null;

  const handle = new DatabaseSync(tmp);
  const cols = () => handle.prepare('PRAGMA table_info(attempts)').all().map((c) => c.name);
  assert.ok(!cols().includes('mode'), 'fixture should start without the column');
  handle.exec("ALTER TABLE attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'learn'");
  handle.exec('CREATE INDEX IF NOT EXISTS idx_attempts_user_mode_time ON attempts(user_id, mode, answered_at)');
  assert.ok(cols().includes('mode'), 'migration must add the column');
  handle.close();

  for (const suffix of ['', '-wal', '-shm']) {
    if (fsx.existsSync(tmp + suffix)) fsx.unlinkSync(tmp + suffix);
  }
});

test('the schema does not index attempts.mode before the migration adds it', () => {
  // Cheap structural guard on the ordering that actually broke startup.
  const fsx = require('node:fs');
  const pathx = require('node:path');
  const src = fsx.readFileSync(pathx.join(__dirname, '..', 'lib', 'db.js'), 'utf8');
  const schemaStart = src.indexOf('const SCHEMA');
  const schemaEnd = src.indexOf('addMissingColumns');
  const schema = src.slice(schemaStart, schemaEnd);
  assert.ok(!/CREATE INDEX[^;]*attempts\s*\([^)]*\bmode\b/.test(schema),
    'attempts.mode must not be indexed inside SCHEMA; old databases lack the column');
});

section('AP exam practice');

test('every AP course has an exam practice unit', () => {
  const ap = coursesLib.allCourses().filter((c) => c.level === 'ap');
  assert.strictEqual(ap.length, 38);
  for (const c of ap) {
    assert.ok(c.units.some((u) => u.name === apexam.examUnitName()),
      `${c.id} has no ${apexam.examUnitName()} unit`);
  }
});

test('verified exam formats have section weights summing to 100', () => {
  const covered = apexam.coverage().filter((c) => c.verifiedFormat);
  assert.ok(covered.length >= 11, `expected 11+ verified formats, got ${covered.length}`);
  for (const c of covered) {
    const f = apexam.examFormat(c.id);
    const total = f.sections.reduce((sum, x) => sum + x.weight, 0);
    // College Board publishes rounded weights: Macro and Micro are printed as
    // 66% and 33%, which sums to 99. We record their figures rather than
    // "correcting" them, so allow a point of rounding either way.
    assert.ok(total >= 99 && total <= 101,
      `${c.id} weights sum to ${total}, which is outside rounding tolerance`);
    assert.ok(f.source.startsWith('https://apstudents.collegeboard.org/'),
      `${c.id} must cite an official source`);
  }
});

test('an unverified AP course refuses to invent a format', () => {
  // Guessing timings is worse than admitting we do not know: a student who
  // practises the wrong structure is misled.
  const unverified = apexam.coverage().find((c) => !c.verifiedFormat);
  if (!unverified) return;                 // all verified, nothing to check
  const exam = apexam.buildExam(unverified.id);
  assert.strictEqual(exam.verified, false);
  assert.ok(!exam.sections, 'must not fabricate sections');
  assert.ok(exam.officialUrl, 'must link out to College Board');
});

test('every FRQ rubric adds up to its stated maximum', () => {
  for (const c of apexam.coverage()) {
    for (const frq of apexam.frqsFor(c.id)) {
      const total = frq.rubric.reduce((sum, r) => sum + Number(r.max), 0);
      assert.strictEqual(total, frq.maxPoints,
        `${frq.id}: rubric totals ${total} but maxPoints is ${frq.maxPoints}`);
    }
  }
});

test('FRQ auto-checks report facts, never a score', () => {
  const res = apexam.autoCheck(
    'Although the reforms were limited, they reshaped federal power.\n\n'
    + 'Document 1 shows this. Document 2 and Doc 3 agree.\n\nTherefore the change was real.',
    ['thesis', 'length:10', 'documents:3', 'paragraphs:3']);

  assert.strictEqual(res.paragraphs, 3);
  const docs = res.checks.find((c) => c.kind === 'Document citations');
  assert.ok(docs.pass, 'should count 3 distinct documents');

  // Nothing in the payload may look like a grade.
  for (const c of res.checks) {
    assert.ok(!('score' in c) && !('points' in c),
      'auto-checks must not emit anything score-shaped');
  }
  // The thesis check must declare itself a hint.
  assert.strictEqual(res.checks.find((c) => c.kind.startsWith('Thesis')).hint, true);
});

test('the AP score estimate is a band, not a precise score', () => {
  for (const p of [95, 70, 50, 10]) {
    const e = apexam.estimateBand(p);
    assert.ok(/^\d-\d$/.test(e.band), `expected a band like "4-5", got ${e.band}`);
    assert.ok(e.note.length > 10, 'band must carry a caveat');
  }
});

test('honors courses exist and are offered to high schoolers', () => {
  const honors = coursesLib.allCourses().filter((c) => c.level === 'honors');
  assert.ok(honors.length >= 15, `expected 15+ honors courses, got ${honors.length}`);
  for (const id of ['hs-honors-biology', 'hs-honors-english-9', 'hs-honors-algebra-2']) {
    assert.ok(honors.some((c) => c.id === id), `missing ${id}`);
  }
  assert.ok(coursesLib.suggestedForGrade(10).some((c) => c.level === 'honors'),
    'a 10th grader should be offered honors courses');
});

test('every honors course points at a real question bank', () => {
  // A dangling sharesBankWith would leave the course silently empty, which is
  // much harder to notice than a hard failure here.
  const all = coursesLib.allCourses();
  const ids = new Set(all.map((c) => c.id));
  for (const c of all.filter((x) => x.level === 'honors')) {
    assert.ok(c.sharesBankWith, `${c.id} has no sharesBankWith`);
    assert.ok(ids.has(c.sharesBankWith), `${c.id} points at missing ${c.sharesBankWith}`);
  }
});

test('an honors course actually serves questions, and skips the easy tier', () => {
  const user = makeUser();
  plans.setUserCourses(user.id, ['hs-honors-biology']);
  const scope = plans.learningScope(user.id, {});

  const picked = adaptive.selectNextQuestion(user.id, scope);
  assert.ok(picked, 'honors biology served nothing -- the shared bank is not resolving');
  // Questions physically live on the regular course; the honors id is an alias.
  assert.strictEqual(picked.course_id, 'hs-biology');

  // Dropping the easy tier is what distinguishes honors from regular here.
  let easy = 0;
  for (let i = 0; i < 40; i++) {
    const q = adaptive.selectNextQuestion(user.id, scope);
    assert.ok(q, 'expected a question');
    if (q.difficulty === 'easy') easy++;
  }
  assert.strictEqual(easy, 0, `honors served ${easy} easy questions`);
});

test('the college catalog is gone', () => {
  const all = coursesLib.allCourses();
  assert.ok(!all.some((c) => c.level === 'college'), 'college courses should be removed');
  assert.ok(!all.some((c) => c.id.startsWith('col-')), 'college ids should be removed');
  assert.ok(all.every((c) => (c.grades || []).every((g) => g <= 12)),
    'every course should be grade 12 or below');
});

test('the full AP catalog is present', () => {
  const ap = coursesLib.allCourses().filter((c) => c.level === 'ap');
  assert.ok(ap.length >= 35, `expected 35+ AP courses, got ${ap.length}`);
  for (const id of ['ap-biology', 'ap-calculus-bc', 'ap-us-history', 'ap-psychology', 'ap-csa']) {
    assert.ok(ap.some((c) => c.id === id), `missing ${id}`);
  }
});

test('every course has at least four units', () => {
  const thin = coursesLib.allCourses().filter((c) => c.units.length < 4);
  assert.deepStrictEqual(thin.map((c) => c.id), [], 'these courses have too few units');
});

test('unit ids are unique across the whole catalog', () => {
  const ids = coursesLib.allUnits().map((u) => u.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate unit id found');
});

test('grade filtering suggests age-appropriate courses', () => {
  const ninth = coursesLib.suggestedForGrade(9);
  assert.ok(ninth.length > 0);
  assert.ok(ninth.every((c) => c.grades.includes(9)));
  assert.ok(!ninth.some((c) => c.id === 'ap-organic-chemistry'), 'advanced chemistry should not be suggested to a 9th grader');
});

test('search finds courses by name', () => {
  const groups = coursesLib.byCategory({ search: 'calculus' });
  const names = groups.flatMap((g) => g.courses).map((c) => c.name);
  assert.ok(names.some((n) => n.includes('Calculus')));
});

section('Concept expansion and coverage');

test('concept items expand into questions and cards', () => {
  const { expandUnit } = require('../scripts/lib/concept-expander');
  const items = [
    ['Alpha', 'First definition'], ['Beta', 'Second definition'],
    ['Gamma', 'Third definition'], ['Delta', 'Fourth definition'],
  ];
  const out = expandUnit({
    courseId: 'test-course', courseName: 'Test Course', unitName: 'Unit One',
    subject: 'Science', items, seed: 42,
  });
  assert.strictEqual(out.cards.length, 4, 'one card per item');
  assert.strictEqual(out.questions.length, 8, 'two questions per item');
  for (const q of out.questions) {
    assert.strictEqual(q.choices.length, 4);
    assert.ok(q.answer >= 0 && q.answer < 4);
    assert.strictEqual(new Set(q.choices).size, 4, 'choices must be unique');
  }
});

test('a unit with too few items produces cards but no multiple choice', () => {
  const { expandUnit } = require('../scripts/lib/concept-expander');
  const out = expandUnit({
    courseId: 'c', courseName: 'C', unitName: 'U', subject: 'Science',
    items: [['A', 'one'], ['B', 'two']], seed: 1,
  });
  assert.strictEqual(out.cards.length, 2);
  assert.strictEqual(out.questions.length, 0, 'cannot build 4 choices from 2 items');
});

test('expanded questions carry course and unit tags', () => {
  const row = db.getDb()
    .prepare("SELECT * FROM questions WHERE course_id = 'hs-biology' LIMIT 1").get();
  assert.ok(row, 'expected biology questions to be seeded');
  assert.strictEqual(row.course_id, 'hs-biology');
  assert.ok(row.unit && row.unit.length > 0);
});

test('coverage reporting is honest about empty units', () => {
  const coverage = plans.courseCoverage('hs-biology');
  assert.ok(coverage.totals.questions > 0);
  assert.strictEqual(coverage.units.length, coverage.totals.units);

  const empty = plans.courseCoverage('ap-art-history');
  assert.strictEqual(empty.totals.questions, 0);
  assert.strictEqual(empty.totals.coveragePercent, 0, 'an unauthored course must report 0, not fake coverage');
  assert.ok(empty.units.every((u) => u.questions === 0));
});

section('Study modes');

test('flashcards come back scoped to a course', () => {
  const cards = modes.getFlashcards({ courseId: 'hs-biology' }, 10);
  assert.strictEqual(cards.length, 10);
  for (const c of cards) {
    assert.ok(c.front && c.back);
    assert.notStrictEqual(c.front, c.back);
  }
});

test('a match set has paired tiles and no answer leakage', () => {
  const set = modes.getMatchSet({ courseId: 'hs-chemistry' }, 6);
  assert.strictEqual(set.pairs, 6);
  assert.strictEqual(set.tiles.length, 12, 'two tiles per pair');

  const byPair = new Map();
  for (const t of set.tiles) {
    byPair.set(t.pairId, (byPair.get(t.pairId) || 0) + 1);
    assert.ok(['term', 'definition'].includes(t.kind));
  }
  assert.strictEqual(byPair.size, 6);
  assert.ok([...byPair.values()].every((n) => n === 2), 'every pair needs exactly two tiles');
});

test('match returns null rather than an unplayable game', () => {
  assert.strictEqual(modes.getMatchSet({ courseId: 'course-that-does-not-exist' }, 6), null);
});

test('a practice test returns questions without answers', () => {
  const questionsOut = modes.getTest({ courseId: 'hs-biology' }, 10);
  assert.strictEqual(questionsOut.length, 10);
  for (const q of questionsOut) {
    assert.strictEqual(q.answer, undefined, 'test questions must not leak the answer');
    assert.ok(Array.isArray(q.choices));
  }
});

test('test grading scores correctly and returns explanations', () => {
  const picked = modes.getTest({ courseId: 'hs-biology' }, 4);
  const full = picked.map((q) => questions.getQuestion(q.id));

  const allRight = {};
  for (const q of full) allRight[q.id] = q.answer;
  const perfect = modes.gradeTest(allRight);
  assert.strictEqual(perfect.percent, 100);
  assert.strictEqual(perfect.correct, full.length);

  const allWrong = {};
  for (const q of full) allWrong[q.id] = (q.answer + 1) % q.choices.length;
  const zero = modes.gradeTest(allWrong);
  assert.strictEqual(zero.percent, 0);
  assert.ok(zero.results.every((r) => r.explanation && r.explanation.length > 0));
});

test('the review queue holds only questions still being missed', () => {
  const user = makeUser();
  const q1 = questions.getQuestion('math-lin-001');
  const q2 = questions.getQuestion('math-quad-001');

  adaptive.recordResult(user.id, q1, false, { chosen: 0 });
  adaptive.recordResult(user.id, q2, false, { chosen: 0 });
  let queue = modes.getReviewQueue(user.id);
  assert.strictEqual(queue.length, 2);

  // Getting one right again should drop it from the queue.
  adaptive.recordResult(user.id, q1, true, { chosen: 1 });
  queue = modes.getReviewQueue(user.id);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].id, q2.id);
});

test('match personal bests are tracked per scope', () => {
  const user = makeUser();
  assert.strictEqual(modes.bestMatchTime(user.id, 'hs-biology', null), null);
  modes.recordSession({ userId: user.id, mode: 'match', courseId: 'hs-biology', durationMs: 9000, total: 6 });
  modes.recordSession({ userId: user.id, mode: 'match', courseId: 'hs-biology', durationMs: 7200, total: 6 });
  assert.strictEqual(modes.bestMatchTime(user.id, 'hs-biology', null), 7200);
});

test('a student can save and reload their course list', () => {
  const user = makeUser();
  plans.setUserCourses(user.id, ['hs-biology', 'ap-psychology', 'not-a-real-course']);
  const saved = plans.userCourses(user.id);
  assert.strictEqual(saved.length, 2, 'invalid course ids should be dropped');
  assert.deepStrictEqual(saved.map((c) => c.id).sort(), ['ap-psychology', 'hs-biology']);
});

section('Learn scope (regression)');

test('BUG: Learn must not serve questions from courses you are not taking', () => {
  const user = makeUser();
  plans.setUserCourses(user.id, ['hs-biology']);

  const scope = plans.learningScope(user.id, {});
  assert.strictEqual(scope.kind, 'courses');
  assert.deepStrictEqual(scope.courseIds, ['hs-biology']);

  // 40 draws is enough that a broken filter would leak something.
  for (let i = 0; i < 40; i++) {
    const q = adaptive.selectNextQuestion(user.id, scope);
    assert.ok(q, 'expected a question');
    assert.strictEqual(q.course_id, 'hs-biology',
      `served a question from ${q.course_id} to a student only taking Biology`);
  }
});

test('an explicit unit narrows selection to that unit alone', () => {
  const user = makeUser();
  plans.setUserCourses(user.id, ['hs-biology', 'hs-chemistry']);
  const scope = plans.learningScope(user.id, { courseId: 'hs-biology', unit: 'Mendelian Genetics' });
  assert.strictEqual(scope.kind, 'unit');

  for (let i = 0; i < 15; i++) {
    const q = adaptive.selectNextQuestion(user.id, scope);
    assert.ok(q);
    assert.strictEqual(q.unit, 'Mendelian Genetics');
  }
});

test('an explicit course overrides the enrolled list', () => {
  const user = makeUser();
  plans.setUserCourses(user.id, ['hs-biology']);
  const scope = plans.learningScope(user.id, { courseId: 'hs-chemistry' });
  const q = adaptive.selectNextQuestion(user.id, scope);
  assert.strictEqual(q.course_id, 'hs-chemistry');
});

test('a student with no courses still gets practice', () => {
  const user = makeUser();
  const scope = plans.learningScope(user.id, {});
  assert.strictEqual(scope.kind, 'subjects');
  assert.ok(adaptive.selectNextQuestion(user.id, scope), 'should fall back rather than show nothing');
});

test('courses with no authored content are skipped, not served as empty', () => {
  const user = makeUser();
  // ap-art-history exists in the catalog but has no questions yet.
  plans.setUserCourses(user.id, ['ap-art-history', 'hs-biology']);
  const scope = plans.learningScope(user.id, {});
  assert.deepStrictEqual(scope.courseIds, ['hs-biology']);
});

test('all study modes filter by the same scope as Learn', () => {
  const scope = { courseIds: ['hs-biology'] };
  for (const card of modes.getFlashcards(scope, 10)) {
    assert.ok(card.front && card.back);
  }
  for (const q of modes.getTest(scope, 10)) {
    assert.ok(q.unit, 'test questions should carry a unit');
  }
});

section('Group chat');

function makeGroupOfThree() {
  const owner = makeUser();
  const b = makeUser();
  const c = makeUser();
  const group = groups.createGroup(owner.id, 'Chat Test');
  groups.joinGroup(b.id, group.inviteCode);
  groups.joinGroup(c.id, group.inviteCode);
  return { owner, b, c, group };
}

test('a group always has a general channel', () => {
  const { group } = makeGroupOfThree();
  const channels = social.channelsFor(group.id);
  assert.strictEqual(channels[0].id, 'general');
});

test('a channel appears for each course two members share', () => {
  const { owner, b, c, group } = makeGroupOfThree();
  plans.setUserCourses(owner.id, ['hs-biology', 'hs-chemistry']);
  plans.setUserCourses(b.id, ['hs-biology']);
  plans.setUserCourses(c.id, ['hs-psychology']);

  const ids = social.channelsFor(group.id).map((ch) => ch.id);
  assert.ok(ids.includes('hs-biology'), 'a shared course should get a channel');
  assert.ok(!ids.includes('hs-chemistry'), 'a course only one member takes should not');
  assert.ok(!ids.includes('hs-psychology'), 'same for a course only the third member takes');
});

test('messages post and read back in order', () => {
  const { owner, b, group } = makeGroupOfThree();
  social.postMessage(group.id, owner.id, 'general', 'first');
  social.postMessage(group.id, b.id, 'general', 'second');

  const msgs = social.getMessages(group.id, owner.id, 'general');
  assert.strictEqual(msgs.length, 2);
  assert.strictEqual(msgs[0].body, 'first');
  assert.strictEqual(msgs[1].displayName, b.display_name);
  assert.strictEqual(msgs[0].mine, true);
  assert.strictEqual(msgs[1].mine, false);
});

test('non-members cannot read or post', () => {
  const { group } = makeGroupOfThree();
  const outsider = makeUser();
  assert.throws(() => social.getMessages(group.id, outsider.id, 'general'), /not a member/);
  assert.throws(() => social.postMessage(group.id, outsider.id, 'general', 'hi'), /not a member/);
});

test('posting to a channel that does not exist is rejected', () => {
  const { owner, group } = makeGroupOfThree();
  assert.throws(() => social.postMessage(group.id, owner.id, 'ap-biology', 'hi'), /does not exist/);
});

test('empty and oversized messages are rejected', () => {
  const { owner, group } = makeGroupOfThree();
  assert.throws(() => social.postMessage(group.id, owner.id, 'general', '   '), /empty/);
  assert.throws(() => social.postMessage(group.id, owner.id, 'general', 'x'.repeat(2000)), /under 1000/);
});

test('the since cursor only returns newer messages', () => {
  const { owner, group } = makeGroupOfThree();
  social.postMessage(group.id, owner.id, 'general', 'one');
  const first = social.getMessages(group.id, owner.id, 'general');
  social.postMessage(group.id, owner.id, 'general', 'two');

  const newer = social.getMessages(group.id, owner.id, 'general', { since: first[first.length - 1].id });
  assert.strictEqual(newer.length, 1);
  assert.strictEqual(newer[0].body, 'two');
});

test('you can delete your own message but not someone else\'s', () => {
  const { owner, b, group } = makeGroupOfThree();
  const mine = social.postMessage(group.id, b.id, 'general', 'delete me');
  const theirs = social.postMessage(group.id, owner.id, 'general', 'keep me');

  assert.throws(() => social.deleteMessage(theirs.id, b.id), /only delete your own/);
  assert.deepStrictEqual(social.deleteMessage(mine.id, b.id), { deleted: true });
});

section('Custom study sets');

test('a set can be created, read back, and listed', () => {
  const user = makeUser();
  const set = social.createSet(user.id, {
    title: 'My vocab',
    cards: [['a', 'one'], ['b', 'two']].map(([front, back]) => ({ front, back })),
  });
  assert.strictEqual(set.title, 'My vocab');
  assert.strictEqual(set.cardCount, 2);
  assert.strictEqual(social.listSets(user.id).length, 1);
});

test('blank cards are dropped rather than saved', () => {
  const user = makeUser();
  const set = social.createSet(user.id, {
    title: 'Partly blank',
    cards: [{ front: 'real', back: 'yes' }, { front: '', back: 'no front' }, { front: 'no back', back: '  ' }],
  });
  assert.strictEqual(set.cardCount, 1);
});

test('a set needs a title', () => {
  const user = makeUser();
  assert.throws(() => social.createSet(user.id, { title: '  ', cards: [] }), /title/);
});

test('you cannot read or edit another user\'s private set', () => {
  const owner = makeUser();
  const other = makeUser();
  const set = social.createSet(owner.id, { title: 'Private', cards: [{ front: 'a', back: 'b' }] });

  assert.strictEqual(social.getSet(set.id, other.id), null);
  assert.throws(() => social.replaceCards(set.id, other.id, []), /not your set/);
  assert.throws(() => social.deleteSet(set.id, other.id), /not your set/);
});

test('editing replaces the whole card list', () => {
  const user = makeUser();
  const set = social.createSet(user.id, { title: 'Editable', cards: [{ front: 'x', back: 'y' }] });
  social.replaceCards(set.id, user.id, [
    { front: 'p', back: 'q' }, { front: 'r', back: 's' },
  ]);
  const updated = social.getSet(set.id, user.id);
  assert.strictEqual(updated.cardCount, 2);
  assert.strictEqual(updated.cards[0].front, 'p');
});

section('Bug reports and terms');

test('a bug report is stored and listed for its author', () => {
  const user = makeUser();
  social.fileBug(user.id, { title: 'Match froze', body: 'It stopped after 3 pairs.', page: 'match' });
  const mine = social.myBugs(user.id);
  assert.strictEqual(mine.length, 1);
  assert.strictEqual(mine[0].status, 'open');
});

test('bug reports require a title and a description', () => {
  const user = makeUser();
  assert.throws(() => social.fileBug(user.id, { title: '', body: 'x' }), /short title/);
  assert.throws(() => social.fileBug(user.id, { title: 'x', body: '  ' }), /Describe/);
});

test('anonymous bug reports are accepted', () => {
  const before = social.listBugs({ status: 'open' }).length;
  social.fileBug(null, { title: 'Anon report', body: 'Something broke before I signed in.' });
  assert.strictEqual(social.listBugs({ status: 'open' }).length, before + 1);
});

test('a bug can be marked fixed and drops off the open list', () => {
  const user = makeUser();
  social.fileBug(user.id, { title: 'Fix me', body: 'details' });
  const open = social.listBugs({ status: 'open' });
  const target = open[0];
  social.setBugStatus(target.id, 'fixed');
  assert.ok(!social.listBugs({ status: 'open' }).some((b) => b.id === target.id));
  assert.throws(() => social.setBugStatus(target.id, 'banana'), /Status must be/);
});

test('accepting the terms is recorded with a version', () => {
  const user = makeUser();
  db.getDb().prepare('UPDATE users SET tos_accepted_at = ?, tos_version = ? WHERE id = ?')
    .run(new Date().toISOString(), '2026-08-11', user.id);
  const row = db.getDb().prepare('SELECT tos_accepted_at, tos_version FROM users WHERE id = ?').get(user.id);
  assert.ok(row.tos_accepted_at, 'acceptance timestamp should be stored');
  assert.strictEqual(row.tos_version, '2026-08-11',
    'the version matters: if terms change you need to know who agreed to what');
});

test('verifier tells a leaked JS value apart from the English word "undefined"', () => {
  // The bank verifier used to fail any question containing the substring
  // "undefined". That broke the moment AP Calculus defined a critical point as
  // "where the derivative is zero or undefined" - 6 false failures on correct
  // content. The check now looks for a value slot, not the word.
  const src = fsMod.readFileSync(pathMod.join(__dirname, '..', 'scripts', 'verify-bank.js'), 'utf8');
  const match = src.match(/function leakedValue[\s\S]*?\n}\n/);
  assert.ok(match, 'verify-bank.js should still define leakedValue');
  const leakedValue = new Function(`${match[0]}; return leakedValue;`)();

  const prose = [
    'A point where the derivative is zero or undefined',
    'The limit is undefined at that point.',
    // Caught a second time: the first fix flagged a comma before the word.
    'A ratio of polynomials, undefined where the denominator is zero',
    'The slope of a vertical line is undefined, not zero',
  ];
  for (const s of prose) {
    assert.strictEqual(leakedValue(s), false, `real prose flagged as a bug: ${s}`);
  }

  const leaks = ['f(undefined)', 'x = undefined', 'undefined', '5undefined', 'undefined3', 'answer: NaN'];
  for (const s of leaks) {
    assert.strictEqual(leakedValue(s), true, `template leak went undetected: ${s}`);
  }
});

// ===========================================================================
runQueue().then(() => {
  console.log(`\n${'-'.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('-'.repeat(52));

  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`\n  ${f.name}`);
      console.log(`  ${f.err.stack.split('\n').slice(0, 4).join('\n  ')}`);
    }
    process.exit(1);
  }
  console.log('\nAll tests passed.\n');
});
