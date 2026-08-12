'use strict';

const { randInt, pick, fmt, buildChoices, numericFallback } = require('./generator-core');

/**
 * Test-strategy templates.
 *
 * Some of this is arithmetic (guessing odds, pacing), which is computed. The
 * rest are judgement scenarios drawn from a bank. Every heuristic here is
 * framed as a tendency rather than a law, because teaching "the longest answer
 * is always right" produces confident wrong answers.
 */

const templates = [
  {
    idPrefix: 'gen-strat-poe', subject: 'Test Strategy', topic: 'Process of Elimination', difficulty: 'easy',
    build(rng) {
      const total = pick(rng, [4, 5]);
      const eliminated = randInt(rng, 1, total - 2);
      const remaining = total - eliminated;
      const before = Math.round((100 / total) * 10) / 10;
      const after = Math.round((100 / remaining) * 10) / 10;
      return {
        prompt: `On a ${total}-choice multiple choice question, eliminating ${eliminated} clearly wrong answer${eliminated > 1 ? 's' : ''} changes your odds of a correct guess from what to what?`,
        explanation: `One correct answer out of ${total} is about ${before}%. Removing ${eliminated} leaves ${remaining} options, so the odds become about ${after}%. Eliminating even one wrong answer measurably improves your expected score.`,
        ...buildChoices(rng, `${before}% to ${after}%`, [
          `${before}% to ${Math.round((100 / total) * 2 * 10) / 10}%`,
          `${after}% to ${before}%`,
          `${before}% to 100%`,
        ], (i) => `${before}% to ${after + (i + 1) * 5}%`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-pacing', subject: 'Test Strategy', topic: 'Time Management', difficulty: 'medium',
    build(rng) {
      const questions = pick(rng, [20, 22, 25, 27, 30, 35, 40, 44, 50]);
      const minutes = pick(rng, [25, 30, 35, 40, 45, 50, 60, 70]);
      const perQuestion = Math.round((minutes * 60) / questions);
      return {
        prompt: `A section has ${questions} questions and ${minutes} minutes. About how many seconds can you spend per question on average?`,
        explanation: `${minutes} minutes is ${minutes * 60} seconds. Divided by ${questions} questions, that is about ${perQuestion} seconds each. Knowing this number tells you when to cut a question loose.`,
        ...buildChoices(rng, `${perQuestion} seconds`, [
          `${Math.round(minutes / questions)} seconds`,   // forgot to convert to seconds
          `${Math.round((questions * 60) / minutes)} seconds`,  // inverted the division
          `${perQuestion * 2} seconds`,
        ], (i) => `${perQuestion + (i + 1) * 15} seconds`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-scenario', subject: 'Test Strategy', topic: 'Question Triage', difficulty: 'medium',
    build(rng) {
      const cases = [
        ['You are stuck on question 12 of 30 with limited time left',
          'Mark it, put down your best guess, move on, and return if time allows',
          ['Keep working until you solve it', 'Skip every remaining hard question', 'Start over from question 1'],
          'Every question is worth the same, so minutes spent on one cost you easier points elsewhere.'],
        ['You finish a section with eight minutes to spare',
          'Recheck the questions you flagged as uncertain',
          ['Recheck every question from the start', 'Leave early to rest', 'Change answers that feel wrong on instinct'],
          'Targeted rechecking finds errors; instinct-driven changes more often turn right answers into wrong ones.'],
        ['You have two minutes left and six questions unanswered',
          'Fill in an answer for every remaining question',
          ['Carefully solve one and leave the rest blank', 'Leave them blank to avoid errors', 'Answer only the ones that look easy'],
          'With no wrong-answer penalty, a blank scores the same as a wrong answer, so guessing is strictly better.'],
        ['A question involves a topic you never studied',
          'Eliminate what you can, guess, and spend your time elsewhere',
          ['Work it out from first principles no matter how long it takes', 'Leave it blank', 'Pick the longest answer choice'],
          'Time is the scarce resource, and a partial elimination still beats a blind guess.'],
      ];
      const [scenario, answer, distractors, why] = pick(rng, cases);
      return {
        prompt: `${scenario}. What is the best move?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, distractors, (i) => `Ask for extra time (${i + 1})`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-traps', subject: 'Test Strategy', topic: 'Trap Answers', difficulty: 'medium',
    build(rng) {
      const cases = [
        ['an answer choice matches a number you calculated in an intermediate step',
          'It may be a trap for stopping one step early',
          'Test writers deliberately include intermediate values. Re-read what the question actually asked for.'],
        ['an answer choice contains absolute words like "always", "never", or "all"',
          'It is more often wrong, because passages rarely support absolute claims',
          'Measured language like "often" or "suggests" is far easier to support from a text. This is a tendency, not a rule.'],
        ['two answer choices state the exact opposite of each other',
          'One of them is likely correct, since the question probably hinges on that distinction',
          'Direct opposites usually mark the point being tested. Still verify against the passage or the problem.'],
        ['an answer choice is true in the real world but not mentioned in the passage',
          'It is wrong, because reading answers must be supported by the text',
          'Outside knowledge is not evidence on a reading section. Only what the passage supports counts.'],
        ['an answer choice restates the question stem almost word for word',
          'It is often a distractor that adds no new information',
          'Correct answers usually advance the reasoning rather than echo the prompt.'],
      ];
      const [situation, answer, why] = pick(rng, cases);
      const distractors = [
        'It is definitely correct',
        'The question contains an error',
        'You should always choose the longest option',
        'Word choice has no bearing on correctness',
      ];
      return {
        prompt: `On a test question, ${situation}. What should you conclude?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, distractors, (i) => `Skip the question (${i + 1})`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-estimate', subject: 'Test Strategy', topic: 'Estimation', difficulty: 'medium',
    build(rng) {
      const target = pick(rng, [20, 30, 50, 80, 120]);
      const close = target + pick(rng, [-2, -1, 1, 2]);
      const small = Math.round(target / 10);
      const big = target * 20;
      const mid = target * 4;
      return {
        prompt: `The answer choices are ${small}, ${close}, ${mid}, and ${big}. Your rough estimate is "around ${target}". What should you do?`,
        explanation: `Select ${close}, since it is the only choice near your estimate. When choices span different orders of magnitude, an estimate is enough. Save exact computation for when the choices sit close together.`,
        ...buildChoices(rng, `Select ${close}`, [
          `Compute the exact value anyway`,
          `Select ${mid} as a safer middle option`,
          `Skip the question`,
        ], (i) => `Select ${big + i + 1}`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-backsolve', subject: 'Test Strategy', topic: 'Backsolving', difficulty: 'medium',
    build(rng) {
      const values = [];
      const start = randInt(rng, 2, 9);
      for (let i = 0; i < 4; i++) values.push(start + i * randInt(rng, 2, 5));
      const middle = values[1];
      return {
        prompt: `A question gives the numeric answer choices ${values.join(', ')} and the algebra looks slow to set up. What technique usually works faster?`,
        explanation: `Plug the choices back into the problem, starting with a middle value like ${middle}. If it is wrong, whether it came out too big or too small tells you which direction to move, often resolving the question in two tries.`,
        ...buildChoices(rng, `Substitute the answer choices, starting near the middle`, [
          `Always choose the largest value`,
          `Skip the question entirely`,
          `Pick the value closest to zero`,
        ], (i) => `Average all four choices (${i + 1})`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-graph', subject: 'Test Strategy', topic: 'Data Interpretation', difficulty: 'medium',
    build(rng) {
      const cases = [
        ['before reading any answer choices on a graph question',
          'Check the axis labels and units',
          'Most graph errors come from misreading units, for example reading thousands as ones.'],
        ['when a question asks about the RATE of change rather than the total',
          'Look at the steepness of the line, not its height',
          'Height shows the amount; slope shows how fast it is changing. Confusing the two is the most common graph mistake.'],
        ['when a chart has two different y-axes',
          'Check which series belongs to which axis before comparing them',
          'Dual axes can make a small change look dramatic, or make unrelated series appear to move together.'],
        ['when a question asks for the year with the largest INCREASE',
          'Compare year-over-year differences, not the raw values',
          'The tallest bar is often not the biggest jump, and that gap is exactly what the question tests.'],
      ];
      const [situation, answer, why] = pick(rng, cases);
      return {
        prompt: `What should you do ${situation}?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, [
          'Focus on the chart title',
          'Count the number of data points',
          'Check the colour scheme',
        ], (i) => `Read the caption twice (${i + 1})`),
      };
    },
  },
  {
    idPrefix: 'gen-strat-guess', subject: 'Test Strategy', topic: 'Guessing Strategy', difficulty: 'medium',
    build(rng) {
      const blanks = randInt(rng, 4, 12);
      const choices = pick(rng, [4, 5]);
      const expected = Math.round((blanks / choices) * 10) / 10;
      return {
        prompt: `You leave ${blanks} questions blank on a test with ${choices} choices per question and no penalty for wrong answers. About how many of those would you expect to get right by guessing instead?`,
        explanation: `Each blind guess has a 1 in ${choices} chance, so ${blanks} guesses yield about ${blanks}/${choices} = ${expected} correct answers. Since there is no wrong-answer penalty, guessing is strictly better than leaving blanks.`,
        ...buildChoices(rng, fmt(expected), [
          '0',
          fmt(blanks),
          fmt(Math.round((blanks / 2) * 10) / 10),
        ], numericFallback(expected)),
      };
    },
  },
  {
    idPrefix: 'gen-strat-reading', subject: 'Test Strategy', topic: 'Reading Approach', difficulty: 'medium',
    build(rng) {
      const cases = [
        ['reading the question stem before reading a long passage',
          'You read with a purpose, searching instead of absorbing',
          'It does not replace reading the passage, but it makes the reading far more efficient.'],
        ['a question asks what the author "implies"',
          'The answer must be supported by the text even though it is not stated directly',
          'An answer can be factually true and still wrong if the passage does not support it.'],
        ['a question asks for the "primary purpose" of a passage',
          'You need the overall point, not a detail from one paragraph',
          'Detail-level answers are the standard trap on main-idea questions.'],
        ['a paragraph begins with a word like "however" or "yet"',
          'The author is about to contrast with what came before',
          'Transition words map the structure of an argument and often mark where questions are aimed.'],
      ];
      const [situation, answer, why] = pick(rng, cases);
      return {
        prompt: `What is true about ${situation}?`,
        explanation: `${answer}. ${why}`,
        ...buildChoices(rng, answer, [
          'It lets you skip the passage entirely',
          'It guarantees a faster reading speed',
          'It reveals the correct answer immediately',
        ], (i) => `It only applies to short passages (${i + 1})`),
      };
    },
  },
];

module.exports = templates;
