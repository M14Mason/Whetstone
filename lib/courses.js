'use strict';

/**
 * The course catalog: every course, every unit.
 *
 * This is the thing competitors do not have. Quizlet has millions of
 * user-made sets with no structure; Khan Academy has structure but only for the
 * courses it chose to build. Whetstone maps the actual curriculum a student is
 * enrolled in, unit by unit, so "I have a Unit 4 test on Thursday" is a thing
 * the app can answer directly.
 *
 * Coverage is reported honestly per unit. A unit with no questions says so
 * rather than pretending, because a student who taps an empty unit and finds
 * nothing will not come back.
 */

const fs = require('node:fs');
const path = require('node:path');

const COURSES_DIR = path.join(__dirname, '..', 'data', 'courses');

const LEVEL_LABELS = {
  regular: 'Regular',
  honors: 'Honors',
  ap: 'AP',
  college: 'College',
  'test-prep': 'Test Prep',
};

// Grade codes above 12 mean college years, so a single field covers both.
const GRADE_LABELS = {
  9: '9th grade', 10: '10th grade', 11: '11th grade', 12: '12th grade',
  13: 'College freshman', 14: 'College sophomore', 15: 'College junior', 16: 'College senior',
};

let cache = null;

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

function loadAll() {
  if (cache) return cache;

  const files = fs.existsSync(COURSES_DIR)
    ? fs.readdirSync(COURSES_DIR).filter((f) => f.endsWith('.json')).sort()
    : [];

  const courses = [];
  const errors = [];

  for (const file of files) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(COURSES_DIR, file), 'utf8'));
    } catch (err) {
      errors.push(`${file}: invalid JSON (${err.message})`);
      continue;
    }
    if (!Array.isArray(parsed)) {
      errors.push(`${file}: expected an array`);
      continue;
    }

    for (const course of parsed) {
      if (!course.id || !course.name || !Array.isArray(course.units)) {
        errors.push(`${file}: malformed course ${course.id || '(no id)'}`);
        continue;
      }
      courses.push({
        id: course.id,
        name: course.name,
        level: course.level || 'regular',
        levelLabel: LEVEL_LABELS[course.level] || 'Regular',
        category: course.category || 'Other',
        grades: course.grades || [],
        source: file.replace('.json', ''),
        units: course.units.map((name, i) => ({
          id: `${course.id}--${slug(name)}`,
          courseId: course.id,
          name,
          order: i + 1,
        })),
      });
    }
  }

  const ids = new Set();
  for (const c of courses) {
    if (ids.has(c.id)) errors.push(`duplicate course id: ${c.id}`);
    ids.add(c.id);
  }

  cache = { courses, errors };
  return cache;
}

function allCourses() {
  return loadAll().courses;
}

function getCourse(courseId) {
  return allCourses().find((c) => c.id === courseId) || null;
}

function getUnit(unitId) {
  for (const course of allCourses()) {
    const unit = course.units.find((u) => u.id === unitId);
    if (unit) return { ...unit, course };
  }
  return null;
}

function allUnits() {
  return allCourses().flatMap((c) => c.units.map((u) => ({ ...u, course: c })));
}

/** Courses grouped by category, for the picker. */
function byCategory(filter = {}) {
  const grouped = new Map();
  for (const course of allCourses()) {
    if (filter.level && course.level !== filter.level) continue;
    if (filter.grade && course.grades.length > 0 && !course.grades.includes(filter.grade)) continue;
    if (filter.search) {
      const q = filter.search.toLowerCase();
      if (!course.name.toLowerCase().includes(q) && !course.category.toLowerCase().includes(q)) continue;
    }
    if (!grouped.has(course.category)) grouped.set(course.category, []);
    grouped.get(course.category).push(course);
  }
  return [...grouped.entries()]
    .map(([category, list]) => ({
      category,
      courses: list.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Suggest courses for a grade level. Used by onboarding so a 10th grader is
 * not scrolling past Organic Chemistry to find Geometry.
 */
function suggestedForGrade(grade) {
  const g = Number(grade);
  return allCourses()
    .filter((c) => c.grades.includes(g))
    .sort((a, b) => {
      const levelRank = { regular: 0, honors: 1, ap: 2, 'test-prep': 3, college: 4 };
      const diff = (levelRank[a.level] ?? 9) - (levelRank[b.level] ?? 9);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
}

function stats() {
  const courses = allCourses();
  const byLevel = new Map();
  const byCat = new Map();
  let unitCount = 0;

  for (const c of courses) {
    unitCount += c.units.length;
    byLevel.set(c.levelLabel, (byLevel.get(c.levelLabel) || 0) + 1);
    byCat.set(c.category, (byCat.get(c.category) || 0) + 1);
  }

  return {
    courses: courses.length,
    units: unitCount,
    byLevel: [...byLevel].sort((a, b) => b[1] - a[1]),
    byCategory: [...byCat].sort((a, b) => b[1] - a[1]),
  };
}

function validationErrors() {
  return loadAll().errors;
}

function resetCache() {
  cache = null;
}

module.exports = {
  allCourses, getCourse, getUnit, allUnits, byCategory,
  suggestedForGrade, stats, validationErrors, resetCache, slug,
  LEVEL_LABELS, GRADE_LABELS,
};
