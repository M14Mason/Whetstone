#!/usr/bin/env node
'use strict';

/**
 * Generates the parametric portion of the question bank.
 *
 *   node scripts/generate-questions.js [--per N] [--seed N]
 *
 * Output is written to data/questions.generated.<subject>.json and committed to
 * the repo, so questions are reviewable in diffs and stable across runs. The
 * seed is fixed by default: regenerating produces byte-identical output unless
 * you change a template or pass a different seed.
 */

const fs = require('node:fs');
const path = require('node:path');

const { generate } = require('./lib/generator-core');
const mathTemplates = require('./lib/templates-math');
const scienceTemplates = require('./lib/templates-science');
const englishTemplates = require('./lib/templates-english');
const codingTemplates = require('./lib/templates-coding');
const strategyTemplates = require('./lib/templates-strategy');

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return fallback;
  const value = Number(args[i + 1]);
  return Number.isFinite(value) ? value : fallback;
}

const PER_OVERRIDE = argValue('--per', 0);
const BASE_SEED = argValue('--seed', 20260810);
const DATA_DIR = path.join(__dirname, '..', 'data');

/**
 * Per-template counts are tuned per subject so the finished bank is BALANCED,
 * not just large. Math has the most templates, so left unchecked it would
 * dominate: a student who picks English should not run out of questions in a
 * day while Math has hundreds spare.
 *
 * Subjects with word-bank templates (English, Coding, Strategy) have a smaller
 * parameter space, so they get a higher per-template target and the deduplicator
 * caps them naturally.
 */
const GROUPS = [
  { file: 'questions.generated.math.json', templates: mathTemplates, label: 'Math', per: 9 },
  { file: 'questions.generated.science.json', templates: scienceTemplates, label: 'Science', per: 11 },
  { file: 'questions.generated.english.json', templates: englishTemplates, label: 'English', per: 12 },
  { file: 'questions.generated.coding.json', templates: codingTemplates, label: 'Coding', per: 22 },
  { file: 'questions.generated.strategy.json', templates: strategyTemplates, label: 'Test Strategy', per: 26 },
];

let grandTotal = 0;

for (const group of GROUPS) {
  const all = [];
  const perTopic = new Map();
  const perTemplate = PER_OVERRIDE || group.per;

  group.templates.forEach((template, index) => {
    // Each template gets its own derived seed so adding a template does not
    // reshuffle the questions produced by the others.
    const seed = BASE_SEED + index * 7919;
    const produced = generate(template, perTemplate, seed);
    if (produced.length < perTemplate) {
      console.warn(
        `  note: ${template.idPrefix} produced ${produced.length}/${perTemplate} ` +
        `(its parameter space is small; this is fine, just fewer variants)`
      );
    }
    all.push(...produced);
    perTopic.set(template.topic, (perTopic.get(template.topic) || 0) + produced.length);
  });

  fs.writeFileSync(
    path.join(DATA_DIR, group.file),
    `${JSON.stringify(all, null, 2)}\n`,
    'utf8'
  );

  console.log(`\n${group.label}: ${all.length} generated -> data/${group.file}`);
  for (const [topic, n] of [...perTopic].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(4)}  ${topic}`);
  }
  grandTotal += all.length;
}

console.log(`\nGenerated ${grandTotal} questions total (seed ${BASE_SEED}).`);
console.log('Run "node scripts/verify-bank.js" to independently check every answer.\n');
