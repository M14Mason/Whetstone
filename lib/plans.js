'use strict';

const { getDb } = require('./db');
const { config } = require('./config');

/**
 * A user's effective plan is the best of:
 *   - their own subscription, or
 *   - membership in an active (fully paid) study group.
 *
 * That means one person paying for a group upgrades everyone in it, which is
 * the entire point of the group tier.
 */
function effectivePlan(userId) {
  const db = getDb();
  const user = db.prepare('SELECT plan FROM users WHERE id = ?').get(userId);
  if (!user) return config.plans.free;

  if (user.plan === 'premium') return config.plans.premium;

  // An explicitly-set group plan counts on its own. Without this, setting
  // users.plan = 'group' fell straight through to free unless the user also
  // happened to belong to an active group -- so the tester plan switcher
  // appeared to do nothing at all when you picked Study Group.
  if (user.plan === 'group') return config.plans.group;

  const activeGroup = db.prepare(`
    SELECT g.id FROM study_groups g
    JOIN group_members m ON m.group_id = g.id
    WHERE m.user_id = ? AND g.active = 1
    LIMIT 1
  `).get(userId);

  if (activeGroup) return config.plans.group;
  return config.plans.free;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Start of the user's LOCAL day, expressed as a UTC instant.
 *
 * offsetMinutes matches JavaScript's Date.getTimezoneOffset(): minutes to add
 * to local time to reach UTC. New York in winter is 300.
 *
 * Using UTC midnight here would reset a US student's free questions at around
 * 7 or 8pm their time, in the middle of a study session, which reads as a bug
 * to them even though the count is technically correct.
 */
function startOfLocalDay(now = new Date(), offsetMinutes = 0) {
  const offsetMs = offsetMinutes * 60_000;
  const localMs = now.getTime() - offsetMs;
  const localMidnight = Math.floor(localMs / DAY_MS) * DAY_MS;
  return new Date(localMidnight + offsetMs);
}

function userOffsetMinutes(userId) {
  const row = getDb().prepare('SELECT timezone_offset_minutes FROM users WHERE id = ?').get(userId);
  const value = row ? Number(row.timezone_offset_minutes) : 0;
  return Number.isFinite(value) ? value : 0;
}

/* Attempts today in ONE mode. Free allowances are metered per mode so a Learn
 * session does not silently consume the Review allowance. */
function answeredTodayInMode(userId, mode, now = new Date()) {
  const since = startOfLocalDay(now, userOffsetMinutes(userId)).toISOString();
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND mode = ? AND answered_at >= ?')
    .get(userId, mode, since);
  return row ? row.n : 0;
}

/**
 * Quota for a specific mode.
 *
 * Paid plans are unlimited everywhere. Free plans get a small separate
 * allowance per mode, from config.freeDailyLimits. A mode with no entry there
 * is either free-unlimited or gated by premiumModes; it is not metered here.
 */
function checkModeQuota(userId, mode, now = new Date()) {
  const plan = effectivePlan(userId);
  const limit = plan.dailyQuestionLimit === Infinity
    ? Infinity
    : (config.freeDailyLimits[mode] ?? plan.dailyQuestionLimit);
  const unlimited = limit === Infinity;
  const used = unlimited ? answeredTodayInMode(userId, mode, now) : answeredTodayInMode(userId, mode, now);

  return {
    mode,
    plan: plan.id,
    planLabel: plan.label,
    used,
    limit: unlimited ? null : limit,
    remaining: unlimited ? null : Math.max(0, limit - used),
    exhausted: !unlimited && used >= limit,
    maxSubjects: plan.maxSubjects === Infinity ? null : plan.maxSubjects,
  };
}

function questionsAnsweredToday(userId, now = new Date()) {
  const since = startOfLocalDay(now, userOffsetMinutes(userId)).toISOString();
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND answered_at >= ?')
    .get(userId, since);
  return row ? row.n : 0;
}

/**
 * Free tier: 5 questions a day, one subject at a time.
 * Paid tiers: unlimited.
 */
function checkQuota(userId, now = new Date()) {
  const plan = effectivePlan(userId);
  const used = questionsAnsweredToday(userId, now);
  const limit = plan.dailyQuestionLimit;
  const unlimited = limit === Infinity;

  return {
    plan: plan.id,
    planLabel: plan.label,
    used,
    limit: unlimited ? null : limit,
    remaining: unlimited ? null : Math.max(0, limit - used),
    exhausted: !unlimited && used >= limit,
    maxSubjects: plan.maxSubjects === Infinity ? null : plan.maxSubjects,
  };
}

function allSubjects() {
  return getDb().prepare('SELECT DISTINCT subject FROM questions ORDER BY subject').all()
    .map((r) => r.subject);
}

/**
 * Which subjects should the engine draw from for this user?
 * Free users are capped at their chosen subject; paid users get everything.
 */
function activeSubjectsFor(userId) {
  const db = getDb();
  const plan = effectivePlan(userId);
  const available = allSubjects();
  if (available.length === 0) return [];

  const chosen = db.prepare('SELECT subject FROM user_subjects WHERE user_id = ?')
    .all(userId).map((r) => r.subject)
    .filter((s) => available.includes(s));

  if (plan.maxSubjects === Infinity) {
    return chosen.length > 0 ? chosen : available;
  }
  if (chosen.length > 0) return chosen.slice(0, plan.maxSubjects);
  return [available[0]];
}

function setUserSubjects(userId, subjects) {
  const db = getDb();
  const plan = effectivePlan(userId);
  const available = allSubjects();
  const valid = (subjects || []).filter((s) => available.includes(s));

  if (valid.length === 0) {
    throw Object.assign(new Error('Pick at least one subject.'), { statusCode: 400 });
  }
  if (plan.maxSubjects !== Infinity && valid.length > plan.maxSubjects) {
    throw Object.assign(
      new Error(`The Free plan covers ${plan.maxSubjects} subject at a time. Upgrade to study everything at once.`),
      { statusCode: 402 }
    );
  }

  db.prepare('DELETE FROM user_subjects WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_subjects (user_id, subject) VALUES (?, ?)');
  for (const s of valid) insert.run(userId, s);
  return valid;
}

// ---------------------------------------------------------------- courses
const courses = require('./courses');

function userCourses(userId) {
  const rows = getDb()
    .prepare('SELECT course_id FROM user_courses WHERE user_id = ? ORDER BY added_at')
    .all(userId);
  return rows.map((r) => courses.getCourse(r.course_id)).filter(Boolean);
}

function setUserCourses(userId, courseIds) {
  const db = getDb();
  const valid = (courseIds || []).filter((id) => courses.getCourse(id));
  db.prepare('DELETE FROM user_courses WHERE user_id = ?').run(userId);
  const insert = db.prepare('INSERT INTO user_courses (user_id, course_id, added_at) VALUES (?, ?, ?)');
  const now = new Date().toISOString();
  for (const id of valid) insert.run(userId, id, now);
  return valid;
}

/**
 * Per-unit content coverage for a course.
 *
 * Reported honestly: a unit with zero questions says zero. A student who taps an
 * empty unit expecting practice and finds nothing does not come back, so it is
 * better to show the gap than to hide it.
 */
/**
 * Work out which questions a student should actually be served.
 *
 * This exists because Learn used to ignore both the courses a student enrolled
 * in and the unit they had selected, falling back to "any subject in the
 * database". A student who picked Biology got Big-O complexity questions, which
 * reads as the app being broken.
 *
 * Priority: an explicit unit, then an explicit course, then everything in the
 * courses they enrolled in, and only then a subject-level fallback for accounts
 * that have no courses at all.
 */
function learningScope(userId, requested = {}) {
  if (requested.courseId && requested.unit) {
    return { kind: 'unit', courseId: requested.courseId, unit: requested.unit };
  }
  if (requested.courseId) {
    return { kind: 'course', courseIds: [requested.courseId] };
  }

  const enrolled = userCourses(userId).map((c) => c.id);
  if (enrolled.length > 0) {
    // Only count courses that actually have questions, otherwise a student
    // whose courses are all unauthored gets an empty screen instead of practice.
    const db = getDb();
    // Resolve through bankFor: an honors course has no rows under its own id,
    // so checking it directly reported "no content" and dropped the student
    // into a subject-wide scope that served unrelated courses.
    const banks = [...new Set(enrolled.map(courses.bankFor))];
    const placeholders = banks.map(() => '?').join(',');
    const stocked = new Set(db.prepare(
      `SELECT DISTINCT course_id FROM questions WHERE course_id IN (${placeholders})`
    ).all(...banks).map((r) => r.course_id));

    // Keep the ORIGINAL ids so the adaptive engine still knows this is honors
    // and can bias away from the easy tier.
    const withContent = enrolled.filter((id) => stocked.has(courses.bankFor(id)));
    if (withContent.length > 0) return { kind: 'courses', courseIds: withContent };
  }

  return { kind: 'subjects', subjects: activeSubjectsFor(userId) };
}

function courseCoverage(courseId) {
  const course = courses.getCourse(courseId);
  if (!course) return null;
  const db = getDb();

  // Honors courses share the regular course's bank, so coverage is counted
  // against that bank rather than the honors id (which has no rows).
  const bank = courses.bankFor(courseId);
  const qRows = db.prepare(
    'SELECT unit, COUNT(*) AS n FROM questions WHERE course_id = ? GROUP BY unit'
  ).all(bank);
  const cRows = db.prepare(
    'SELECT unit, COUNT(*) AS n FROM cards WHERE course_id = ? GROUP BY unit'
  ).all(bank);

  const qByUnit = new Map(qRows.map((r) => [r.unit, r.n]));
  const cByUnit = new Map(cRows.map((r) => [r.unit, r.n]));

  const units = course.units.map((u) => ({
    id: u.id,
    name: u.name,
    order: u.order,
    questions: qByUnit.get(u.name) || 0,
    cards: cByUnit.get(u.name) || 0,
  }));

  const withContent = units.filter((u) => u.questions > 0).length;
  return {
    course: {
      id: course.id, name: course.name, level: course.level,
      levelLabel: course.levelLabel, category: course.category,
    },
    units,
    totals: {
      units: units.length,
      unitsWithContent: withContent,
      questions: units.reduce((s, u) => s + u.questions, 0),
      cards: units.reduce((s, u) => s + u.cards, 0),
      coveragePercent: units.length === 0 ? 0 : Math.round((withContent / units.length) * 100),
    },
  };
}

module.exports = {
  checkModeQuota,
  answeredTodayInMode,
  effectivePlan,
  checkQuota,
  userCourses,
  setUserCourses,
  learningScope,
  courseCoverage,
  questionsAnsweredToday,
  activeSubjectsFor,
  setUserSubjects,
  allSubjects,
  startOfLocalDay,
  userOffsetMinutes,
};
