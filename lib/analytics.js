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
 * Every step here is a threshold on the SAME count, so each row is a strict
 * subset of the one above it by construction and the drop between two rows is
 * always a real number of people.
 *
 * The first version of this mixed in "confirmed email" and "finished setup",
 * which are not steps on this path at all: a student can study without ever
 * confirming their email, so that row could be - and in testing was - smaller
 * than the row below it, which made the "lost" column print nonsense. Those
 * two moved to milestones(), where they are not claimed to be sequential.
 */
function funnel(db) {
  const atLeast = (n) => db.prepare(`
    SELECT COUNT(*) AS n FROM (
      SELECT user_id FROM attempts GROUP BY user_id HAVING COUNT(*) >= ?
    )`).get(n).n;

  return [
    { step: 'Signed up', count: db.prepare('SELECT COUNT(*) AS n FROM users').get().n },
    { step: 'Answered a question', count: atLeast(1) },
    { step: 'Answered 10', count: atLeast(10) },
    { step: 'Answered 25', count: atLeast(25) },
  ];
}

/**
 * Things worth knowing that are NOT stages of one path.
 *
 * Confirming an email, finishing setup and coming back a second day happen in
 * any order, or not at all, and none of them requires the others. Reported as
 * independent shares of signups so no arithmetic here implies a sequence that
 * does not exist.
 */
function milestones(db) {
  const one = (sql, ...params) => db.prepare(sql).get(...params).n;
  const signups = one('SELECT COUNT(*) AS n FROM users');
  const rows = [
    { label: 'Confirmed their email', count: one('SELECT COUNT(*) AS n FROM users WHERE email_verified_at IS NOT NULL') },
    { label: 'Finished setup', count: one('SELECT COUNT(*) AS n FROM users WHERE onboarded_at IS NOT NULL') },
    { label: 'Picked at least one class', count: one('SELECT COUNT(DISTINCT user_id) AS n FROM user_courses') },
    {
      // Counted in each student's OWN day, not in UTC. A student in California
      // who studies at 6pm Monday and 8am Tuesday is at 01:00 and 15:00 UTC on
      // the same UTC date, so a naive substr() call would score their return
      // visit as a single day and quietly understate retention. The signup
      // column in users is already storing the offset the browser reported.
      label: 'Studied on two different days',
      count: one(`SELECT COUNT(*) AS n FROM (
        SELECT a.user_id FROM attempts a
        JOIN users u ON u.id = a.user_id
        GROUP BY a.user_id
        HAVING COUNT(DISTINCT date(a.answered_at,
          (-COALESCE(u.timezone_offset_minutes, 0)) || ' minutes')) >= 2)`),
    },
  ];
  return rows.map((r) => ({ ...r, share: signups ? r.count / signups : null }));
}

/**
 * The retest metric: of the concepts a student got wrong, how many did they
 * later get right?
 *
 * Measured per CONCEPT, not per question id, and that distinction is the whole
 * validity of the number.
 *
 * The bank is built in pairs: every question ends in `a` or `b`, and the two
 * halves of a pair test one concept from two directions ("which term matches
 * this description" against "what does this term mean"). 12,157 of 12,165
 * stems are exact pairs, and every pair shares a topic and a unit.
 *
 * The adaptive engine then deliberately avoids repeating a question: it filters
 * the topic pool to questions the student has NOT seen and only falls back to
 * the full pool once they are exhausted. With a median of 28 questions per
 * topic and 15 free questions a day, a student essentially never meets the same
 * question id twice in their first weeks.
 *
 * So matching on question id would have measured something the app is designed
 * never to do, and reported a recovery rate near zero no matter how well
 * students were learning. Matching on the concept measures the thing that
 * actually happens: miss the `a` side, meet the `b` side later, get it right.
 *
 * `retried` is reported separately from `recovered` because the two fail
 * differently. If retried is low, the app is not bringing missed concepts back
 * and that is a scheduling bug. If retried is high but recovered is low, it is
 * bringing them back and they are not sticking, which is a teaching problem in
 * the explanations.
 */

/* SQL fragment mapping a question id to its concept: drop one trailing a/b.
 * The 1,026 ids that end in neither are left whole. */
const CONCEPT_SQL = `
  CASE WHEN question_id GLOB '*[ab]'
       THEN substr(question_id, 1, length(question_id) - 1)
       ELSE question_id END`;

function recoveryOver(db, keyExpr) {
  const row = db.prepare(`
    WITH att AS (
      SELECT user_id, correct, answered_at, ${keyExpr} AS k FROM attempts
    ),
    first_try AS (
      SELECT user_id, k, MIN(answered_at) AS t0 FROM att GROUP BY user_id, k
    ),
    missed AS (
      SELECT f.user_id, f.k, f.t0
      FROM first_try f
      JOIN att a ON a.user_id = f.user_id AND a.k = f.k AND a.answered_at = f.t0
      WHERE a.correct = 0
    )
    SELECT
      COUNT(*) AS missed,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM att l
        WHERE l.user_id = m.user_id AND l.k = m.k AND l.answered_at > m.t0
      ) THEN 1 ELSE 0 END) AS retried,
      SUM(CASE WHEN EXISTS (
        SELECT 1 FROM att l
        WHERE l.user_id = m.user_id AND l.k = m.k AND l.answered_at > m.t0 AND l.correct = 1
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
    recoveryRate: missed ? recovered / missed : null,
    recoveryRateOfRetried: retried ? recovered / retried : null,
    retryRate: missed ? retried / missed : null,
  };
}

function retest(db) {
  const byConcept = recoveryOver(db, CONCEPT_SQL);
  // Kept only as a cross-check. Expected to be near zero by design, and a
  // number that is near zero for a known structural reason is not a finding.
  const byQuestion = recoveryOver(db, 'question_id');
  return { ...byConcept, exactQuestion: byQuestion };
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
    milestones: milestones(db),
    retest: retest(db),
    topicImprovement: topicImprovement(db),
    usage: usage(db),
    topCourses: topCourses(db),
    reportedQuestions: reportedQuestions(db),
    openBugs: openBugCount(db),
  };
}

module.exports = {
  snapshot, signups, funnel, milestones, retest, topicImprovement, usage,
  topCourses, reportedQuestions, openBugCount,
};
