#!/usr/bin/env node
'use strict';

/**
 * Dump bug reports to a file you can hand straight back for fixing.
 *
 *   node scripts/export-bugs.js              # open reports
 *   node scripts/export-bugs.js --all        # every report
 *   node scripts/export-bugs.js --fix 3      # mark report 3 as fixed
 *
 * No external service is involved. Reports live in your own database, this
 * writes them to bug-reports.md, and you paste that back to get them fixed.
 */

const fs = require('node:fs');
const path = require('node:path');

const { init } = require('../lib/db');
const social = require('../lib/social');

init();

const args = process.argv.slice(2);

const fixIndex = args.indexOf('--fix');
if (fixIndex !== -1 && args[fixIndex + 1]) {
  const id = Number(args[fixIndex + 1]);
  social.setBugStatus(id, 'fixed');
  console.log(`Report #${id} marked fixed.`);
  process.exit(0);
}

const showAll = args.includes('--all');
const bugs = social.listBugs({ status: showAll ? null : 'open' });

if (bugs.length === 0) {
  console.log(showAll ? 'No bug reports yet.' : 'No open bug reports.');
  process.exit(0);
}

const lines = [
  `# Whetstone bug reports`,
  '',
  `Exported ${new Date().toISOString()}`,
  `${bugs.length} ${showAll ? 'total' : 'open'} report(s)`,
  '',
  '---',
  '',
];

for (const b of bugs) {
  lines.push(`## #${b.id} — ${b.title}`);
  lines.push('');
  lines.push(`- **Status:** ${b.status}`);
  lines.push(`- **Filed:** ${b.createdAt}`);
  if (b.page) lines.push(`- **Page:** ${b.page}`);
  if (b.appVersion) lines.push(`- **App version:** ${b.appVersion}`);
  if (b.userAgent) lines.push(`- **Browser:** ${b.userAgent}`);
  lines.push('');
  lines.push(b.body);
  lines.push('');
  lines.push('---');
  lines.push('');
}

const out = path.join(__dirname, '..', 'bug-reports.md');
fs.writeFileSync(out, lines.join('\n'));

console.log(`\nWrote ${bugs.length} report(s) to ${out}\n`);
for (const b of bugs) console.log(`  #${b.id} [${b.status}] ${b.title}`);
console.log('\nHand that file over to get these fixed.\n');
