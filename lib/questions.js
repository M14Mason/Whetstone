'use strict';

const fs = require('node:fs');
const coursesLib = require('./courses');
const path = require('node:path');
const crypto = require('node:crypto');
const { getDb } = require('./db');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

/**
 * Load every data/questions.*.json file and validate it.
 * Validation is strict on purpose: a question bank with a bad answer index
 * silently teaches students the wrong thing, which is the worst failure mode
 * this product has.
 */
function loadQuestionFiles() {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.startsWith('questions.') && f.endsWith('.json'))
    .sort();

  const questions = [];
  const errors = [];
  const seenIds = new Set();

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON (${err.message})`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      errors.push(`${file}: expected a top-level array`);
      continue;
    }

    parsed.forEach((q, i) => {
      const where = `${file}[${i}]`;
      if (!q || typeof q !== 'object') return errors.push(`${where}: not an object`);
      for (const field of ['id', 'subject', 'topic', 'difficulty', 'prompt', 'explanation']) {
        if (typeof q[field] !== 'string' || !q[field].trim()) {
          errors.push(`${where}: missing or empty "${field}"`);
        }
      }
      if (seenIds.has(q.id)) errors.push(`${where}: duplicate id "${q.id}"`);
      seenIds.add(q.id);

      if (!VALID_DIFFICULTIES.has(q.difficulty)) {
        errors.push(`${where}: difficulty must be easy, medium, or hard`);
      }
      if (!Array.isArray(q.choices) || q.choices.length < 2) {
        errors.push(`${where}: needs at least 2 choices`);
      } else {
        if (q.choices.some((c) => typeof c !== 'string' || !c.trim())) {
          errors.push(`${where}: all choices must be non-empty strings`);
        }
        if (new Set(q.choices).size !== q.choices.length) {
          errors.push(`${where}: choices must be unique`);
        }
        if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
          errors.push(`${where}: "answer" must be a valid index into choices`);
        }
      }
      questions.push(q);
    });
  }

  return { questions, errors };
}

/**
 * A cheap fingerprint of the content on disk: every data file's size and
 * modification time. Rebuilding it costs a few stat calls; comparing it costs
 * nothing. Reseeding an unchanged bank costs ~52 seconds of upserts, which the
 * server used to pay on every single boot.
 */
function contentFingerprint() {
  const parts = [];
  for (const file of fs.readdirSync(DATA_DIR).sort()) {
    if (!file.endsWith('.json')) continue;
    const st = fs.statSync(path.join(DATA_DIR, file));
    parts.push(`${file}:${st.size}:${Math.trunc(st.mtimeMs)}`);
  }
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

/* Remove content whose course no longer exists in data/courses/.
 *
 * Seeding upserts, so deleting a course leaves its rows behind in any database
 * that already had them. Those orphans are not merely untidy: a student on the
 * subject-level fallback scope can still be served them, so a removed course
 * keeps turning up in practice.
 *
 * This runs BEFORE the fingerprint short-circuit and on every boot. Putting it
 * after meant it only ran when the question files themselves changed, so anyone
 * upgrading with an existing database kept the orphans indefinitely. Render's
 * free plan hides the whole problem by wiping /tmp on each deploy, which is
 * why it would have surfaced only on the first persistent deployment.
 */
function pruneRemovedCourses({ quiet = false } = {}) {
  const db = getDb();
  const live = new Set(coursesLib.allCourses().map((c) => c.id));
  const pruned = { questions: 0, cards: 0 };

  for (const table of ['questions', 'cards']) {
    const rows = db.prepare(`SELECT DISTINCT course_id FROM ${table} WHERE course_id IS NOT NULL`).all();
    const dead = rows.map((r) => r.course_id).filter((id) => !live.has(id));
    if (!dead.length) continue;
    const ph = dead.map(() => '?').join(',');
    pruned[table] = db.prepare(`DELETE FROM ${table} WHERE course_id IN (${ph})`).run(...dead).changes;
  }

  if (!quiet && (pruned.questions || pruned.cards)) {
    console.log(`  Pruned ${pruned.questions} questions and ${pruned.cards} cards from removed courses.`);
  }
  return pruned;
}

function seed({ reset = false, quiet = false } = {}) {
  const db = getDb();

  // Always runs, even when the fingerprint is unchanged.
  const pruned = pruneRemovedCourses({ quiet });

  // Skip the whole import when nothing on disk has changed since last boot.
  // `reset` always forces a full rebuild.
  const fingerprint = contentFingerprint();
  if (!reset) {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'content_fingerprint'").get();
    if (row && row.value === fingerprint) {
      if (!quiet) console.log('  Question bank unchanged, skipping import.');
      return { skipped: true, pruned };
    }
  }

  const { questions, errors } = loadQuestionFiles();

  if (errors.length > 0) {
    const message = `Question bank validation failed:\n  - ${errors.join('\n  - ')}`;
    throw new Error(message);
  }

  if (reset) db.prepare('DELETE FROM questions').run();

  const insert = db.prepare(`
    INSERT INTO questions (id, subject, topic, difficulty, prompt, choices, answer, explanation, course_id, unit)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      subject     = excluded.subject,
      topic       = excluded.topic,
      difficulty  = excluded.difficulty,
      prompt      = excluded.prompt,
      choices     = excluded.choices,
      answer      = excluded.answer,
      explanation = excluded.explanation,
      course_id   = excluded.course_id,
      unit        = excluded.unit
  `);

  for (const q of questions) {
    insert.run(q.id, q.subject, q.topic, q.difficulty, q.prompt,
      JSON.stringify(q.choices), q.answer, q.explanation,
      q.courseId || null, q.unit || null);
  }

  // Flashcards live alongside questions and power Flashcards and Match modes.
  const cardsPath = path.join(DATA_DIR, 'cards.json');
  if (fs.existsSync(cardsPath)) {
    let cards = [];
    try {
      cards = JSON.parse(fs.readFileSync(cardsPath, 'utf8'));
    } catch (err) {
      throw new Error(`data/cards.json is invalid JSON: ${err.message}`);
    }
    if (reset) db.prepare('DELETE FROM cards').run();
    const insertCard = db.prepare(`
      INSERT INTO cards (id, course_id, unit, subject, front, back, difficulty)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        course_id = excluded.course_id, unit = excluded.unit, subject = excluded.subject,
        front = excluded.front, back = excluded.back, difficulty = excluded.difficulty
    `);
    for (const c of cards) {
      insertCard.run(c.id, c.courseId || null, c.unit || null, c.subject, c.front, c.back, c.difficulty);
    }
  }

  db.prepare(`INSERT INTO schema_meta (key, value) VALUES ('content_fingerprint', ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(fingerprint);

  const stats = db.prepare(`
    SELECT subject, COUNT(*) AS n FROM questions GROUP BY subject ORDER BY subject
  `).all();

  if (!quiet) {
    console.log(`Seeded ${questions.length} questions.`);
    for (const row of stats) console.log(`  ${row.subject}: ${row.n}`);
  }
  return { count: questions.length, stats };
}

function getQuestion(id) {
  const row = getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  return { ...row, choices: JSON.parse(row.choices) };
}

/** Strip the answer before sending a question to the browser. */
function forClient(row) {
  const q = typeof row.choices === 'string' ? hydrate(row) : row;
  return {
    id: q.id,
    subject: q.subject,
    topic: q.topic,
    difficulty: q.difficulty,
    prompt: q.prompt,
    choices: q.choices,
  };
}

function countQuestions() {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM questions').get();
  return row ? row.n : 0;
}

module.exports = { seed, pruneRemovedCourses, loadQuestionFiles, getQuestion, forClient, hydrate, countQuestions };
