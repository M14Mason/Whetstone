
'use strict';

/**
 * XP, levels, badges and streaks.
 *
 * Two design rules shape this file, and both are deliberate.
 *
 * 1. A STREAK MUST SURVIVE ON THE FREE PLAN. One correct-or-not answer a day
 *    keeps it alive, and the free plan allows three. A streak you can only
 *    maintain by paying is not a habit loop, it is a hostage situation, and
 *    aiming that at teenagers is how an app ends up in a news story.
 *
 * 2. LEVELS ARE COSMETIC. They appear on the profile and nowhere else. Using
 *    them to unlock features would collide with the paid tier: a student who
 *    has paid should never be told to grind for something they bought.
 */

const { getDb } = require('./db');

// XP per correct answer, weighted by difficulty. Wrong answers earn nothing,
// but they cost nothing either -- penalising them would teach students to
// avoid hard questions, which is the opposite of the point.
const XP_BY_DIFFICULTY = { easy: 4, medium: 7, hard: 12 };

/* Level curve.
 *
 * Level 2 lands at 60 XP, roughly ten medium questions, because the first
 * level-up has to arrive inside the first session or it may as well not exist.
 * After that the curve steepens quadratically so later levels stay meaningful
 * without becoming unreachable. */
function xpForLevel(level) {
  if (level <= 1) return 0;
  return Math.round(60 * ((level - 1) ** 1.55));
}

function levelFromXp(xp) {
  let level = 1;
  while (level < 100 && xp >= xpForLevel(level + 1)) level += 1;
  const floor = xpForLevel(level);
  const ceiling = xpForLevel(level + 1);
  const span = Math.max(1, ceiling - floor);
  return {
    level,
    xp,
    intoLevel: xp - floor,
    neededForNext: ceiling - xp,
    levelSpan: span,
    percent: Math.min(100, Math.round(((xp - floor) / span) * 100)),
  };
}

function xpForAnswer(difficulty, isCorrect) {
  if (!isCorrect) return 0;
  return XP_BY_DIFFICULTY[String(difficulty || 'medium').toLowerCase()] ?? 7;
}

// ---------------------------------------------------------------- streaks

/** Local calendar day for this user, as YYYY-MM-DD. */
function localDayKey(offsetMinutes = 0, now = new Date()) {
  const shifted = new Date(now.getTime() - offsetMinutes * 60_000);
  return shifted.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/**
 * Record activity for today and return the streak.
 *
 * Any answered question counts, right or wrong. Rewarding only correct answers
 * would push a nervous student toward easy questions purely to protect a
 * number.
 */
function touchStreak(userId, offsetMinutes = 0, now = new Date()) {
  const db = getDb();
  const today = localDayKey(offsetMinutes, now);
  const row = db.prepare('SELECT streak_current, streak_best, streak_last_day FROM users WHERE id = ?').get(userId);
  if (!row) return { current: 0, best: 0, changed: false };

  const last = row.streak_last_day;
  let current = row.streak_current || 0;
  let broke = false;

  if (last === today) {
    return { current, best: row.streak_best || current, changed: false, broke: false };
  }
  if (!last) current = 1;
  else {
    const gap = daysBetween(last, today);
    if (gap === 1) current += 1;
    else if (gap > 1) { broke = current > 1; current = 1; }
    else return { current, best: row.streak_best || current, changed: false, broke: false };
  }

  const best = Math.max(row.streak_best || 0, current);
  db.prepare('UPDATE users SET streak_current = ?, streak_best = ?, streak_last_day = ? WHERE id = ?')
    .run(current, best, today, userId);
  return { current, best, changed: true, broke };
}

/** Read the streak without recording activity, decaying a stale one. */
function readStreak(userId, offsetMinutes = 0, now = new Date()) {
  const db = getDb();
  const row = db.prepare('SELECT streak_current, streak_best, streak_last_day FROM users WHERE id = ?').get(userId);
  if (!row) return { current: 0, best: 0, atRisk: false };

  const today = localDayKey(offsetMinutes, now);
  const last = row.streak_last_day;
  if (!last) return { current: 0, best: row.streak_best || 0, atRisk: false };

  const gap = daysBetween(last, today);
  // Missed a whole day: the streak is gone, but we report it rather than
  // silently zeroing, so the UI can say so once instead of pretending.
  if (gap > 1) return { current: 0, best: row.streak_best || 0, atRisk: false, lapsed: true };
  return {
    current: row.streak_current || 0,
    best: row.streak_best || 0,
    // Answered yesterday but not yet today.
    atRisk: gap === 1,
  };
}

// ----------------------------------------------------------------- badges

const BADGES = [
  {
    id: 'first-unit',
    name: 'First unit down',
    description: 'Master every topic in a single unit.',
    icon: '◆',
  },
  {
    id: 'perfect-test',
    name: 'Clean sheet',
    description: 'Score 100% on a full practice test.',
    icon: '✎',
  },
  {
    id: 'four-point-oh',
    name: '4.0',
    description: '90% or better in every course you are taking, with at least 25 questions answered in each.',
    icon: '★',
  },
  { id: 'streak-7', name: 'One week', description: 'Study seven days in a row.', icon: '◈' },
  { id: 'streak-30', name: 'One month', description: 'Study thirty days in a row.', icon: '❖' },
  { id: 'century', name: 'Century', description: 'Answer 100 questions correctly.', icon: '◉' },
];

function allBadges() { return BADGES; }

function earnedBadges(userId) {
  return getDb().prepare('SELECT badge_id, earned_at FROM user_badges WHERE user_id = ?').all(userId);
}

function awardBadge(userId, badgeId, now = new Date()) {
  if (!BADGES.some((b) => b.id === badgeId)) return false;
  const res = getDb().prepare(
    'INSERT OR IGNORE INTO user_badges (user_id, badge_id, earned_at) VALUES (?, ?, ?)'
  ).run(userId, badgeId, now.toISOString());
  return res.changes > 0;   // true only the first time, so the UI can celebrate once
}

/**
 * Re-evaluate every badge for a user. Returns the ones newly earned.
 *
 * Cheap enough to run after each answer: all of it is indexed count queries
 * over one user's rows.
 */
function checkBadges(userId, context = {}) {
  const db = getDb();
  const newly = [];

  const correct = db.prepare('SELECT COUNT(*) AS n FROM attempts WHERE user_id = ? AND correct = 1').get(userId).n;
  if (correct >= 100 && awardBadge(userId, 'century')) newly.push('century');

  const streak = readStreak(userId, context.offsetMinutes || 0);
  if (streak.current >= 7 && awardBadge(userId, 'streak-7')) newly.push('streak-7');
  if (streak.current >= 30 && awardBadge(userId, 'streak-30')) newly.push('streak-30');

  if (context.perfectTest && awardBadge(userId, 'perfect-test')) newly.push('perfect-test');
  if (context.unitMastered && awardBadge(userId, 'first-unit')) newly.push('first-unit');

  // 4.0: at least 25 answers AND 90%+ accuracy in every enrolled course.
  const courses = db.prepare('SELECT course_id FROM user_courses WHERE user_id = ?').all(userId);
  if (courses.length > 0) {
    let qualifies = true;
    for (const { course_id: courseId } of courses) {
      const row = db.prepare(`
        SELECT COUNT(*) AS n, SUM(a.correct) AS c
        FROM attempts a JOIN questions q ON q.id = a.question_id
        WHERE a.user_id = ? AND q.course_id = ?
      `).get(userId, courseId);
      const n = row.n || 0;
      const acc = n ? (row.c || 0) / n : 0;
      if (n < 25 || acc < 0.9) { qualifies = false; break; }
    }
    if (qualifies && awardBadge(userId, 'four-point-oh')) newly.push('four-point-oh');
  }

  return newly.map((id) => BADGES.find((b) => b.id === id));
}

// ------------------------------------------------------------------ totals

function addXp(userId, amount) {
  if (!amount) return;
  getDb().prepare('UPDATE users SET xp = COALESCE(xp, 0) + ? WHERE id = ?').run(amount, userId);
}

function profileFor(userId, offsetMinutes = 0) {
  const db = getDb();
  const row = db.prepare('SELECT xp FROM users WHERE id = ?').get(userId);
  const xp = (row && row.xp) || 0;
  const earned = earnedBadges(userId);
  const earnedIds = new Set(earned.map((b) => b.badge_id));

  return {
    ...levelFromXp(xp),
    streak: readStreak(userId, offsetMinutes),
    badges: BADGES.map((b) => ({
      ...b,
      earned: earnedIds.has(b.id),
      earnedAt: (earned.find((e) => e.badge_id === b.id) || {}).earned_at || null,
    })),
    badgeCount: earned.length,
    badgeTotal: BADGES.length,
  };
}

module.exports = {
  XP_BY_DIFFICULTY, xpForLevel, levelFromXp, xpForAnswer,
  touchStreak, readStreak, localDayKey,
  allBadges, earnedBadges, awardBadge, checkBadges,
  addXp, profileFor,
};
