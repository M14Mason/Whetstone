
'use strict';

/**
 * AP exam practice.
 *
 * Two deliberate constraints shape this module.
 *
 * 1. FORMAT DATA IS NEVER INVENTED. data/ap-exams.json holds only structures
 *    read from College Board's official "About the Exam" page. A course with no
 *    entry gets an honest "format not verified" response and a link out, rather
 *    than a plausible-looking guess. A student who practises the wrong section
 *    timings is worse off than one who practised nothing.
 *
 * 2. WE DO NOT PRETEND TO GRADE ESSAYS. An AP DBQ is scored on thesis,
 *    contextualization, evidence, sourcing and complexity. No offline heuristic
 *    can judge those honestly. So the free-response flow does two separate
 *    things and never blurs them:
 *      - AUTO-CHECKS: objective, verifiable facts about the response (word
 *        count, how many documents were cited, whether parts a/b/c were all
 *        answered). Reported as facts, never as a score.
 *      - SELF-SCORING: the real College Board rubric, point by point, which the
 *        student applies to their own writing.
 *    A number invented by a keyword matcher would be worse than no number,
 *    because the student would believe it.
 */

const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const courses = require('./courses');

const DATA_DIR = path.join(__dirname, '..', 'data');
const EXAM_UNIT = 'AP Exam Practice';

let cache = null;
function load() {
  if (cache) return cache;
  const read = (f) => {
    const p = path.join(DATA_DIR, f);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
  };
  const examDoc = read('ap-exams.json');
  cache = {
    exams: examDoc.exams || {},
    // Courses assessed by portfolio or performance task, which have no written
    // exam to practise. Distinct from "not researched yet".
    portfolio: examDoc.portfolioCourses || {},
    frqs: read('ap-frqs.json').frqs || {},
  };
  return cache;
}
function resetCache() { cache = null; }

function examFormat(courseId) {
  return load().exams[courseId] || null;
}

function portfolioInfo(courseId) {
  return load().portfolio[courseId] || null;
}

function frqsFor(courseId) {
  return load().frqs[courseId] || [];
}

/** Every AP course, with whether we hold a verified exam format for it. */
function coverage() {
  const ap = courses.allCourses().filter((c) => c.level === 'ap');
  return ap.map((c) => ({
    id: c.id,
    name: c.name,
    verifiedFormat: Boolean(examFormat(c.id)),
    portfolio: Boolean(portfolioInfo(c.id)),
    frqCount: frqsFor(c.id).length,
  }));
}

/**
 * Assemble a practice exam.
 *
 * MCQ counts follow the official section length, but the bank rarely holds a
 * full 60-question set for one course, so the section is capped at what exists
 * and reports both numbers. Silently serving 12 questions and calling it
 * "Section I" would misrepresent the exam.
 */
function buildExam(courseId, { mcqLimit = null } = {}) {
  const course = courses.getCourse(courseId);
  if (!course) return { error: 'Unknown course.' };
  if (course.level !== 'ap') return { error: 'Not an AP course.' };

  const portfolio = portfolioInfo(courseId);
  if (portfolio) {
    return {
      courseId, name: course.name, verified: false, portfolio: true,
      message: portfolio.reason,
      officialUrl: portfolio.source,
    };
  }

  const format = examFormat(courseId);
  if (!format) {
    return {
      courseId,
      name: course.name,
      verified: false,
      message: 'We have not verified this exam format against College Board yet, '
        + 'so we will not guess at section timings. You can still practise the '
        + 'question bank for this course.',
      officialUrl: `https://apstudents.collegeboard.org/courses`,
    };
  }

  const db = getDb();
  const bank = courses.bankFor(courseId);
  const sections = format.sections.map((s) => {
    if (s.id !== 'mcq') return { ...s, kind: 'frq' };
    const want = mcqLimit ? Math.min(mcqLimit, s.count) : s.count;
    const rows = db.prepare(
      'SELECT * FROM questions WHERE course_id = ? ORDER BY RANDOM() LIMIT ?'
    ).all(bank, want);
    return {
      ...s,
      kind: 'mcq',
      officialCount: s.count,
      servedCount: rows.length,
      questions: rows.map((q) => ({
        id: q.id, prompt: q.prompt, choices: JSON.parse(q.choices),
        topic: q.topic, difficulty: q.difficulty,
      })),
    };
  });

  return {
    courseId,
    name: course.name,
    verified: true,
    delivery: format.delivery,
    durationMin: format.durationMin,
    examDate: format.examDate,
    calculator: format.calculator,
    source: format.source,
    sections,
    frqs: frqsFor(courseId),
  };
}

/** Grade the multiple-choice section. This part is exact. */
function gradeMcq(courseId, answers) {
  const db = getDb();
  const ids = Object.keys(answers || {});
  if (!ids.length) return { correct: 0, total: 0, percent: 0, results: [] };

  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT id, answer, explanation, topic FROM questions WHERE id IN (${ph})`).all(...ids);
  const results = rows.map((q) => ({
    id: q.id,
    correct: Number(answers[q.id]) === q.answer,
    correctChoice: q.answer,
    chosen: Number(answers[q.id]),
    topic: q.topic,
    explanation: q.explanation,
  }));
  const correct = results.filter((r) => r.correct).length;
  return {
    correct,
    total: results.length,
    percent: results.length ? Math.round((correct / results.length) * 100) : 0,
    results,
  };
}

/**
 * Objective checks on a free-response answer.
 *
 * Everything here is a countable fact, never a judgement of quality. The one
 * soft check is `thesis`, which looks for a claim-shaped sentence; it is
 * explicitly labelled a hint in the UI because a heuristic cannot tell a real
 * thesis from a restated prompt.
 */
function autoCheck(text, checks = []) {
  const body = String(text || '').trim();
  const words = body ? body.split(/\s+/).length : 0;
  const paragraphs = body ? body.split(/\n\s*\n/).filter((p) => p.trim()).length : 0;
  const out = [];

  for (const raw of checks) {
    const [kind, arg] = String(raw).split(':');
    if (kind === 'length') {
      const min = Number(arg);
      out.push({ kind: 'Length', pass: words >= min, detail: `${words} words (target ${min}+)`, hint: false });
    } else if (kind === 'paragraphs') {
      const min = Number(arg);
      out.push({ kind: 'Structure', pass: paragraphs >= min, detail: `${paragraphs} paragraphs (target ${min}+)`, hint: false });
    } else if (kind === 'documents') {
      const n = (body.match(/\b(?:doc(?:ument)?\.?\s*\d+)/gi) || []).length;
      const uniq = new Set((body.match(/\b(?:doc(?:ument)?\.?\s*)(\d+)/gi) || []).map((m) => m.replace(/\D/g, ''))).size;
      out.push({ kind: 'Document citations', pass: uniq >= Number(arg), detail: `${uniq} distinct documents cited (${n} references)`, hint: false });
    } else if (kind === 'parts') {
      const n = new Set((body.match(/(?:^|\n)\s*\(?([a-f])[).]/gim) || []).map((m) => m.trim().toLowerCase().replace(/[^a-f]/g, ''))).size;
      out.push({ kind: 'Parts answered', pass: n >= Number(arg), detail: `${n} of ${arg} labelled parts found`, hint: false });
    } else if (kind === 'terms') {
      const need = String(arg).split(',');
      const missing = need.filter((t) => !new RegExp(`\\b${t}`, 'i').test(body));
      out.push({ kind: 'Key terminology', pass: missing.length === 0,
        detail: missing.length ? `not mentioned: ${missing.join(', ')}` : `all ${need.length} present`, hint: false });
    } else if (kind === 'foundational') {
      const docs = ['federalist', 'constitution', 'declaration', 'brutus', 'articles of confederation', 'bill of rights', 'letter from'];
      const found = docs.filter((d) => body.toLowerCase().includes(d));
      out.push({ kind: 'Foundational document', pass: found.length > 0,
        detail: found.length ? `referenced: ${found.join(', ')}` : 'none referenced', hint: false });
    } else if (kind === 'thesis') {
      const paras = body.split(/\n\s*\n/).filter((p) => p.trim());
      const zone = [paras[0] || '', paras[paras.length - 1] || ''].join(' ');
      const claimish = /\b(because|although|while|despite|therefore|argues?|demonstrates?|reveals?|ultimately|primarily|largely)\b/i.test(zone);
      out.push({ kind: 'Thesis (hint only)', pass: claimish,
        detail: claimish
          ? 'a claim-shaped sentence appears in your opening or closing'
          : 'no claim-shaped sentence found in your opening or closing',
        hint: true });
    } else if (kind === 'noSummary') {
      const summaryish = /\b(first|then|next|after that|finally),?\s+(the|he|she|they)\b/i.test(body);
      out.push({ kind: 'Summary warning (hint only)', pass: !summaryish,
        detail: summaryish ? 'reads partly like plot summary' : 'does not read like plot summary', hint: true });
    }
  }
  return { words, paragraphs, checks: out };
}

/**
 * Rough AP score band from a multiple-choice percentage.
 *
 * Deliberately reported as a band with a caveat. Real AP cut scores are set per
 * administration and are not published as fixed percentages, so a precise
 * "you got a 4" claim from an MCQ-only practice section would be false
 * precision on something students take seriously.
 */
function estimateBand(percent) {
  if (percent >= 75) return { band: '4-5', note: 'Around the range where 4s and 5s usually fall.' };
  if (percent >= 60) return { band: '3-4', note: 'Around the range where 3s and 4s usually fall.' };
  if (percent >= 45) return { band: '2-3', note: 'Around the range where 2s and 3s usually fall.' };
  return { band: '1-2', note: 'Below the usual passing range.' };
}

/** The synthetic unit each AP course exposes for exam practice. */
function examUnitName() { return EXAM_UNIT; }

module.exports = {
  examFormat, portfolioInfo, frqsFor, coverage, buildExam, gradeMcq,
  autoCheck, estimateBand, examUnitName, resetCache,
};
