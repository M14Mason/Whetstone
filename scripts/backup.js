#!/usr/bin/env node
'use strict';

/**
 * Database backup.
 *
 *   node scripts/backup.js [--out DIR] [--keep N]
 *
 * Uses SQLite's VACUUM INTO, which produces a consistent snapshot of a live
 * database. Copying the .db file with `cp` while the server is writing can
 * capture a torn page and give you a backup that will not open, which is the
 * worst kind of backup: one you think you have.
 *
 * Old backups are pruned so the disk does not fill silently.
 */

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const args = process.argv.slice(2);
function flag(name, fallback) {
  const i = args.indexOf(name);
  return i === -1 || i === args.length - 1 ? fallback : args[i + 1];
}

const DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', 'data', 'whetstone.db');

const OUT_DIR = path.resolve(flag('--out', process.env.BACKUP_DIR || path.join(__dirname, '..', 'backups')));
const KEEP = Number(flag('--keep', process.env.BACKUP_KEEP || 14));

if (!fs.existsSync(DB_PATH)) {
  console.error(`No database found at ${DB_PATH}`);
  console.error('Set DATABASE_PATH or start the app once to create it.');
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const target = path.join(OUT_DIR, `whetstone-${stamp}.db`);

let db;
try {
  db = new DatabaseSync(DB_PATH);
  // VACUUM INTO takes a consistent snapshot even while the app is running.
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
} finally {
  if (db) { try { db.close(); } catch { /* already closed */ } }
}

// Verify the snapshot actually opens and holds data. An unverified backup is
// only a guess.
try {
  const check = new DatabaseSync(target);
  const integrity = check.prepare('PRAGMA integrity_check').get();
  const counts = {
    users: check.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    questions: check.prepare('SELECT COUNT(*) AS n FROM questions').get().n,
    attempts: check.prepare('SELECT COUNT(*) AS n FROM attempts').get().n,
  };
  check.close();

  const result = integrity.integrity_check || Object.values(integrity)[0];
  if (result !== 'ok') throw new Error(`integrity_check returned "${result}"`);

  const sizeKb = Math.round(fs.statSync(target).size / 1024);
  console.log(`Backup written: ${target} (${sizeKb} KB)`);
  console.log(`  integrity: ok`);
  console.log(`  users: ${counts.users}, questions: ${counts.questions}, attempts: ${counts.attempts}`);
} catch (err) {
  console.error(`Backup verification FAILED: ${err.message}`);
  console.error('The snapshot was written but could not be validated. Do not rely on it.');
  process.exit(1);
}

// ------------------------------------------------------------------ pruning
const backups = fs.readdirSync(OUT_DIR)
  .filter((f) => /^whetstone-.*\.db$/.test(f))
  .sort()
  .reverse();

if (Number.isFinite(KEEP) && KEEP > 0 && backups.length > KEEP) {
  const stale = backups.slice(KEEP);
  for (const file of stale) {
    fs.unlinkSync(path.join(OUT_DIR, file));
  }
  console.log(`  pruned ${stale.length} old backup(s), keeping the newest ${KEEP}`);
}

console.log(`  total backups on disk: ${Math.min(backups.length, KEEP)}`);
