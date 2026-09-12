'use strict';

/**
 * Launch metrics, read straight out of this app's own database.
 *
 * There is no third-party analytics here on purpose. Every hosted product in
 * this category needs an API key, a script tag that a school network may well
 * block, and a dashboard that shows sessions and bounce rate - none of which
 * answers the only question that matters: when a student gets something wrong,
 * do they later get it right?
 *
 * So this file computes that directly. Everything below is an aggregate. No
 * function here returns an email address, a name, or anything that identifies
 * one student, because the person reading this dashboard does not need that
 * and their classmates did not agree to it.
 */

const { getDb } = require('./db');

function dayKey(offsetDays = 0) {
  const d = new Date(Date.now() - offsetDays * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Accounts created, in total and per day for the last two weeks. */
function signups(db) {
  const total = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const rows = db.prepare(`
    SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
    FROM users WHERE created_at >= ?
    GROUP BY day ORDER BY day
  `).all(dayKey(13));

  const byDay = new Map(rows.map((r) => [r.day, r.n]));
  const series = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = dayKey(i);
    series.push({ day, signups: byDay.get(day) || 0 });
  }
  return { total, series };
}

/**
 * How far a new account actually gets.
 *
 * Each step is a strict subset of the one above it, so the drop between two
 * rows is the step that is losing people. "Answered 10" is the activation
 * line: it is roughly the point where a student has seen the product work.
 */
function funnel(db) {
  const one = (sql, ...params) => db.prepare(sql).get(...params).n;
  return [
    { step: 'Signed up', count: one('SELECT COUNT(*) AS n FROM users') },
    {
      step: 'Confirmed email',
      count: one('SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL'),
    },
    {
      step: 'Finished setup',
      count: one('SELECT COUNT(*) AS n FROM users WHERE onboarded_at IS NOT NULL'),
    },
    {
      step: 'Answered a question',
      count: one('SELECT COUNT(DISTINCT user_id) AS n FROM attempts'),
    },
    {
      step: 'Answered 10 questions',
      count: one(`SELECT COUNT(*) AS n FROM (
        SELECT user_id FROM attempts GROUP BY user_id HAVING COUNT(*) >= 10)`),
    },
    {
      step: 'Came back a second day',
      count: one(`SELECT COUNT(*) AS n FROM (
        SELECT user_id FROM attempts GROUP BY user_id
        HAVING COUNT(DISTINCT substr(answered_at, 1, 10)) >= 2)`),
    },
  ];
}

/**
 * The retest metric: of the questions a student got wrong, how many did they
 * later get right?
 *
 * This is the product's whole claim, stated as a number. It is measured per
 * student per question: the first time this student saw this question they
 * were wrong, and some later attempt at the same question was correct.
 *
 * `retried` is reported separately from `recovered` because the two failures
 * are different problems. If retried is low, the app is not bringing missed
 * questions back and that is a scheduling bug. If retried is high but
 * recovered is low, it is bringing them back and they are not sticking, which
 * is a teaching problem - the explanations.
 */
function retest(db) {
  const row = db.prepare(`
    WITH first_try AS (
      SELECT user_id, question_id, MIN(answered_at) AS t0
      FROM attempts GROUP BY user_id, question_id
    ),
    missed AS (
      SELECT a.user_id, a.question_id, a.answered_at AS t0
      FROM attempts a
      JOIN first_try f
        ON f.user_id = a.user_id AND f.question_id = a.question_id AND f.t0 = a.answered_at
      WHERE a.correct = 0
    )
    SELECT
      COUNT(*) AS missed,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM attempts l
        WHERE l.user_id = m.user_id AND l.question_id = m.question_id AND l.answered_at > m.t0
      ) THEN 1 ELSE 0 END) AS retried,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM attempts l
        WHERE l.user_id = m.user_id AND l.question_id = m.question_id
          AND l.answered_at > m.t0 AND l.correct = 1
      ) THEN 1 ELSE 0 END) AS recovered
    FROM missed m
  `).get() || {};

  const missed = row.missed || 0;
  const retried = row.retried || 0;
  const recovered = row.recovered || 0;

  return {
    missed,
    retried,
    recovered,
    // Of everything they got wrong, the share they have since got right.
    recoveryRate: missed ? recovered / missed : null,
    // Of the ones the app actually brought back, the share that stuck. This is
    // the honest measure of whether the explanations teach anything.
    recoveryRateOfRetried: retried ? recovered / retried : null,
    retryRate: missed ? retried / missed : null,
  };
}

/**
 * Whether students improve on the topics they were worst at.
 *
 * The per-question retest number can be gamed by memorising one question, so
 * this is the same idea a level up: for each student and topic where they have
 * answered at least six, compare their first three attempts with their last
 * three. It answers "are they getting better at the topic", not "do they
 * remember this one item".
 */
function topicImprovement(db) {
  const rows = db.prepare(`
    SELECT user_id, topic, correct, answered_at,
           ROW_NUMBER() OVER (PARTITION BY user_id, topic ORDER BY answered_at) AS seq,
           COUNT(*) OVER (PARTITION BY user_id, topic) AS total
    FROM attempts
  `).all();

  let pairs = 0;
  let improved = 0;
  let firstSum = 0;
  let lastSum = 0;

  const buckets = new Map();
  for (const r of rows) {
    if (r.total < 6) continue;
    const key = `${r.user_id}|${r.topic}`;
    if (!buckets.has(key)) buckets.set(key, { total: r.total, first: [], last: [] });
    const b = buckets.get(key);
    if (r.seq <= 3) b.first.push(r.correct);
    if (r.seq > r.total - 3) b.last.push(r.correct);
  }

  for (const b of buckets.values()) {
    if (b.first.length < 3 || b.last.length < 3) continue;
    const before = b.first.reduce((a, c) => a + c, 0) / 3;
    const after = b.last.reduce((a, c) => a + c, 0) / 3;
    pairs += 1;
    firstSum += before;
    lastSum += after;
    if (after > before) improved += 1;
  }

  return {
    topicsMeasured: pairs,
    improvedCount: improved,
    improvedRate: pairs ? improved / pairs : null,
    accuracyFirstThree: pairs ? firstSum / pairs : null,
    accuracyLastThree: pairs ? lastSum / pairs : null,
  };
}

/** Raw volume, so every rate above can be read with its sample size. */
function usage(db) {
  const attempts = db.prepare('SELECT COUNT(*) AS n FROM attempts').get().n;
  const correct = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE correct = 1').get().n;
  const activeUsers = db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM attempts').get().n;
  const today = db.prepare(
    'SELECT COUNT(DISTINCT user_id) AS n FROM attempts WHERE substr(answered_at, 1, 10) = ?'
  ).get(dayKey()).n;
  const week = db.prepare(
    'SELECT COUNT(DISTINCT user_id) AS n FROM attempts WHERE substr(answered_at, 1, 10) >= ?'
  ).get(dayKey(6)).n;

  return {
    attempts,
    accuracy: attempts ? correct / attempts : null,
    activeUsers,
    activeToday: today,
    activeThisWeek: week,
    attemptsPerActiveUser: activeUsers ? attempts / activeUsers : null,
  };
}

/** Which classes people actually study, so the empty ones can be prioritised. */
function topCourses(db, limit = 10) {
  return db.prepare(`
    SELECT q.course_id AS courseId,
           COUNT(*) AS attempts,
           COUNT(DISTINCT a.user_id) AS students
    FROM attempts a JOIN questions q ON q.id = a.question_id
    WHERE q.course_id IS NOT NULL
    GROUP BY q.course_id
    ORDER BY attempts DESC
    LIMIT ?
  `).all(limit);
}

/**
 * Questions students have flagged, worst first.
 *
 * A question with several reports against it is the highest-value thing in
 * the whole dashboard: it is actively teaching people the wrong answer.
 */
function reportedQuestions(db, limit = 25) {
  return db.prepare(`
    SELECT question_id AS questionId, COUNT(*) AS reports,
           MAX(created_at) AS lastReportedAt,
           SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open
    FROM bug_reports
    WHERE kind = 'question' AND question_id IS NOT NULL
    GROUP BY question_id
    ORDER BY reports DESC, lastReportedAt DESC
    LIMIT ?
  `).all(limit);
}

function openBugCount(db) {
  return db.prepare(
    "SELECT COUNT(*) AS n FROM bug_reports WHERE kind = 'bug' AND status = 'open'"
  ).get().n;
}

function snapshot() {
  const db = getDb();
  return {
    generatedAt: new Date().toISOString(),
    signups: signups(db),
    funnel: funnel(db),
    retest: retest(db),
    topicImprovement: topicImprovement(db),
    usage: usage(db),
    topCourses: topCourses(db),
    reportedQuestions: reportedQuestions(db),
    openBugs: openBugCount(db),
  };
}

module.exports = {
  snapshot, signups, funnel, retest, topicImprovement, usage,
  topCourses, reportedQuestions, openBugCount,
};
