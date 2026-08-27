#!/usr/bin/env node
'use strict';

/**
 * Delete test accounts and everything attached to them.
 *
 *   node scripts/purge-test-accounts.js            # dry run, shows what WOULD go
 *   node scripts/purge-test-accounts.js --confirm  # actually deletes
 *
 * Dry run is the default on purpose: this deletes user rows and cascades to
 * their attempts, topic states, badges and group memberships. Read the list
 * before you pass --confirm.
 *
 * Matches @example.com and @test.com addresses. Real users will not be on
 * either -- example.com is reserved by RFC 2606 precisely so it can never be
 * a live domain.
 */

const { init, getDb } = require('../lib/db');

const confirm = process.argv.includes('--confirm');
const PATTERNS = ['%@example.com', '%@test.com'];

init(process.env.DATABASE_PATH || undefined);
const db = getDb();

const where = PATTERNS.map(() => 'email LIKE ?').join(' OR ');
const doomed = db.prepare(`SELECT id, email, display_name, created_at FROM users WHERE ${where}`)
  .all(...PATTERNS);

if (doomed.length === 0) {
  console.log('\n  No test accounts found. Nothing to do.\n');
  process.exit(0);
}

console.log(`\n  ${doomed.length} test account(s):\n`);
for (const u of doomed) {
  const attempts = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ?').get(u.id).n;
  console.log(`    #${u.id}  ${u.email}  (${u.display_name || 'no name'}, ${attempts} attempts)`);
}

const real = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE NOT (${where})`).get(...PATTERNS).n;
console.log(`\n  Real accounts that will NOT be touched: ${real}`);

if (!confirm) {
  console.log('\n  DRY RUN. Nothing deleted.');
  console.log('  Re-run with --confirm to delete these.\n');
  process.exit(0);
}

// Foreign keys cascade from users, but delete explicitly so the counts are
// visible rather than assumed.
const ids = doomed.map((u) => u.id);
const ph = ids.map(() => '?').join(',');
let removed = 0;
for (const table of ['attempts', 'topic_state', 'user_badges', 'user_courses', 'group_members', 'bug_reports']) {
  try {
    const n = db.prepare(`DELETE FROM ${table} WHERE user_id IN (${ph})`).run(...ids).changes;
    if (n) { console.log(`    ${table}: ${n} row(s)`); removed += n; }
  } catch { /* table may not exist in older schemas */ }
}
const users = db.prepare(`DELETE FROM users WHERE id IN (${ph})`).run(...ids).changes;
console.log(`\n  Deleted ${users} account(s) and ${removed} related row(s).\n`);
