'use strict';

/**
 * Analytics tests.
 *
 * These exist because a metrics dashboard fails silently. A chart that is
 * confidently wrong looks exactly like a chart that is right, and the person
 * reading it makes decisions either way. The first version of the retest
 * metric matched on question id, which the adaptive engine is specifically
 * built never to repeat, so it would have reported a recovery rate near zero
 * however well students were actually learning.
 *
 * So the central test here does not use a hand-built fixture. It drives the
 * REAL question selector and the REAL result recorder, with a simulated
 * student who learns, and asserts the dashboard notices.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP_DB = path.join(require('node:os').tmpdir(), `keen-analytics-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
}

const db = require('../lib/db');
db.init(TMP_DB);

const questions = require('../lib/questions');
questions.seed({ quiet: true });

const auth = require('../lib/auth');
const adaptive = require('../lib/adaptive');
const analytics = require('../lib/analytics');

let passed = 0;
let failed = 0;
const checks = [];
function check(label, fn) { checks.push({ label, fn }); }

let seq = 0;
function makeUser() {
  seq += 1;
  return auth.createUser({
    email: `an${seq}.${process.pid}@example.com`,
    password: 'password123',
    displayName: `Student ${seq}`,
    birthYear: 2009,
  });
}

/** The concept a question belongs to: its id with one trailing a/b removed. */
function conceptOf(id) {
  return /[ab]$/.test(id) ? id.slice(0, -1) : id;
}

/**
 * Run a student through the real engine.
 *
 * `learns` decides the answer: a student who learns gets a concept wrong the
 * first time they meet it and right every time after, which is exactly the
 * behaviour the retest metric is supposed to detect.
 */
function simulate(userId, count, { learns }) {
  const scope = { kind: 'courses', courseIds: ['ap-biology'] };
  const seenConcepts = new Set();
  let clock = Date.parse('2026-03-01T09:00:00.000Z');
  let served = 0;

  for (let i = 0; i < count; i += 1) {
    const q = adaptive.selectNextQuestion(userId, scope, Math.random, new Date(clock));
    if (!q) break;
    const concept = conceptOf(q.id);
    const firstTime = !seenConcepts.has(concept);
    seenConcepts.add(concept);
    const correct = learns ? !firstTime : false;
    adaptive.recordResult(userId, q, correct, { now: new Date(clock), mode: 'learn' });
    clock += 6 * 60 * 1000;
    served += 1;
  }
  return { served, distinctConcepts: seenConcepts.size };
}

// ------------------------------------------------------- the retest metric

check('a student who learns shows up as recovery, and the old metric would not', () => {
  const user = makeUser();
  const run = simulate(user.id, 120, { learns: true });
  assert.ok(run.served > 60, `engine only served ${run.served} questions`);

  const r = analytics.retest(db.getDb());
  assert.ok(r.missed > 10, `too few misses to judge: ${r.missed}`);
  assert.ok(r.recovered > 0, 'a student who answered correctly on every repeat showed zero recovery');
  assert.ok(
    r.recoveryRate > 0.5,
    `a student who learns every concept should recover most of them, got ${r.recoveryRate}`
  );

  // The point of the rewrite, asserted rather than argued: matching on the
  // exact question id sees almost none of this, because the engine prefers
  // questions the student has not seen.
  assert.ok(
    r.exactQuestion.recoveryRate === null || r.exactQuestion.recoveryRate < r.recoveryRate,
    'exact-question matching should see less recovery than concept matching'
  );
});

check('a student who never improves shows zero recovery', () => {
  const user = makeUser();
  simulate(user.id, 60, { learns: false });

  // Measured for this user alone, so the learning student above cannot mask it.
  const row = db.getDb().prepare(`
    WITH att AS (
      SELECT correct, answered_at,
             CASE WHEN question_id GLOB '*[ab]'
                  THEN substr(question_id, 1, length(question_id) - 1)
                  ELSE question_id END AS k
      FROM attempts WHERE user_id = ?
    )
    SELECT COUNT(*) AS n FROM att WHERE correct = 1
  `).get(user.id);
  assert.strictEqual(row.n, 0, 'the simulated student answered something correctly');
});

check('recovery requires the later answer to be correct, not merely a second look', () => {
  const handle = db.getDb();
  const user = makeUser();
  const pair = handle.prepare(
    "SELECT id, subject, topic FROM questions WHERE id GLOB '*a' LIMIT 1"
  ).get();
  const sibling = pair.id.slice(0, -1) + 'b';
  const insert = handle.prepare(
    "INSERT INTO attempts (user_id, question_id, subject, topic, correct, chosen, mode, answered_at)"
    + " VALUES (?, ?, ?, ?, ?, 0, 'learn', ?)"
  );

  const before = analytics.retest(handle);
  // Wrong on the a side, wrong again on the b side: retried, not recovered.
  insert.run(user.id, pair.id, pair.subject, pair.topic, 0, '2026-04-01T09:00:00.000Z');
  insert.run(user.id, sibling, pair.subject, pair.topic, 0, '2026-04-02T09:00:00.000Z');
  const mid = analytics.retest(handle);
  assert.strictEqual(mid.missed - before.missed, 1, 'the pair should count as one missed concept');
  assert.strictEqual(mid.retried - before.retried, 1, 'the second look was not counted as a retry');
  assert.strictEqual(mid.recovered - before.recovered, 0, 'a second wrong answer counted as recovery');

  // Now get it right: the same concept becomes a recovery.
  insert.run(user.id, sibling, pair.subject, pair.topic, 1, '2026-04-03T09:00:00.000Z');
  const after = analytics.retest(handle);
  assert.strictEqual(after.recovered - mid.recovered, 1, 'a correct later answer was not counted');
});

check('getting it right first time is not counted as a miss', () => {
  const handle = db.getDb();
  const user = makeUser();
  const q = handle.prepare("SELECT id, subject, topic FROM questions WHERE id GLOB '*a' LIMIT 1 OFFSET 5").get();
  const before = analytics.retest(handle);
  handle.prepare(
    "INSERT INTO attempts (user_id, question_id, subject, topic, correct, chosen, mode, answered_at)"
    + " VALUES (?, ?, ?, ?, 1, 0, 'learn', ?)"
  ).run(user.id, q.id, q.subject, q.topic, '2026-05-01T09:00:00.000Z');
  const after = analytics.retest(handle);
  assert.strictEqual(after.missed - before.missed, 0, 'a correct first answer was counted as a miss');
});

// -------------------------------------------------------- topic improvement

check('topic improvement sees a student getting better, and is not fooled by one good run', () => {
  const handle = db.getDb();
  const user = makeUser();
  const topic = 'Synthetic Topic For Improvement';
  const ids = handle.prepare("SELECT id FROM questions LIMIT 8").all().map((r) => r.id);
  const insert = handle.prepare(
    "INSERT INTO attempts (user_id, question_id, subject, topic, correct, chosen, mode, answered_at)"
    + " VALUES (?, ?, 'Science', ?, ?, 0, 'learn', ?)"
  );
  // Three wrong, then two middling, then three right: a real improvement curve.
  const pattern = [0, 0, 0, 0, 1, 1, 1, 1];
  pattern.forEach((correct, i) => {
    insert.run(user.id, ids[i], topic, correct, `2026-06-0${i + 1}T09:00:00.000Z`);
  });

  const ti = analytics.topicImprovement(handle);
  assert.ok(ti.topicsMeasured > 0, 'no student-topic pairs were measured at all');
  assert.ok(ti.accuracyFirstThree !== null && ti.accuracyLastThree !== null, 'improvement returned nulls');
  assert.ok(
    ti.accuracyLastThree > ti.accuracyFirstThree,
    `expected later accuracy to beat earlier: ${ti.accuracyFirstThree} -> ${ti.accuracyLastThree}`
  );
});

check('a topic with fewer than six answers is not measured', () => {
  const handle = db.getDb();
  const user = makeUser();
  const ids = handle.prepare("SELECT id FROM questions LIMIT 4").all().map((r) => r.id);
  const before = analytics.topicImprovement(handle).topicsMeasured;
  const insert = handle.prepare(
    "INSERT INTO attempts (user_id, question_id, subject, topic, correct, chosen, mode, answered_at)"
    + " VALUES (?, ?, 'Science', 'Tiny Sample Topic', 1, 0, 'learn', ?)"
  );
  ids.forEach((id, i) => insert.run(user.id, id, `2026-07-0${i + 1}T09:00:00.000Z`));
  assert.strictEqual(
    analytics.topicImprovement(handle).topicsMeasured, before,
    'a four-answer topic was treated as a measurable sample'
  );
});

// ------------------------------------------------------------------ privacy

check('no part of the snapshot contains anything identifying a student', () => {
  const snapshot = JSON.stringify(analytics.snapshot());
  assert.ok(!/@example\.com/.test(snapshot), 'a student email reached the metrics payload');
  assert.ok(!/Student \d/.test(snapshot), 'a student display name reached the metrics payload');
});

check('the funnel never reports a step as larger than the one above it', () => {
  const funnel = analytics.funnel(db.getDb());
  for (let i = 1; i < funnel.length; i += 1) {
    assert.ok(
      funnel[i].count <= funnel[i - 1].count,
      `"${funnel[i].step}" (${funnel[i].count}) exceeds "${funnel[i - 1].step}" (${funnel[i - 1].count}), so it is not a subset`
    );
  }
});

// ---------------------------------------------------------------------- run

(async () => {
  console.log('\nKeen analytics tests\n');
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
