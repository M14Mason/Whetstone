'use strict';

/**
 * Concept expansion: one authored item becomes many study artifacts.
 *
 * A concept item is just a term and a definition:
 *
 *     ["Mitochondria", "Organelle that produces ATP through cellular respiration"]
 *
 * From that single pair this module produces:
 *
 *   - a term-to-definition multiple choice question
 *   - a definition-to-term multiple choice question
 *   - a flashcard (front / back)
 *   - a match-game pair
 *
 * That is roughly 4x leverage on authoring effort, and it is the same model
 * Quizlet uses: the reason their Learn, Flashcards, Match, and Test modes all
 * work from one set is that a term/definition pair is the atomic unit.
 *
 * Distractors are drawn from OTHER items in the SAME unit. This matters
 * pedagogically: a student who confuses mitochondria with ribosomes needs those
 * two side by side. Pulling a distractor from an unrelated course would make
 * the question trivially easy and teach nothing.
 */

const { makeRng, shuffle } = require('./generator-core');

const MIN_ITEMS_FOR_MC = 4; // need 1 correct + 3 distractors

/**
 * Difficulty is assigned by position within the unit so a unit is not uniformly
 * hard. Early items are foundational, later ones build on them.
 */
function difficultyFor(index, total) {
  const ratio = total <= 1 ? 0 : index / (total - 1);
  if (ratio < 0.4) return 'easy';
  if (ratio < 0.8) return 'medium';
  return 'hard';
}

function truncate(text, max = 90) {
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}...`;
}

/**
 * Expand one unit's concept items into questions.
 *
 * @param {object} params
 * @param {string} params.courseId
 * @param {string} params.courseName
 * @param {string} params.unitName
 * @param {string} params.subject   coarse subject for the adaptive engine
 * @param {Array}  params.items     [[term, definition], ...]
 * @param {number} params.seed
 */
function expandUnit({ courseId, courseName, unitName, subject, items, seed }) {
  const rng = makeRng(seed);
  const questions = [];
  const cards = [];

  const clean = items
    .map((item) => (Array.isArray(item) ? { term: item[0], definition: item[1] } : item))
    .filter((it) => it && it.term && it.definition);

  if (clean.length === 0) return { questions, cards };

  const unitSlug = unitName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const idBase = `${courseId}--${unitSlug}`;

  clean.forEach((item, index) => {
    const difficulty = difficultyFor(index, clean.length);

    // Flashcard and match pair come straight from the item.
    cards.push({
      id: `${idBase}-card-${index + 1}`,
      courseId,
      unit: unitName,
      subject,
      front: item.term,
      back: item.definition,
      difficulty,
    });

    if (clean.length < MIN_ITEMS_FOR_MC) return;

    const others = clean.filter((_, i) => i !== index);

    // ---- Question A: given the definition, pick the term.
    const termDistractors = shuffle(rng, others).slice(0, 3).map((o) => o.term);
    if (new Set([item.term, ...termDistractors]).size === 4) {
      const choicesA = shuffle(rng, [item.term, ...termDistractors]);
      questions.push({
        id: `${idBase}-q${index + 1}a`,
        subject,
        topic: unitName,
        courseId,
        courseName,
        unit: unitName,
        difficulty,
        prompt: `${courseName} - ${unitName}\n\nWhich term matches this description?\n\n"${item.definition}"`,
        choices: choicesA,
        answer: choicesA.indexOf(item.term),
        explanation: `${item.term}: ${item.definition}`,
      });
    }

    // ---- Question B: given the term, pick the definition.
    const defDistractors = shuffle(rng, others).slice(0, 3).map((o) => o.definition);
    if (new Set([item.definition, ...defDistractors]).size === 4) {
      const choicesB = shuffle(rng, [item.definition, ...defDistractors]);
      questions.push({
        id: `${idBase}-q${index + 1}b`,
        subject,
        topic: unitName,
        courseId,
        courseName,
        unit: unitName,
        difficulty: difficulty === 'easy' ? 'medium' : difficulty,
        prompt: `${courseName} - ${unitName}\n\nWhat does "${item.term}" refer to?`,
        choices: choicesB,
        answer: choicesB.indexOf(item.definition),
        explanation: `${item.term}: ${item.definition}`,
      });
    }
  });

  return { questions, cards };
}

module.exports = { expandUnit, difficultyFor, truncate, MIN_ITEMS_FOR_MC };
