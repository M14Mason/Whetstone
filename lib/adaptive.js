'use strict';

/**
 * The adaptive engine.
 *
 * Two ideas do the real work here:
 *
 *   1. Ability estimation (Elo). Every topic a student touches gets its own
 *      rating. Questions have ratings too, derived from difficulty. Answering
 *      correctly moves the student's rating up by an amount proportional to how
 *      surprising the result was, so beating a hard question moves you more than
 *      beating an easy one. This is the same math chess ratings use.
 *
 *   2. Spaced repetition. Getting something right pushes the next review
 *      further out; getting it wrong resets the interval to zero so the topic
 *      comes back immediately. Weak topics resurface constantly, solid ones
 *      fade into occasional review.
 *
 * Selection then blends the two: pick a topic weighted by how weak and how due
 * it is, then pick the question inside that topic whose difficulty sits just
 * above the student's current ability.
 */

const { getDb } = require('./db');
const coursesLib = require('./courses');
const { config } = require('./config');

const A = config.adaptive;
const EWMA_ALPHA = 0.3;

function questionRating(difficulty) {
  return A.difficultyRatings[difficulty] ?? A.difficultyRatings.medium;
}

function expectedScore(ability, rating) {
  return 1 / (1 + Math.pow(10, (rating - ability) / 400));
}

function defaultState(userId, subject, topic) {
  return {
    user_id: userId,
    topic,
    subject,
    ability: A.startingAbility,
    attempts: 0,
    correct: 0,
    ewma_correct: 0.5,
    streak: 0,
    interval_index: 0,
    due_at: new Date(0).toISOString(),
    last_seen_at: null,
  };
}

function getTopicState(userId, subject, topic) {
  const row = getDb()
    .prepare('SELECT * FROM topic_state WHERE user_id = ? AND topic = ?')
    .get(userId, topic);
  return row || defaultState(userId, subject, topic);
}

function getAllTopicStates(userId) {
  return getDb().prepare('SELECT * FROM topic_state WHERE user_id = ?').all(userId);
}

/**
 * Apply the result of one answer: update ability, accuracy, and the review
 * schedule. Returns a summary of what moved, which the UI shows to the student.
 */
function recordResult(userId, question, isCorrect, options = {}) {
  const { chosen = null, now = new Date() } = options;
  const db = getDb();
  const state = getTopicState(userId, question.subject, question.topic);
  const rating = questionRating(question.difficulty);
  const score = isCorrect ? 1 : 0;

  const expected = expectedScore(state.ability, rating);
  const abilityBefore = state.ability;
  const ability = state.ability + A.kFactor * (score - expected);

  const ewma = (1 - EWMA_ALPHA) * state.ewma_correct + EWMA_ALPHA * score;
  const streak = isCorrect ? state.streak + 1 : 0;

  // Correct answers push the review further out; a miss resets to "show me again now".
  const maxIndex = A.reviewIntervalsMinutes.length - 1;
  const intervalIndex = isCorrect ? Math.min(state.interval_index + 1, maxIndex) : 0;
  const dueAt = new Date(now.getTime() + A.reviewIntervalsMinutes[intervalIndex] * 60_000);

  db.prepare(`
    INSERT INTO topic_state
      (user_id, topic, subject, ability, attempts, correct, ewma_correct, streak, interval_index, due_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, topic) DO UPDATE SET
      ability        = excluded.ability,
      attempts       = excluded.attempts,
      correct        = excluded.correct,
      ewma_correct   = excluded.ewma_correct,
      streak         = excluded.streak,
      interval_index = excluded.interval_index,
      due_at         = excluded.due_at,
      last_seen_at   = excluded.last_seen_at
  `).run(
    userId,
    question.topic,
    question.subject,
    ability,
    state.attempts + 1,
    state.correct + score,
    ewma,
    streak,
    intervalIndex,
    dueAt.toISOString(),
    now.toISOString()
  );

  db.prepare(`
    INSERT INTO attempts (user_id, question_id, subject, topic, correct, chosen, answered_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    question.id,
    question.subject,
    question.topic,
    score,
    Number.isInteger(chosen) ? chosen : null,
    now.toISOString()
  );

  return {
    topic: question.topic,
    abilityBefore: Math.round(abilityBefore),
    abilityAfter: Math.round(ability),
    abilityDelta: Math.round(ability - abilityBefore),
    streak,
    nextReviewMinutes: A.reviewIntervalsMinutes[intervalIndex],
    masteryPercent: Math.round(ewma * 100),
  };
}

/**
 * How urgently should this topic be practiced right now?
 * Higher score = more likely to be served next.
 */
function topicPriority(state, now) {
  // Brand new topics get a strong exploration bonus so the engine finds
  // weak spots quickly instead of grinding the first topic it sees.
  if (state.attempts === 0) return 1.6;

  const weakness = 1 - state.ewma_correct;      // 0 = perfect, 1 = always wrong
  const isDue = new Date(state.due_at) <= now;
  const dueness = isDue ? 1 : 0.15;             // not-yet-due topics stay possible, just unlikely

  // Low-confidence estimates (few attempts) get a small nudge so the engine
  // keeps sampling them until it actually knows where the student stands.
  const uncertainty = Math.exp(-state.attempts / 6);

  return (0.15 + weakness + 0.35 * uncertainty) * dueness;
}

function weightedPick(items, weightFn, rng = Math.random) {
  const weights = items.map(weightFn);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return items[Math.floor(rng() * items.length)];
  let roll = rng() * total;
  for (let i = 0; i < items.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return items[i];
  }
  return items[items.length - 1];
}

function recentQuestionIds(userId, limit = A.recentQuestionMemory) {
  return getDb()
    .prepare('SELECT question_id FROM attempts WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit)
    .map((r) => r.question_id);
}

/**
 * Choose the next question for a student.
 * @returns {object|null} question row, or null if nothing is available.
 */
/* ---- honors courses -------------------------------------------------------
 *
 * An honors section covers the same syllabus as the regular course, so it
 * reuses that course's questions rather than duplicating roughly 300 per
 * course. Two pieces make that work:
 *
 *   bankFor()        maps an honors course id to the course whose questions it
 *                    should draw from.
 *   biasForHonors()  drops the easy tier when EVERY requested course is honors,
 *                    which is what actually distinguishes honors from regular
 *                    here. The fallback matters: if a unit happens to contain
 *                    only easy questions, returning nothing would render the
 *                    course broken, so the unfiltered pool is used instead.
 */
function isHonors(courseId) {
  return coursesLib.getCourse(courseId)?.level === 'honors';
}

function biasForHonors(pool, courseIds) {
  if (!pool.length || !courseIds.length || !courseIds.every(isHonors)) return pool;
  const harder = pool.filter((q) => q.difficulty !== 'easy');
  return harder.length >= 10 ? harder : pool;
}

function selectNextQuestion(userId, scope, rng = Math.random, now = new Date()) {
  const db = getDb();

  // Accepts either a scope object from plans.learningScope() or, for backward
  // compatibility, a bare array of subject names.
  const resolved = Array.isArray(scope) ? { kind: 'subjects', subjects: scope } : (scope || {});

  let pool = [];
  if (resolved.kind === 'unit' && resolved.courseId && resolved.unit) {
    pool = db.prepare('SELECT * FROM questions WHERE course_id = ? AND unit = ?')
      .all(coursesLib.bankFor(resolved.courseId), resolved.unit);
    pool = biasForHonors(pool, [resolved.courseId]);
  } else if ((resolved.kind === 'course' || resolved.kind === 'courses') && resolved.courseIds?.length) {
    const banks = resolved.courseIds.map(coursesLib.bankFor);
    const ph = banks.map(() => '?').join(',');
    pool = db.prepare(`SELECT * FROM questions WHERE course_id IN (${ph})`).all(...banks);
    pool = biasForHonors(pool, resolved.courseIds);
  } else if (resolved.subjects?.length) {
    const ph = resolved.subjects.map(() => '?').join(',');
    pool = db.prepare(`SELECT * FROM questions WHERE subject IN (${ph})`).all(...resolved.subjects);
  }

  if (pool.length === 0) return null;

  const recent = new Set(recentQuestionIds(userId));
  let candidates = pool.filter((q) => !recent.has(q.id));
  // If the bank is small enough that everything is "recent", allow repeats
  // rather than refusing to serve a question.
  if (candidates.length === 0) candidates = pool;

  // Group candidates by topic.
  const byTopic = new Map();
  for (const q of candidates) {
    if (!byTopic.has(q.topic)) byTopic.set(q.topic, []);
    byTopic.get(q.topic).push(q);
  }

  const topics = [...byTopic.keys()];
  const stateByTopic = new Map();
  for (const topic of topics) {
    const subject = byTopic.get(topic)[0].subject;
    stateByTopic.set(topic, getTopicState(userId, subject, topic));
  }

  const chosenTopic = weightedPick(topics, (t) => topicPriority(stateByTopic.get(t), now), rng);
  const state = stateByTopic.get(chosenTopic);
  const target = state.ability + A.targetChallengeOffset;

  // Prefer questions the student has never seen, then the closest difficulty match.
  const seenIds = new Set(
    db.prepare('SELECT DISTINCT question_id FROM attempts WHERE user_id = ? AND topic = ?')
      .all(userId, chosenTopic)
      .map((r) => r.question_id)
  );

  const topicQuestions = byTopic.get(chosenTopic);
  const unseen = topicQuestions.filter((q) => !seenIds.has(q.id));
  const searchSet = unseen.length > 0 ? unseen : topicQuestions;

  let best = searchSet[0];
  let bestDistance = Infinity;
  for (const q of searchSet) {
    const distance = Math.abs(questionRating(q.difficulty) - target);
    if (distance < bestDistance) {
      best = q;
      bestDistance = distance;
    }
  }
  return best;
}

function masteryStatus(state) {
  if (state.attempts === 0) return 'new';
  if (state.attempts < 3) return 'learning';
  if (state.ewma_correct >= A.masteryThreshold) return 'mastered';
  if (state.ewma_correct >= 0.6) return 'solid';
  return 'weak';
}

/**
 * Dashboard payload: per-topic mastery plus the specific weak spots to work on.
 */
function buildMasteryReport(userId) {
  const db = getDb();
  const states = getAllTopicStates(userId);
  const allTopics = db.prepare('SELECT DISTINCT subject, topic FROM questions').all();
  const stateByTopic = new Map(states.map((s) => [s.topic, s]));

  const bySubject = new Map();
  for (const { subject, topic } of allTopics) {
    const state = stateByTopic.get(topic) || defaultState(userId, subject, topic);
    const entry = {
      topic,
      subject,
      attempts: state.attempts,
      correct: state.correct,
      masteryPercent: state.attempts === 0 ? null : Math.round(state.ewma_correct * 100),
      ability: Math.round(state.ability),
      streak: state.streak,
      status: masteryStatus(state),
      dueAt: state.due_at,
    };
    if (!bySubject.has(subject)) bySubject.set(subject, []);
    bySubject.get(subject).push(entry);
  }

  const practiced = [...bySubject.values()].flat().filter((t) => t.attempts > 0);
  const weakSpots = practiced
    .filter((t) => t.status === 'weak' || t.status === 'learning')
    .sort((a, b) => a.masteryPercent - b.masteryPercent)
    .slice(0, 5);

  const totalAttempts = practiced.reduce((sum, t) => sum + t.attempts, 0);
  const totalCorrect = practiced.reduce((sum, t) => sum + t.correct, 0);

  return {
    subjects: [...bySubject.entries()].map(([subject, topics]) => ({
      subject,
      topics: topics.sort((a, b) => a.topic.localeCompare(b.topic)),
    })),
    weakSpots,
    totals: {
      topicsTouched: practiced.length,
      topicsMastered: practiced.filter((t) => t.status === 'mastered').length,
      totalAttempts,
      totalCorrect,
      overallAccuracy: totalAttempts === 0 ? null : Math.round((totalCorrect / totalAttempts) * 100),
    },
  };
}

module.exports = {
  selectNextQuestion,
  recordResult,
  buildMasteryReport,
  getTopicState,
  getAllTopicStates,
  topicPriority,
  expectedScore,
  questionRating,
  masteryStatus,
  defaultState,
};

/**
 * The learning profile: what Whetstone has worked out about this specific
 * student that a competitor would start at zero on.
 *
 * This is the honest version of a retention feature. It does not punish
 * absence or manufacture streak anxiety. It shows the value already earned,
 * which grows on its own the more the student uses the app. A rival product
 * cannot copy it, because it is not content - it is a model of one person.
 */
function learningProfile(userId) {
  const db = getDb();

  const totals = db.prepare(`
    SELECT COUNT(*) AS answered,
           SUM(CASE WHEN correct = 1 THEN 1 ELSE 0 END) AS correct,
           COUNT(DISTINCT substr(answered_at, 1, 10)) AS days_studied,
           MIN(substr(answered_at, 1, 10)) AS first_day
    FROM attempts WHERE user_id = ?
  `).get(userId) || {};

  const topics = db.prepare(`
    SELECT topic, subject, ability, attempts, correct
    FROM topic_state WHERE user_id = ? AND attempts > 0
  `).all(userId);

  // A topic counts as mastered once the engine's ability estimate clears the
  // rating of a hard question, which is where it stops scheduling it often.
  const mastered = topics.filter((t) => t.ability >= 1200);

  const weakest = topics
    .filter((t) => t.attempts >= 2)
    .sort((a, b) => a.ability - b.ability)
    .slice(0, 5)
    .map((t) => t.topic);

  // Questions queued to come back because THIS student got them wrong. This
  // is the part a competing app starts at zero on.
  const dueNow = db.prepare(
    "SELECT COUNT(*) AS n FROM topic_state WHERE user_id = ? AND due_at <= ?"
  ).get(userId, new Date().toISOString()) || { n: 0 };

  return {
    answered: totals.answered || 0,
    correct: totals.correct || 0,
    daysStudied: totals.days_studied || 0,
    firstDay: totals.first_day || null,
    topicsTracked: topics.length,
    topicsMastered: mastered.length,
    weakest,
    dueNow: dueNow.n || 0,
  };
}

module.exports.learningProfile = learningProfile;
