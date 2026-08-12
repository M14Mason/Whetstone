#!/usr/bin/env node
'use strict';

/**
 * Independent verification of the whole question bank.
 *
 * The generators compute their own answers, which protects against typos but
 * NOT against a bug in a generator. So this script re-derives the answer from
 * the prompt text using separately written logic. If a template had the formula
 * backwards, the generator and its own answer would agree with each other and
 * only an independent check catches it.
 *
 * Two layers:
 *   1. Structural checks on every question (ids, choices, indices, prose).
 *   2. Mathematical re-derivation for prompts this script knows how to parse,
 *      reported as a coverage percentage so the gap is visible rather than
 *      assumed away.
 *
 * Exit code 1 on any failure, so it can gate a commit or CI run.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const problems = [];
const warnings = [];

function fail(id, message) { problems.push(`${id}: ${message}`); }
function warn(id, message) { warnings.push(`${id}: ${message}`); }

/**
 * True when a string looks like it contains a JS value that leaked out of a
 * template, rather than the ordinary English word "undefined".
 *
 * Leaked:  "f(undefined)"  "x = undefined"  "undefined3"  "undefined"
 * Prose:   "the derivative is zero or undefined"
 *
 * NaN is never a normal English word here, so any occurrence is a failure.
 */
function leakedValue(text) {
  if (/\bNaN\b/.test(text)) return true;
  if (!text.includes('undefined')) return false;
  // The whole string is the leaked value.
  if (text.trim() === 'undefined') return true;
  // Sitting inside a value slot: after "=" or an opening bracket, or before a
  // closing bracket. Deliberately NOT triggered by a comma or a digit, because
  // ordinary prose does that: "a ratio of polynomials, undefined where the
  // denominator is zero".
  if (/[=({[]\s*undefined/.test(text)) return true;
  if (/undefined\s*[=)\]}]/.test(text)) return true;
  // Glued to another token with no space, e.g. "undefinedx" or "5undefined".
  if (/undefined[A-Za-z0-9]/.test(text)) return true;
  if (/[A-Za-z0-9]undefined/.test(text)) return true;
  return false;
}

// --------------------------------------------------------------------- load
const files = fs.readdirSync(DATA_DIR)
  .filter((f) => f.startsWith('questions.') && f.endsWith('.json'))
  .sort();

const all = [];
for (const file of files) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch (err) {
    fail(file, `invalid JSON: ${err.message}`);
    continue;
  }
  if (!Array.isArray(parsed)) { fail(file, 'top level must be an array'); continue; }
  parsed.forEach((q, i) => all.push({ ...q, __file: file, __index: i }));
}

// -------------------------------------------------------- structural checks
const ids = new Set();
const VALID_DIFFICULTY = new Set(['easy', 'medium', 'hard']);

for (const q of all) {
  const id = q.id || `${q.__file}[${q.__index}]`;

  if (!q.id) fail(id, 'missing id');
  if (ids.has(q.id)) fail(id, 'duplicate id');
  ids.add(q.id);

  for (const field of ['subject', 'topic', 'prompt', 'explanation']) {
    if (typeof q[field] !== 'string' || !q[field].trim()) fail(id, `missing ${field}`);
  }
  if (!VALID_DIFFICULTY.has(q.difficulty)) fail(id, `bad difficulty: ${q.difficulty}`);

  if (!Array.isArray(q.choices)) { fail(id, 'choices must be an array'); continue; }
  if (q.choices.length < 2) fail(id, 'needs at least 2 choices');
  if (new Set(q.choices).size !== q.choices.length) fail(id, 'duplicate choices');
  if (q.choices.some((c) => typeof c !== 'string' || !c.trim())) fail(id, 'blank choice');
  if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer >= q.choices.length) {
    fail(id, `answer index ${q.answer} out of range`);
  }
  if (typeof q.explanation === 'string' && q.explanation.trim().length < 15) {
    warn(id, 'explanation looks too short to teach anything');
  }
  // A leaked JS value is a broken template. But "undefined" is also an ordinary
  // English word in calculus ("the derivative is zero or undefined"), so a bare
  // substring test produces false failures. Only flag it where a *value* would
  // sit: next to an operator, a bracket, a digit, or glued to another token.
  if (typeof q.prompt === 'string' && leakedValue(q.prompt)) {
    fail(id, 'prompt contains a leaked "undefined" value');
  }
  if (typeof q.explanation === 'string' && leakedValue(q.explanation)) {
    fail(id, 'explanation contains a leaked "undefined" value');
  }
  if (q.choices.some((c) => leakedValue(String(c)))) {
    fail(id, 'choice contains a leaked undefined or NaN value');
  }
  // Fallback distractors used to append asterisks; if any survived, the
  // template's mistake models are colliding and need attention.
  if (q.choices.some((c) => String(c).includes('*'))) {
    fail(id, 'placeholder distractor leaked into choices');
  }
}

// ------------------------------------------------- independent re-derivation
const num = String.raw`(-?\d+(?:\.\d+)?)`;
let verified = 0;

/**
 * Compare the marked-correct choice against an independently computed value.
 *
 * Choices carry units ("20 N", "2 m/s^2", "$27", "10 g/cm^3"), so pull the
 * leading numeric token and compare numerically. Comparing stripped strings
 * breaks on unit separators: "2 m/s^2" naively strips to "2/2".
 */
function expect(q, expected, label) {
  const chosen = String(q.choices[q.answer]);
  const expectedNum = Number(expected);

  const match = chosen.match(/-?\d+(?:\.\d+)?/);
  const chosenNum = match ? Number(match[0]) : NaN;

  const ok = Number.isFinite(expectedNum) && Number.isFinite(chosenNum)
    ? Math.abs(chosenNum - expectedNum) < 1e-9
    : chosen === String(expected);

  if (ok) {
    verified++;
    return;
  }
  fail(q.id, `${label}: marked answer "${chosen}" but independent calculation gives ${expected}`);
}

function fmtNum(n) {
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 100) / 100);
}

const CHECKERS = [
  // Solve for x:  ax + b = c
  {
    re: new RegExp(String.raw`^Solve for x:\s+${num}x ([+-]) ${num} = ${num}$`),
    check(q, m) {
      const [, a, sign, b, c] = m;
      const bb = sign === '-' ? -Number(b) : Number(b);
      expect(q, fmtNum((Number(c) - bb) / Number(a)), 'linear solve');
    },
  },
  // Solve for x:  ax + b = cx + d
  {
    re: new RegExp(String.raw`^Solve for x:\s+${num}x ([+-]) ${num} = ${num}x ([+-]) ${num}$`),
    check(q, m) {
      const [, a, s1, b, c, s2, d] = m;
      const bb = s1 === '-' ? -Number(b) : Number(b);
      const dd = s2 === '-' ? -Number(d) : Number(d);
      expect(q, fmtNum((dd - bb) / (Number(a) - Number(c))), 'linear both sides');
    },
  },
  // Solve for x:  a(x + b) = rhs
  {
    re: new RegExp(String.raw`^Solve for x:\s+${num}\(x ([+-]) ${num}\) = ${num}$`),
    check(q, m) {
      const [, a, sign, b, rhs] = m;
      const bb = sign === '-' ? -Number(b) : Number(b);
      expect(q, fmtNum(Number(rhs) / Number(a) - bb), 'linear with parentheses');
    },
  },
  // What is the value of (b^m)^n?
  {
    re: new RegExp(String.raw`^What is the value of \(${num}\^${num}\)\^${num}\?$`),
    check(q, m) {
      const [, base, p, r] = m;
      expect(q, fmtNum(Math.pow(Number(base), Number(p) * Number(r))), 'power of a power');
    },
  },
  // Right triangle: legs a and b -> hypotenuse
  {
    re: new RegExp(String.raw`legs of length ${num} and ${num}`),
    check(q, m) {
      const [, a, b] = m;
      expect(q, fmtNum(Math.sqrt(Number(a) ** 2 + Number(b) ** 2)), 'pythagorean hypotenuse');
    },
  },
  // Right triangle: hypotenuse c and leg a -> other leg
  {
    re: new RegExp(String.raw`hypotenuse of ${num} and one leg of ${num}`),
    check(q, m) {
      const [, c, a] = m;
      expect(q, fmtNum(Math.sqrt(Number(c) ** 2 - Number(a) ** 2)), 'pythagorean leg');
    },
  },
  // Triangle area from base and height
  {
    re: new RegExp(String.raw`triangle with a base of ${num} and a height of ${num}`),
    check(q, m) {
      const [, b, h] = m;
      expect(q, fmtNum((Number(b) * Number(h)) / 2), 'triangle area');
    },
  },
  // Circle area from radius (answer formatted "N pi")
  {
    re: new RegExp(String.raw`^What is the area of a circle with radius ${num}\?$`),
    check(q, m) {
      const r = Number(m[1]);
      const chosen = String(q.choices[q.answer]);
      if (chosen === `${r * r} pi`) verified++;
      else fail(q.id, `circle area: marked "${chosen}" but expected "${r * r} pi"`);
    },
  },
  // F = ma
  {
    re: new RegExp(String.raw`^A ${num} kg object accelerates at ${num} m/s\^2`),
    check(q, m) {
      const [, mass, a] = m;
      expect(q, fmtNum(Number(mass) * Number(a)), 'F = ma');
    },
  },
  // a = F/m
  {
    re: new RegExp(String.raw`^A net force of ${num} N acts on a ${num} kg object`),
    check(q, m) {
      const [, f, mass] = m;
      expect(q, fmtNum(Number(f) / Number(mass)), 'a = F/m');
    },
  },
  // Kinetic energy
  {
    re: new RegExp(String.raw`kinetic energy of a ${num} kg object moving at ${num} m/s`),
    check(q, m) {
      const [, mass, v] = m;
      expect(q, fmtNum(0.5 * Number(mass) * Number(v) ** 2), 'kinetic energy');
    },
  },
  // Potential energy (g = 10)
  {
    re: new RegExp(String.raw`potential energy of a ${num} kg object at a height of ${num} m`),
    check(q, m) {
      const [, mass, h] = m;
      expect(q, fmtNum(Number(mass) * 10 * Number(h)), 'potential energy');
    },
  },
  // Wave speed v = f * lambda
  {
    re: new RegExp(String.raw`frequency of ${num} Hz and a wavelength of ${num} m`),
    check(q, m) {
      const [, f, lambda] = m;
      expect(q, fmtNum(Number(f) * Number(lambda)), 'wave speed');
    },
  },
  // Ohm's law V = IR
  {
    re: new RegExp(String.raw`current of ${num} A flows through a ${num} ohm resistor`),
    check(q, m) {
      const [, i, r] = m;
      expect(q, fmtNum(Number(i) * Number(r)), "Ohm's law voltage");
    },
  },
  // Moles from mass
  {
    re: new RegExp(String.raw`How many moles are in ${num} grams of .*molar mass ${num} g/mol`),
    check(q, m) {
      const [, mass, molar] = m;
      expect(q, fmtNum(Number(mass) / Number(molar)), 'moles from mass');
    },
  },
  // Mass from moles
  {
    re: new RegExp(String.raw`What is the mass of ${num} moles of .*molar mass ${num} g/mol`),
    check(q, m) {
      const [, moles, molar] = m;
      expect(q, fmtNum(Number(moles) * Number(molar)), 'mass from moles');
    },
  },
  // Density
  {
    re: new RegExp(String.raw`mass of ${num} g and a volume of ${num} cm\^3`),
    check(q, m) {
      const [, mass, vol] = m;
      expect(q, fmtNum(Number(mass) / Number(vol)), 'density');
    },
  },
  // Percent of a number
  {
    re: new RegExp(String.raw`^What is ${num}% of ${num}\?$`),
    check(q, m) {
      const [, pct, whole] = m;
      expect(q, fmtNum((Number(whole) * Number(pct)) / 100), 'percent of');
    },
  },
  // Mean of a set
  {
    re: /^What is the mean of the set \{([-\d,.\s]+)\}\?$/,
    check(q, m) {
      const values = m[1].split(',').map((s) => Number(s.trim()));
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      expect(q, fmtNum(mean), 'mean');
    },
  },
  // Median of a set
  {
    re: /^What is the median of the set \{([-\d,.\s]+)\}\?$/,
    check(q, m) {
      const values = m[1].split(',').map((s) => Number(s.trim())).sort((a, b) => a - b);
      const median = values.length % 2
        ? values[(values.length - 1) / 2]
        : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
      expect(q, fmtNum(median), 'median');
    },
  },
  // Range of a set
  {
    re: /^What is the range of the set \{([-\d,.\s]+)\}\?$/,
    check(q, m) {
      const values = m[1].split(',').map((s) => Number(s.trim()));
      expect(q, fmtNum(Math.max(...values) - Math.min(...values)), 'range');
    },
  },
  // Slope through two points
  {
    re: new RegExp(String.raw`slope of the line through \(${num}, ${num}\) and \(${num}, ${num}\)`),
    check(q, m) {
      const [, x1, y1, x2, y2] = m.map(Number);
      expect(q, fmtNum((y2 - y1) / (x2 - x1)), 'slope');
    },
  },
  // Distance between two points
  {
    re: new RegExp(String.raw`distance between \(${num}, ${num}\) and \(${num}, ${num}\)`),
    check(q, m) {
      const [, x1, y1, x2, y2] = m.map(Number);
      expect(q, fmtNum(Math.hypot(x2 - x1, y2 - y1)), 'distance');
    },
  },
  // Midpoint (answer is a coordinate pair)
  {
    re: new RegExp(String.raw`midpoint of the segment joining \(${num}, ${num}\) and \(${num}, ${num}\)`),
    check(q, m) {
      const [, x1, y1, x2, y2] = m.map(Number);
      const expected = `(${fmtNum((x1 + x2) / 2)}, ${fmtNum((y1 + y2) / 2)})`;
      const chosen = String(q.choices[q.answer]);
      if (chosen === expected) verified++;
      else fail(q.id, `midpoint: marked "${chosen}" but expected "${expected}"`);
    },
  },
  // Quadratic vertex
  {
    re: new RegExp(String.raw`vertex of the parabola y = x\^2 ([+-]) ${num}x ([+-]) ${num}`),
    check(q, m) {
      const [, s1, b, s2, c] = m;
      const bb = s1 === '-' ? -Number(b) : Number(b);
      const cc = s2 === '-' ? -Number(c) : Number(c);
      const h = -bb / 2;
      const k = h * h + bb * h + cc;
      const expected = `(${fmtNum(h)}, ${fmtNum(k)})`;
      const chosen = String(q.choices[q.answer]);
      if (chosen === expected) verified++;
      else fail(q.id, `vertex: marked "${chosen}" but expected "${expected}"`);
    },
  },
  // Number of real solutions (discriminant)
  {
    re: new RegExp(String.raw`How many real solutions does ${num}x\^2 ([+-]) ${num}x ([+-]) ${num} = 0 have`),
    check(q, m) {
      const [, a, s1, b, s2, c] = m;
      const bb = s1 === '-' ? -Number(b) : Number(b);
      const cc = s2 === '-' ? -Number(c) : Number(c);
      const disc = bb * bb - 4 * Number(a) * cc;
      const expected = disc > 0 ? 'Two' : disc === 0 ? 'Exactly one' : 'None';
      const chosen = String(q.choices[q.answer]);
      if (chosen === expected) verified++;
      else fail(q.id, `discriminant: marked "${chosen}" but expected "${expected}" (disc=${disc})`);
    },
  },
  // Quadratic roots
  {
    re: new RegExp(String.raw`solutions to x\^2 ([+-]) ${num}x ([+-]) ${num} = 0`),
    check(q, m) {
      const [, s1, b, s2, c] = m;
      const bb = s1 === '-' ? -Number(b) : Number(b);
      const cc = s2 === '-' ? -Number(c) : Number(c);
      const disc = bb * bb - 4 * cc;
      if (disc < 0) return fail(q.id, 'quadratic roots: no real roots but roots were given');
      const r1 = (-bb - Math.sqrt(disc)) / 2;
      const r2 = (-bb + Math.sqrt(disc)) / 2;
      const expected = `x = ${fmtNum(Math.min(r1, r2))} and x = ${fmtNum(Math.max(r1, r2))}`;
      const chosen = String(q.choices[q.answer]);
      if (chosen === expected) verified++;
      else fail(q.id, `quadratic roots: marked "${chosen}" but expected "${expected}"`);
    },
  },
  // Ratio partition, larger number
  {
    re: new RegExp(String.raw`ratio ${num}:${num} and add up to ${num}\. What is the larger number`),
    check(q, m) {
      const [, p, r, total] = m.map(Number);
      expect(q, fmtNum((total / (p + r)) * Math.max(p, r)), 'ratio partition');
    },
  },
  // Constant speed from distance and time
  {
    re: new RegExp(String.raw`travels ${num} m in ${num} s at a constant speed`),
    check(q, m) {
      const [, d, t] = m.map(Number);
      expect(q, fmtNum(d / t), 'speed');
    },
  },
  // Final velocity
  {
    re: new RegExp(String.raw`starts at ${num} m/s and accelerates at ${num} m/s\^2 for ${num} s`),
    check(q, m) {
      const [, vi, a, t] = m.map(Number);
      expect(q, fmtNum(vi + a * t), 'final velocity');
    },
  },
  // Half-life
  {
    re: new RegExp(String.raw`sample of ${num} g has a half-life of ${num} years.*after ${num} years`),
    check(q, m) {
      const [, initial, hl, elapsed] = m.map(Number);
      expect(q, fmtNum(initial / Math.pow(2, elapsed / hl)), 'half-life');
    },
  },
];

for (const q of all) {
  if (typeof q.prompt !== 'string' || !Array.isArray(q.choices)) continue;
  for (const checker of CHECKERS) {
    const m = q.prompt.match(checker.re);
    if (m) { checker.check(q, m); break; }
  }
}

// ------------------------------------------------------------------- report
const bySubject = new Map();
for (const q of all) {
  bySubject.set(q.subject, (bySubject.get(q.subject) || 0) + 1);
}
const byDifficulty = new Map();
for (const q of all) {
  byDifficulty.set(q.difficulty, (byDifficulty.get(q.difficulty) || 0) + 1);
}
const topics = new Set(all.map((q) => `${q.subject}/${q.topic}`));

console.log('\nWhetstone question bank verification\n');
console.log(`Files:      ${files.length}`);
console.log(`Questions:  ${all.length}`);
console.log(`Topics:     ${topics.size}`);
console.log('\nBy subject:');
for (const [subject, n] of [...bySubject].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${subject}`);
}
console.log('\nBy difficulty:');
for (const level of ['easy', 'medium', 'hard']) {
  const n = byDifficulty.get(level) || 0;
  console.log(`  ${String(n).padStart(4)}  ${level}  (${Math.round((n / all.length) * 100)}%)`);
}

/**
 * Thin topics are a real product problem, not a cosmetic one: the adaptive
 * engine keeps returning to a weak topic, and if that topic holds two questions
 * the student just sees the same two on repeat and memorises them.
 */
const TOPIC_MINIMUM = 5;
const topicCounts = new Map();
for (const q of all) {
  const key = `${q.subject}/${q.topic}`;
  topicCounts.set(key, (topicCounts.get(key) || 0) + 1);
}
const thin = [...topicCounts].filter(([, n]) => n < TOPIC_MINIMUM).sort((a, b) => a[1] - b[1]);
if (thin.length > 0) {
  console.log(`\nThin topics (fewer than ${TOPIC_MINIMUM} questions):`);
  for (const [topic, n] of thin) console.log(`  ${String(n).padStart(4)}  ${topic}`);
  console.log('  These will repeat quickly for a student the engine sends back to them.');
}

const pct = all.length === 0 ? 0 : Math.round((verified / all.length) * 100);
console.log(`\nIndependently recomputed: ${verified} of ${all.length} answers (${pct}%)`);
console.log('  The remainder are conceptual questions with no formula to recheck;');
console.log('  those rely on the structural checks above plus human review.');

if (warnings.length > 0) {
  console.log(`\n${warnings.length} warning(s):`);
  for (const w of warnings.slice(0, 15)) console.log(`  ${w}`);
  if (warnings.length > 15) console.log(`  ... and ${warnings.length - 15} more`);
}

if (problems.length > 0) {
  console.log(`\nFAILED with ${problems.length} problem(s):\n`);
  for (const p of problems.slice(0, 40)) console.log(`  ${p}`);
  if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
  console.log('');
  process.exit(1);
}

console.log('\nAll checks passed.\n');
