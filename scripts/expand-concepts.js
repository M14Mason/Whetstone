#!/usr/bin/env node
'use strict';

/**
 * Expands authored concept banks into questions and flashcards.
 *
 *   node scripts/expand-concepts.js
 *
 * Reads data/concepts/<courseId>.json, cross-checks every unit name against the
 * course catalog (a typo in a unit name would silently orphan the content), and
 * writes:
 *
 *   data/questions.concepts.json  - multiple choice, for Learn and Test modes
 *   data/cards.json               - term/definition pairs, for Flashcards and Match
 */

const fs = require('node:fs');
const path = require('node:path');

const { expandUnit } = require('./lib/concept-expander');
const courses = require('../lib/courses');

const CONCEPTS_DIR = path.join(__dirname, '..', 'data', 'concepts');
const DATA_DIR = path.join(__dirname, '..', 'data');
const BASE_SEED = 20260811;

if (!fs.existsSync(CONCEPTS_DIR)) {
  console.error('No data/concepts directory found.');
  process.exit(1);
}

const files = fs.readdirSync(CONCEPTS_DIR).filter((f) => f.endsWith('.json')).sort();
const allQuestions = [];
const allCards = [];
const problems = [];
const perCourse = [];

files.forEach((file, fileIndex) => {
  let bank;
  try {
    bank = JSON.parse(fs.readFileSync(path.join(CONCEPTS_DIR, file), 'utf8'));
  } catch (err) {
    problems.push(`${file}: invalid JSON (${err.message})`);
    return;
  }

  const course = courses.getCourse(bank.courseId);
  if (!course) {
    problems.push(`${file}: courseId "${bank.courseId}" is not in the course catalog`);
    return;
  }

  const catalogUnits = new Set(course.units.map((u) => u.name));
  let courseQuestions = 0;
  let courseCards = 0;
  let unitsCovered = 0;

  Object.entries(bank.units || {}).forEach(([unitName, items], unitIndex) => {
    if (!catalogUnits.has(unitName)) {
      problems.push(`${file}: unit "${unitName}" does not exist in ${course.name}`);
      return;
    }
    if (!Array.isArray(items) || items.length === 0) return;

    // Reject duplicate terms inside a unit: they would become two choices that
    // are both correct, which is unanswerable.
    const terms = items.map((i) => (Array.isArray(i) ? i[0] : i.term));
    const dupes = terms.filter((t, i) => terms.indexOf(t) !== i);
    if (dupes.length > 0) {
      problems.push(`${file} / ${unitName}: duplicate terms: ${[...new Set(dupes)].join(', ')}`);
    }

    const { questions, cards } = expandUnit({
      courseId: course.id,
      courseName: course.name,
      unitName,
      subject: bank.subject || course.category,
      items,
      seed: BASE_SEED + fileIndex * 1013 + unitIndex * 31,
    });

    allQuestions.push(...questions);
    allCards.push(...cards);
    courseQuestions += questions.length;
    courseCards += cards.length;
    unitsCovered++;
  });

  perCourse.push({
    course: course.name,
    unitsCovered,
    unitsTotal: course.units.length,
    questions: courseQuestions,
    cards: courseCards,
  });
});

if (problems.length > 0) {
  console.error('\nProblems found:\n');
  for (const p of problems) console.error(`  ${p}`);
  console.error('');
  process.exit(1);
}

fs.writeFileSync(
  path.join(DATA_DIR, 'questions.concepts.json'),
  `${JSON.stringify(allQuestions, null, 2)}\n`
);
fs.writeFileSync(
  path.join(DATA_DIR, 'cards.json'),
  `${JSON.stringify(allCards, null, 2)}\n`
);

console.log('\nConcept expansion\n');
for (const row of perCourse.sort((a, b) => b.questions - a.questions)) {
  console.log(
    `  ${String(row.questions).padStart(5)} questions  ${String(row.cards).padStart(4)} cards  ` +
    `${row.unitsCovered}/${row.unitsTotal} units  ${row.course}`
  );
}
console.log(`\n  Total: ${allQuestions.length} questions, ${allCards.length} flashcards`);
console.log(`  From ${files.length} concept bank(s)\n`);
