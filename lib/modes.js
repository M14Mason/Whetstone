'use strict';

/**
 * Study modes.
 *
 * The adaptive Learn mode was the original product. It is the most effective
 * way to study, and it is also the least fun, which is why students bounce off
 * tools that only offer it. These modes exist because different tasks need
 * different practice:
 *
 *   Flashcards    - fast recognition passes, low pressure
 *   Match         - timed game, builds speed and makes review feel like play
 *   Practice Test - simulates the real thing under time pressure
 *   Review        - only the questions you have actually gotten wrong
 *
 * All four draw from the same content, so authoring one concept item feeds
 * every mode.
 */

const { getDb } = require('./db');

function shuffle(array, rng = Math.random) {
  const out = [...array];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build a WHERE clause from a scope.
 *
 * Accepts the same shape as plans.learningScope() so that every study mode
 * filters identically. Previously each mode built its own filter and Learn
 * disagreed with the others about what a student had actually signed up for.
 */
function scopeClause(scope = {}) {
  const where = [];
  const params = [];

  if (scope.courseId) { where.push('course_id = ?'); params.push(scope.courseId); }
  if (scope.unit) { where.push('unit = ?'); params.push(scope.unit); }

  if (Array.isArray(scope.courseIds) && scope.courseIds.length > 0) {
    where.push(`course_id IN (${scope.courseIds.map(() => '?').join(',')})`);
    params.push(...scope.courseIds);
  }
  if (Array.isArray(scope.subjects) && scope.subjects.length > 0) {
    where.push(`subject IN (${scope.subjects.map(() => '?').join(',')})`);
    params.push(...scope.subjects);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

/** Flashcards: term on the front, definition on the back. */
function getFlashcards(scope, limit = 30) {
  const { sql, params } = scopeClause(scope);
  const rows = getDb()
    .prepare(`SELECT * FROM cards ${sql} ORDER BY RANDOM() LIMIT ?`)
    .all(...params, limit);
  return rows.map((r) => ({
    id: r.id, front: r.front, back: r.back,
    unit: r.unit, difficulty: r.difficulty,
  }));
}

/**
 * Match: a grid of terms and definitions to pair up against the clock.
 * Six pairs is the sweet spot; more turns it into a scrolling chore.
 */
function getMatchSet(scope, pairs = 6) {
  const { sql, params } = scopeClause(scope);
  const rows = getDb()
    .prepare(`SELECT * FROM cards ${sql} ORDER BY RANDOM() LIMIT ?`)
    .all(...params, pairs);

  if (rows.length < 3) return null; // not enough content for a game

  const tiles = [];
  for (const row of rows) {
    tiles.push({ id: `${row.id}-t`, pairId: row.id, text: row.front, kind: 'term' });
    tiles.push({ id: `${row.id}-d`, pairId: row.id, text: row.back, kind: 'definition' });
  }
  return { pairs: rows.length, tiles: shuffle(tiles) };
}

/** Practice test: a fixed set of questions, graded at the end. */
function getTest(scope, count = 10) {
  const { sql, params } = scopeClause(scope);
  const rows = getDb()
    .prepare(`SELECT * FROM questions ${sql} ORDER BY RANDOM() LIMIT ?`)
    .all(...params, count);

  return rows.map((r) => ({
    id: r.id,
    subject: r.subject,
    topic: r.topic,
    unit: r.unit,
    difficulty: r.difficulty,
    prompt: r.prompt,
    choices: JSON.parse(r.choices),
  }));
}

/** Grade a submitted test without ever exposing answers beforehand. */
function gradeTest(answers) {
  const db = getDb();
  const results = [];
  let correct = 0;

  for (const [questionId, choice] of Object.entries(answers || {})) {
    const row = db.prepare('SELECT * FROM questions WHERE id = ?').get(questionId);
    if (!row) continue;
    const isCorrect = Number(choice) === row.answer;
    if (isCorrect) correct++;
    results.push({
      questionId,
      correct: isCorrect,
      chosen: Number(choice),
      correctChoice: row.answer,
      choices: JSON.parse(row.choices),
      prompt: row.prompt,
      explanation: row.explanation,
      topic: row.topic,
    });
  }

  const total = results.length;
  return {
    correct,
    total,
    percent: total === 0 ? 0 : Math.round((correct / total) * 100),
    results,
  };
}

/**
 * Review: questions the student has previously answered incorrectly and has
 * not since gotten right. This is the highest-value queue in the whole app.
 */
function getReviewQueue(userId, limit = 20) {
  const rows = getDb().prepare(`
    SELECT q.* FROM questions q
    JOIN (
      SELECT question_id,
             MAX(answered_at) AS last_at,
             SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END) AS misses
      FROM attempts WHERE user_id = ?
      GROUP BY question_id
      HAVING misses > 0
    ) a ON a.question_id = q.id
    WHERE (
      SELECT correct FROM attempts
      WHERE user_id = ? AND question_id = q.id
      ORDER BY answered_at DESC LIMIT 1
    ) = 0
    ORDER BY a.last_at DESC
    LIMIT ?
  `).all(userId, userId, limit);

  return rows.map((r) => ({
    id: r.id, subject: r.subject, topic: r.topic, unit: r.unit,
    difficulty: r.difficulty, prompt: r.prompt, choices: JSON.parse(r.choices),
  }));
}

function recordSession({ userId, mode, courseId, unit, score, total, durationMs }) {
  getDb().prepare(`
    INSERT INTO mode_sessions (user_id, mode, course_id, unit, score, total, duration_ms, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, mode, courseId || null, unit || null,
    score ?? null, total ?? null, durationMs ?? null, new Date().toISOString());
}

function recentSessions(userId, limit = 10) {
  return getDb()
    .prepare('SELECT * FROM mode_sessions WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit);
}

/** Personal bests, which is most of the reason Match is replayable. */
function bestMatchTime(userId, courseId, unit) {
  const row = getDb().prepare(`
    SELECT MIN(duration_ms) AS best FROM mode_sessions
    WHERE user_id = ? AND mode = 'match'
      AND (? IS NULL OR course_id = ?) AND (? IS NULL OR unit = ?)
  `).get(userId, courseId || null, courseId || null, unit || null, unit || null);
  return row && row.best ? row.best : null;
}

function countCards(scope = {}) {
  const { sql, params } = scopeClause(scope);
  const row = getDb().prepare(`SELECT COUNT(*) AS n FROM cards ${sql}`).get(...params);
  return row ? row.n : 0;
}

module.exports = {
  getFlashcards, getMatchSet, getTest, gradeTest, getReviewQueue,
  recordSession, recentSessions, bestMatchTime, countCards,
};
