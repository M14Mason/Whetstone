'use strict';

const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.join(__dirname, '..', 'data');

// DATABASE_PATH lets you move the database off the project directory, which is
// required on hosts with a mounted volume, and on filesystems that cannot host
// SQLite at all (some network shares and container mounts).
const DEFAULT_DB_PATH = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(DATA_DIR, 'whetstone.db');

let db = null;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  email              TEXT NOT NULL UNIQUE,
  display_name       TEXT NOT NULL,
  password_hash      TEXT NOT NULL,
  plan               TEXT NOT NULL DEFAULT 'free',
  birth_year         INTEGER,
  stripe_customer_id TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE(email)
);

CREATE TABLE IF NOT EXISTS schema_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS questions (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  difficulty  TEXT NOT NULL,
  prompt      TEXT NOT NULL,
  choices     TEXT NOT NULL,
  answer      INTEGER NOT NULL,
  explanation TEXT NOT NULL,
  course_id   TEXT,
  unit        TEXT
);

CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject);
CREATE INDEX IF NOT EXISTS idx_questions_topic ON questions(topic);
CREATE INDEX IF NOT EXISTS idx_questions_course ON questions(course_id);
CREATE INDEX IF NOT EXISTS idx_questions_unit ON questions(course_id, unit);

-- Term/definition pairs powering Flashcards and the Match game.
CREATE TABLE IF NOT EXISTS cards (
  id         TEXT PRIMARY KEY,
  course_id  TEXT,
  unit       TEXT,
  subject    TEXT NOT NULL,
  front      TEXT NOT NULL,
  back       TEXT NOT NULL,
  difficulty TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_cards_unit ON cards(course_id, unit);

-- Courses a student has added to their plan during onboarding.
CREATE TABLE IF NOT EXISTS user_courses (
  user_id   INTEGER NOT NULL,
  course_id TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, course_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Results from Match and Practice Test sessions, for the dashboard.
CREATE TABLE IF NOT EXISTS mode_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL,
  mode         TEXT NOT NULL,
  course_id    TEXT,
  unit         TEXT,
  score        REAL,
  total        INTEGER,
  duration_ms  INTEGER,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_mode_sessions_user ON mode_sessions(user_id, mode);

-- Group chat. "channel" is 'general' or a course id, so a group automatically
-- gets a room for each class its members actually share.
CREATE TABLE IF NOT EXISTS group_messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  user_id    INTEGER NOT NULL,
  channel    TEXT NOT NULL DEFAULT 'general',
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_group_messages ON group_messages(group_id, channel, id);

-- Student-authored study sets.
CREATE TABLE IF NOT EXISTS custom_sets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  course_id  TEXT,
  shared     INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS custom_cards (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id   INTEGER NOT NULL,
  front    TEXT NOT NULL,
  back     TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (set_id) REFERENCES custom_sets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_custom_cards_set ON custom_cards(set_id, position);

-- Bug reports stored locally. No external service: scripts/export-bugs.js
-- dumps them to a file you can hand straight back for fixing.
CREATE TABLE IF NOT EXISTS bug_reports (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  page        TEXT,
  user_agent  TEXT,
  app_version TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, id);

CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  subject     TEXT NOT NULL,
  topic       TEXT NOT NULL,
  correct     INTEGER NOT NULL,
  chosen      INTEGER,
  -- Which study mode produced this attempt. Free allowances are metered per
  -- mode, so a Learn session must not consume the Review allowance.
  mode        TEXT NOT NULL DEFAULT 'learn',
  answered_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS user_badges (
  user_id   INTEGER NOT NULL,
  badge_id  TEXT NOT NULL,
  earned_at TEXT NOT NULL,
  PRIMARY KEY (user_id, badge_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id);
CREATE INDEX IF NOT EXISTS idx_attempts_user_time ON attempts(user_id, answered_at);
-- NOTE: the (user_id, mode, answered_at) index is created in addMissingColumns,
-- not here. On a database that predates the mode column, CREATE TABLE IF NOT
-- EXISTS leaves the old table untouched, so an index over that column in this
-- schema would fail with "no such column: mode" and the app would not start.

-- One row per (user, topic). This is the heart of the adaptive engine.
CREATE TABLE IF NOT EXISTS topic_state (
  user_id        INTEGER NOT NULL,
  topic          TEXT NOT NULL,
  subject        TEXT NOT NULL,
  ability        REAL NOT NULL,
  attempts       INTEGER NOT NULL DEFAULT 0,
  correct        INTEGER NOT NULL DEFAULT 0,
  ewma_correct   REAL NOT NULL DEFAULT 0.5,
  streak         INTEGER NOT NULL DEFAULT 0,
  interval_index INTEGER NOT NULL DEFAULT 0,
  due_at         TEXT NOT NULL,
  last_seen_at   TEXT,
  PRIMARY KEY (user_id, topic),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS study_groups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  invite_code   TEXT NOT NULL UNIQUE,
  owner_id      INTEGER NOT NULL,
  seats_paid    INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS group_members (
  group_id  INTEGER NOT NULL,
  user_id   INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES study_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Single-use tokens for password reset and email verification.
-- Only a HASH of the token is stored: if the database leaks, the raw tokens
-- in it must not be usable to take over accounts.
CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  purpose    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_user ON auth_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS user_subjects (
  user_id INTEGER NOT NULL,
  subject TEXT NOT NULL,
  PRIMARY KEY (user_id, subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
`;

/**
 * Additive migrations, applied in order and recorded so they run once.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
 * new columns need explicit ALTERs or an existing database silently keeps the
 * old shape and the app breaks in confusing ways.
 */
const MIGRATIONS = [
  {
    id: '001-user-timezone-and-pending-question',
    up(handle) {
      const columns = handle.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      const add = (name, definition) => {
        if (!columns.includes(name)) {
          handle.exec(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        }
      };
      // Free-tier quota resets at the student's local midnight, not UTC.
      add('timezone_offset_minutes', 'INTEGER NOT NULL DEFAULT 0');
      // The question currently served to this user, so answers can be pinned
      // to what was actually issued.
      add('pending_question_id', 'TEXT');
      add('pending_issued_at', 'TEXT');
    },
  },
  {
    id: '002-email-verification',
    up(handle) {
      const columns = handle.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      if (!columns.includes('email_verified_at')) {
        handle.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT');
      }
    },
  },
  {
    id: '003-courses-and-onboarding',
    up(handle) {
      const qCols = handle.prepare('PRAGMA table_info(questions)').all().map((c) => c.name);
      if (!qCols.includes('course_id')) handle.exec('ALTER TABLE questions ADD COLUMN course_id TEXT');
      if (!qCols.includes('unit')) handle.exec('ALTER TABLE questions ADD COLUMN unit TEXT');

      const uCols = handle.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      // Grade level drives which courses are suggested during onboarding.
      if (!uCols.includes('grade_level')) handle.exec('ALTER TABLE users ADD COLUMN grade_level INTEGER');
      if (!uCols.includes('onboarded_at')) handle.exec('ALTER TABLE users ADD COLUMN onboarded_at TEXT');
      if (!uCols.includes('goal')) handle.exec('ALTER TABLE users ADD COLUMN goal TEXT');
    },
  },
  {
    id: '004-tos-acceptance',
    up(handle) {
      const cols = handle.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
      // Recording WHICH version was accepted matters: if the terms change you
      // need to know who agreed to what, and who must be re-prompted.
      if (!cols.includes('tos_accepted_at')) handle.exec('ALTER TABLE users ADD COLUMN tos_accepted_at TEXT');
      if (!cols.includes('tos_version')) handle.exec('ALTER TABLE users ADD COLUMN tos_version TEXT');
    },
  },
];

function runMigrations(handle) {
  handle.exec(`CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY, value TEXT NOT NULL
  );`);
  const applied = new Set(
    handle.prepare("SELECT key FROM schema_meta WHERE key LIKE 'migration:%'")
      .all().map((r) => r.key.slice('migration:'.length))
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    migration.up(handle);
    handle.prepare('INSERT INTO schema_meta (key, value) VALUES (?, ?)')
      .run(`migration:${migration.id}`, new Date().toISOString());
  }
}

/**
 * Open the database and apply the schema using a given journal mode.
 * Setting the pragma itself rarely fails; the failure shows up on the first
 * real write, which is why the schema is applied inside the same attempt.
 */
function tryOpen(dbPath, journalMode) {
  const handle = new DatabaseSync(dbPath);
  try {
    if (dbPath !== ':memory:' && journalMode) {
      handle.exec(`PRAGMA journal_mode = ${journalMode};`);
    }
    handle.exec(SCHEMA);
    runMigrations(handle);
    // Databases created before per-mode quotas lack attempts.mode.
    addMissingColumns(handle);
    return handle;
  } catch (err) {
    try { handle.close(); } catch { /* already closed */ }
    throw err;
  }
}


/* Add columns that older databases predate.
 *
 * ALTER TABLE ... ADD COLUMN is the only safe in-place option in SQLite, and it
 * throws if the column already exists, so each is guarded by a lookup rather
 * than a try/catch that could swallow a real error. */
function addMissingColumns(db) {
  const has = (table, column) => db.prepare(`PRAGMA table_info(${table})`).all()
    .some((c) => c.name === column);

  if (!has('attempts', 'mode')) {
    db.exec("ALTER TABLE attempts ADD COLUMN mode TEXT NOT NULL DEFAULT 'learn'");
  }

  // Progression: XP, streak counters and the preset avatar.
  if (!has('users', 'xp')) db.exec('ALTER TABLE users ADD COLUMN xp INTEGER NOT NULL DEFAULT 0');
  if (!has('users', 'streak_current')) db.exec('ALTER TABLE users ADD COLUMN streak_current INTEGER NOT NULL DEFAULT 0');
  if (!has('users', 'streak_best')) db.exec('ALTER TABLE users ADD COLUMN streak_best INTEGER NOT NULL DEFAULT 0');
  if (!has('users', 'streak_last_day')) db.exec('ALTER TABLE users ADD COLUMN streak_last_day TEXT');
  if (!has('users', 'avatar')) db.exec("ALTER TABLE users ADD COLUMN avatar TEXT NOT NULL DEFAULT 'flame'");
  if (!has('users', 'course_order')) db.exec('ALTER TABLE users ADD COLUMN course_order TEXT');

  // Safe now that the column is guaranteed to exist, on both new and old
  // databases.
  db.exec('CREATE INDEX IF NOT EXISTS idx_attempts_user_mode_time ON attempts(user_id, mode, answered_at)');
}

function init(dbPath = DEFAULT_DB_PATH) {
  if (db) return db;
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  // WAL is faster and allows concurrent reads, but it needs shared-memory
  // support that network drives, some Docker volumes, and synced folders
  // (Dropbox, OneDrive, iCloud) do not provide. Fall back to the classic
  // rollback journal rather than refusing to start.
  try {
    db = tryOpen(dbPath, 'WAL');
  } catch (walError) {
    try {
      db = tryOpen(dbPath, 'DELETE');
      if (process.env.NODE_ENV !== 'test') {
        console.warn('  Note: WAL journaling unavailable on this filesystem, using rollback journal.');
      }
    } catch {
      throw walError;
    }
  }
  return db;
}

function getDb() {
  if (!db) return init();
  return db;
}

function close() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { init, getDb, close, DEFAULT_DB_PATH, DATA_DIR };
