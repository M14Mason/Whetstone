'use strict';

/**
 * Plausible wrong answers for a student's own flashcards.
 *
 * When you write a set of your own cards, Keen can turn it into multiple
 * choice. That needs three wrong options per card, and the quality of those
 * options is the whole difference between a real question and a joke. If the
 * right answer is "mitochondrion" and the other three are "Tuesday", "17" and
 * "the Treaty of Ghent", the question tests nothing: you can answer it without
 * knowing any biology.
 *
 * The rule this module follows is that a distractor has to be a thing that
 * could believably have been the answer. Three sources, in order of quality:
 *
 *   1. Other cards in the SAME set. Best source by far. If a student wrote a
 *      set of twenty organelles, the other nineteen organelles are exactly the
 *      wrong answers a real exam would use, because the student chose a
 *      coherent topic when they made the set.
 *   2. Answers from the course question bank for the same unit. Same topic,
 *      professionally written, and already the right register.
 *   3. Answers from anywhere in the same course. Weakest, and only used to
 *      finish filling a question when the first two run dry.
 *
 * If all three together cannot produce three options, the card is skipped
 * rather than padded with nonsense. A short quiz of real questions is worth
 * more than a long one full of giveaways.
 */

const MIN_OPTIONS = 4;   // one right answer plus three wrong

/** Deterministic shuffle when a seed is supplied, so tests are not flaky. */
function shuffle(list, rand = Math.random) {
  const out = list.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function normalise(text) {
  return String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Is `candidate` usable as a wrong answer for `correct`?
 *
 * Rejects three things:
 *  - the same answer wearing different punctuation or capitalisation, which
 *    would make the question unanswerable because two options are both right
 *  - anything wildly longer or shorter than the correct answer, because option
 *    length is the oldest tell in multiple choice: students learn to pick the
 *    longest one without reading it
 *  - empty or whitespace-only text
 */
function isUsableDistractor(candidate, correct, alreadyChosen) {
  const c = normalise(candidate);
  const right = normalise(correct);
  if (!c) return false;
  if (c === right) return false;
  if (alreadyChosen.has(c)) return false;

  // Length similarity. Allow a generous band; this is only meant to catch the
  // egregious cases, like a three-word answer among three one-word decoys.
  const ratio = c.length / Math.max(1, right.length);
  if (ratio < 0.35 || ratio > 2.8) return false;

  return true;
}

/**
 * Build one multiple-choice question from a card.
 *
 * @param {{front: string, back: string}} card       the card being asked
 * @param {string[]} pools  candidate answers, best source first
 * @returns {{prompt, choices, answer} | null}
 */
function buildQuestion(card, pools, rand = Math.random) {
  const chosen = [];
  const seen = new Set([normalise(card.back)]);

  for (const pool of pools) {
    if (chosen.length >= MIN_OPTIONS - 1) break;
    for (const candidate of shuffle(pool, rand)) {
      if (chosen.length >= MIN_OPTIONS - 1) break;
      if (!isUsableDistractor(candidate, card.back, seen)) continue;
      chosen.push(String(candidate).trim());
      seen.add(normalise(candidate));
    }
  }

  // Not enough believable wrong answers. Skip rather than invent.
  if (chosen.length < MIN_OPTIONS - 1) return null;

  const options = shuffle([card.back, ...chosen], rand);
  return {
    prompt: card.front,
    choices: options,
    answer: options.indexOf(card.back),
  };
}

/**
 * Turn a whole set into a quiz.
 *
 * @param {Array<{front,back}>} cards        the student's own cards
 * @param {string[]} bankAnswers             answers from the matching course unit
 * @param {string[]} courseAnswers           answers from anywhere in the course
 * @returns {{questions: Array, skipped: number}}
 */
function quizFromSet(cards, bankAnswers = [], courseAnswers = [], rand = Math.random) {
  const valid = (cards || []).filter((c) => c && String(c.front).trim() && String(c.back).trim());
  const questions = [];
  let skipped = 0;

  for (const card of valid) {
    // Sibling cards first: same set, same topic, written by the same person.
    const siblings = valid.filter((c) => c !== card).map((c) => c.back);
    const q = buildQuestion(card, [siblings, bankAnswers, courseAnswers], rand);
    if (q) questions.push(q); else skipped += 1;
  }

  return { questions, skipped };
}

module.exports = {
  MIN_OPTIONS,
  isUsableDistractor,
  buildQuestion,
  quizFromSet,
  _shuffle: shuffle,
  _normalise: normalise,
};
