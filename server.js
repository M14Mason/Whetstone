'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { config, isBillingLive } = require('./lib/config');
const { init: initDb, getDb: getDbHandle } = require('./lib/db');
const auth = require('./lib/auth');
const adaptive = require('./lib/adaptive');
const plans = require('./lib/plans');
const groups = require('./lib/groups');
const billing = require('./lib/billing');
const questions = require('./lib/questions');
const ratelimit = require('./lib/ratelimit');
const tokens = require('./lib/tokens');
const mailer = require('./lib/mailer');
const monitor = require('./lib/monitor');
const courses = require('./lib/courses');
const modes = require('./lib/modes');
const social = require('./lib/social');

// Bumping this forces existing users to re-accept the terms on next signup flow.
const TOS_VERSION = '2026-08-11';

const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_COOKIE = 'whetstone_session';

/**
 * Security headers applied to every response.
 * The CSP is deliberately strict: no inline scripts, no external origins.
 * If you ever add a CDN or analytics, this is the list to update.
 */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    // Google Fonts serves the stylesheet from one origin and the font files
    // from another, so both need allowing. Everything else stays locked down.
    "style-src 'self' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
  ].join('; '),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function clientIp(req) {
  // TRUST_PROXY should only be enabled behind a proxy you control, otherwise
  // a client can forge X-Forwarded-For and evade rate limiting entirely.
  if (process.env.TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

function enforceLimit(req, res, name, limits) {
  const result = ratelimit.hit(`${name}:${clientIp(req)}`, limits);
  if (!result.allowed) {
    sendJson(res, 429, {
      error: 'Too many requests. Wait a moment and try again.',
      retryAfterSeconds: result.retryAfterSeconds,
    }, { 'Retry-After': String(result.retryAfterSeconds) });
    return false;
  }
  return true;
}

/**
 * CSRF defence in depth. SameSite=Lax already blocks the cookie on cross-site
 * POSTs, but browsers and proxies vary, so state-changing requests must also
 * come from our own origin. The Stripe webhook is exempt: it is a server-to-
 * server call with no Origin header, authenticated by signature instead.
 */
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser client, or same-origin form post
  try {
    const host = req.headers.host;
    return new URL(origin).host === host || origin === config.publicUrl;
  } catch {
    return false;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function sessionCookie(token, expiresAt) {
  const secure = config.publicUrl.startsWith('https://') ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly;${secure} SameSite=Lax; Expires=${expiresAt.toUTCString()}`;
}

function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

const MAX_BODY_BYTES = 1024 * 100;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('Invalid JSON body.'), { statusCode: 400 });
  }
}

function currentUser(req) {
  return auth.getSessionUser(parseCookies(req)[SESSION_COOKIE]);
}

function requireUser(req) {
  const user = currentUser(req);
  if (!user) throw Object.assign(new Error('You need to sign in.'), { statusCode: 401 });
  return user;
}

function publicUser(user) {
  const quota = plans.checkQuota(user.id);
  const group = groups.getGroupForUser(user.id);
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    plan: quota.plan,
    planLabel: quota.planLabel,
    quota,
    activeSubjects: plans.activeSubjectsFor(user.id),
    emailVerified: auth.isEmailVerified(user.id),
    gradeLevel: user.grade_level || null,
    onboarded: Boolean(user.onboarded_at),
    courses: plans.userCourses(user.id).map((c) => ({
      id: c.id, name: c.name, levelLabel: c.levelLabel, category: c.category,
    })),
    group: group ? { id: group.id, name: group.name, active: group.active, memberCount: group.memberCount } : null,
    billingMode: isBillingLive() ? 'live' : 'demo',
  };
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

const routes = {
  'POST /api/auth/signup': async (req, res) => {
    if (!enforceLimit(req, res, 'signup', ratelimit.LIMITS.signup)) return;
    const body = await readJsonBody(req);

    // Acceptance is enforced server-side. A checkbox that only the browser
    // checks is not an agreement, and the whole point is to have a record.
    if (body.acceptTerms !== true) {
      throw Object.assign(
        new Error('You must accept the Terms of Service and Privacy Policy to create an account.'),
        { statusCode: 400 }
      );
    }

    const user = auth.createUser({
      email: body.email,
      password: body.password,
      displayName: body.displayName,
      birthYear: body.birthYear,
      timezoneOffsetMinutes: body.timezoneOffsetMinutes,
    });
    // New accounts start on the first subject so the quiz works immediately.
    const available = plans.allSubjects();
    if (available.length > 0) plans.setUserSubjects(user.id, [available[0]]);

    getDbHandle().prepare('UPDATE users SET tos_accepted_at = ?, tos_version = ? WHERE id = ?')
      .run(new Date().toISOString(), TOS_VERSION, user.id);

    const { token, expiresAt } = auth.createSession(user.id);
    sendJson(res, 201, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, expiresAt) });
  },

  'POST /api/auth/login': async (req, res) => {
    if (!enforceLimit(req, res, 'login', ratelimit.LIMITS.login)) return;
    const body = await readJsonBody(req);
    const user = auth.authenticate(body.email, body.password);
    if (!user) throw Object.assign(new Error('Email or password is incorrect.'), { statusCode: 401 });
    auth.purgeExpiredSessions();
    const { token, expiresAt } = auth.createSession(user.id);
    sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': sessionCookie(token, expiresAt) });
  },

  'POST /api/auth/logout': async (req, res) => {
    auth.destroySession(parseCookies(req)[SESSION_COOKIE]);
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearedCookie() });
  },

  // ---------------------------------------------------------------- password reset
  'POST /api/auth/request-reset': async (req, res) => {
    if (!enforceLimit(req, res, 'reset', ratelimit.LIMITS.reset)) return;
    const body = await readJsonBody(req);
    const user = auth.getUserByEmail(body.email || '');

    // Always report success. Revealing whether an address has an account lets
    // anyone enumerate the user list.
    if (user) {
      const { token } = tokens.issue(user.id, tokens.PURPOSE.RESET);
      await mailer.send(mailer.passwordResetEmail(user.email, token));
    }
    sendJson(res, 200, {
      ok: true,
      message: 'If an account exists for that address, a reset link is on its way.',
      mailMode: mailer.isLive() ? 'live' : 'console',
    });
  },

  'POST /api/auth/reset': async (req, res) => {
    if (!enforceLimit(req, res, 'reset', ratelimit.LIMITS.reset)) return;
    const body = await readJsonBody(req);
    const userId = tokens.consume(body.token, tokens.PURPOSE.RESET);
    if (!userId) {
      throw Object.assign(
        new Error('That reset link is invalid or has expired. Request a new one.'),
        { statusCode: 400 }
      );
    }
    const result = auth.setPassword(userId, body.password);
    sendJson(res, 200, {
      ok: true,
      sessionsRevoked: result.sessionsRevoked,
      message: 'Password updated. Sign in with your new password.',
    }, { 'Set-Cookie': clearedCookie() });
  },

  'GET /api/auth/reset-valid': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const valid = Boolean(tokens.peek(url.searchParams.get('token'), tokens.PURPOSE.RESET));
    sendJson(res, 200, { valid });
  },

  // ----------------------------------------------------------- email verification
  'POST /api/auth/send-verification': async (req, res) => {
    const user = requireUser(req);
    if (!enforceLimit(req, res, 'verify', ratelimit.LIMITS.verify)) return;
    if (auth.isEmailVerified(user.id)) {
      return sendJson(res, 200, { ok: true, alreadyVerified: true });
    }
    const { token } = tokens.issue(user.id, tokens.PURPOSE.VERIFY);
    await mailer.send(mailer.verificationEmail(user.email, token));
    sendJson(res, 200, {
      ok: true,
      message: 'Verification email sent.',
      mailMode: mailer.isLive() ? 'live' : 'console',
    });
  },

  'POST /api/auth/verify': async (req, res) => {
    const body = await readJsonBody(req);
    const userId = tokens.consume(body.token, tokens.PURPOSE.VERIFY);
    if (!userId) {
      throw Object.assign(
        new Error('That verification link is invalid or has expired.'),
        { statusCode: 400 }
      );
    }
    auth.markEmailVerified(userId);
    sendJson(res, 200, { ok: true, message: 'Email confirmed.' });
  },

  'GET /api/me': async (req, res) => {
    const user = currentUser(req);
    sendJson(res, 200, {
      user: user ? publicUser(user) : null,
      testingMode: config.testingMode,
    });
  },

  'POST /api/account/display-name': async (req, res) => {
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const name = String(body.displayName || '').trim();
    if (name.length < 2 || name.length > 40) {
      return sendJson(res, 400, { error: 'Name must be 2 to 40 characters.' });
    }
    getDbHandle().prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
    sendJson(res, 200, { displayName: name });
  },

  // ------------------------------------------------------- tester plan switch
  // Lets a tester move between Free, Premium, and Study Group without Stripe,
  // so they can actually see what each tier unlocks. Returns 404 when testing
  // mode is off, so the endpoint does not exist at all in a real deployment.
  'POST /api/dev/plan': async (req, res) => {
    if (!config.testingMode) return sendJson(res, 404, { error: 'Not found' });
    const user = requireUser(req, res);
    if (!user) return;
    const body = await readJson(req);
    const plan = String(body.plan || '');
    if (!['free', 'premium', 'group'].includes(plan)) {
      return sendJson(res, 400, { error: 'Pick free, premium, or group.' });
    }
    billing.setUserPlan(user.id, plan);
    sendJson(res, 200, { plan, message: `Switched to ${plan}. Testing mode only.` });
  },

  'GET /api/subjects': async (req, res) => {
    const user = currentUser(req);
    sendJson(res, 200, {
      subjects: plans.allSubjects(),
      active: user ? plans.activeSubjectsFor(user.id) : [],
      maxSubjects: user ? plans.checkQuota(user.id).maxSubjects : 1,
    });
  },

  'POST /api/subjects': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const active = plans.setUserSubjects(user.id, body.subjects);
    sendJson(res, 200, { active, user: publicUser(user) });
  },

  'GET /api/quiz/next': async (req, res) => {
    const user = requireUser(req);
    const quota = plans.checkQuota(user.id);
    if (quota.exhausted) {
      return sendJson(res, 402, {
        error: `You have used all ${quota.limit} free questions for today.`,
        quota,
        upgrade: true,
      });
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const scope = plans.learningScope(user.id, {
      courseId: url.searchParams.get('courseId') || undefined,
      unit: url.searchParams.get('unit') || undefined,
    });

    const question = adaptive.selectNextQuestion(user.id, scope);
    if (!question) {
      return sendJson(res, 404, {
        error: scope.kind === 'unit' || scope.kind === 'course'
          ? 'This unit does not have questions yet. Try another unit or study everything.'
          : 'No questions available yet for your courses. Add a course with content on the Courses tab.',
      });
    }
    // Pin this question so the answer can be matched to what was issued.
    auth.setPendingQuestion(user.id, question.id);

    const state = adaptive.getTopicState(user.id, question.subject, question.topic);
    sendJson(res, 200, {
      question: questions.forClient(question),
      quota,
      topicState: {
        topic: question.topic,
        attempts: state.attempts,
        masteryPercent: state.attempts === 0 ? null : Math.round(state.ewma_correct * 100),
        ability: Math.round(state.ability),
      },
    });
  },

  'POST /api/quiz/answer': async (req, res) => {
    const user = requireUser(req);
    const quota = plans.checkQuota(user.id);
    if (quota.exhausted) {
      return sendJson(res, 402, { error: 'Daily free limit reached.', quota, upgrade: true });
    }

    const body = await readJsonBody(req);
    const question = questions.getQuestion(body.questionId);
    if (!question) throw Object.assign(new Error('Question not found.'), { statusCode: 404 });

    const chosen = Number(body.choice);
    if (!Number.isInteger(chosen) || chosen < 0 || chosen >= question.choices.length) {
      throw Object.assign(new Error('Invalid answer choice.'), { statusCode: 400 });
    }

    // The answer must correspond to the question we actually served. Without
    // this check a client could replay an easy question to farm its rating.
    if (!auth.consumePendingQuestion(user.id, question.id)) {
      throw Object.assign(
        new Error('That question is no longer active. Load the next question and try again.'),
        { statusCode: 409 }
      );
    }

    const isCorrect = chosen === question.answer;
    const result = adaptive.recordResult(user.id, question, isCorrect, { chosen });

    sendJson(res, 200, {
      correct: isCorrect,
      correctChoice: question.answer,
      explanation: question.explanation,
      progress: result,
      quota: plans.checkQuota(user.id),
    });
  },

  // -------------------------------------------------------------- courses
  'GET /api/courses': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const grade = url.searchParams.get('grade');
    const search = url.searchParams.get('search');
    const level = url.searchParams.get('level');

    sendJson(res, 200, {
      groups: courses.byCategory({
        grade: grade ? Number(grade) : undefined,
        search: search || undefined,
        level: level || undefined,
      }),
      stats: courses.stats(),
    });
  },

  'GET /api/courses/suggested': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const grade = Number(url.searchParams.get('grade'));
    sendJson(res, 200, { courses: courses.suggestedForGrade(grade) });
  },

  'GET /api/course': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const coverage = plans.courseCoverage(url.searchParams.get('id'));
    if (!coverage) throw Object.assign(new Error('Course not found.'), { statusCode: 404 });
    sendJson(res, 200, coverage);
  },

  'GET /api/my-courses': async (req, res) => {
    const user = requireUser(req);
    const list = plans.userCourses(user.id);
    sendJson(res, 200, {
      courses: list.map((c) => plans.courseCoverage(c.id)),
    });
  },

  'POST /api/my-courses': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const saved = plans.setUserCourses(user.id, body.courseIds);
    sendJson(res, 200, { courseIds: saved, user: publicUser(user) });
  },

  'POST /api/onboarding': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);

    const grade = Number(body.gradeLevel);
    if (!Number.isInteger(grade) || grade < 9 || grade > 16) {
      throw Object.assign(new Error('Choose a grade level.'), { statusCode: 400 });
    }
    plans.setUserCourses(user.id, body.courseIds || []);

    getDbHandle().prepare('UPDATE users SET grade_level = ?, goal = ?, onboarded_at = ? WHERE id = ?')
      .run(grade, String(body.goal || '').slice(0, 60), new Date().toISOString(), user.id);

    sendJson(res, 200, { user: publicUser(auth.getUserById(user.id)) });
  },

  // ---------------------------------------------------------- study modes
  'GET /api/modes/flashcards': async (req, res) => {
    const user = requireUser(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const scope = plans.learningScope(user.id, {
      courseId: url.searchParams.get('courseId') || undefined,
      unit: url.searchParams.get('unit') || undefined,
    });

    const cards = modes.getFlashcards(scope, 30);
    sendJson(res, 200, { cards, count: cards.length });
  },

  'GET /api/modes/match': async (req, res) => {
    const user = requireUser(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const courseId = url.searchParams.get('courseId') || undefined;
    const unit = url.searchParams.get('unit') || undefined;
    const scope = plans.learningScope(user.id, { courseId, unit });

    const set = modes.getMatchSet(scope, 6);
    if (!set) {
      return sendJson(res, 404, { error: 'Not enough flashcards here yet for a Match game.' });
    }
    sendJson(res, 200, { ...set, bestMs: modes.bestMatchTime(user.id, courseId, unit) });
  },

  'POST /api/modes/match/complete': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const durationMs = Number(body.durationMs);
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw Object.assign(new Error('Invalid duration.'), { statusCode: 400 });
    }
    const previousBest = modes.bestMatchTime(user.id, body.courseId, body.unit);
    modes.recordSession({
      userId: user.id, mode: 'match', courseId: body.courseId, unit: body.unit,
      total: Number(body.pairs) || null, durationMs,
    });
    sendJson(res, 200, {
      durationMs,
      previousBest,
      isPersonalBest: previousBest === null || durationMs < previousBest,
    });
  },

  'GET /api/modes/test': async (req, res) => {
    const user = requireUser(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const scope = plans.learningScope(user.id, {
      courseId: url.searchParams.get('courseId') || undefined,
      unit: url.searchParams.get('unit') || undefined,
    });

    const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 10, 5), 25);
    const questions = modes.getTest(scope, count);
    if (questions.length === 0) {
      return sendJson(res, 404, { error: 'No questions available for this selection yet.' });
    }
    sendJson(res, 200, { questions, count: questions.length });
  },

  'POST /api/modes/test/grade': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const graded = modes.gradeTest(body.answers);

    // Test answers feed the adaptive model too, so a test is real practice.
    for (const r of graded.results) {
      const question = questions.getQuestion(r.questionId);
      if (question) {
        adaptive.recordResult(user.id, question, r.correct, { chosen: r.chosen });
      }
    }
    modes.recordSession({
      userId: user.id, mode: 'test', courseId: body.courseId, unit: body.unit,
      score: graded.percent, total: graded.total, durationMs: Number(body.durationMs) || null,
    });

    sendJson(res, 200, graded);
  },

  'GET /api/modes/review': async (req, res) => {
    const user = requireUser(req);
    const queue = modes.getReviewQueue(user.id, 20);
    sendJson(res, 200, { questions: queue, count: queue.length });
  },

  // ------------------------------------------------------------ group chat
  'GET /api/group/channels': async (req, res) => {
    const user = requireUser(req);
    const group = groups.getGroupForUser(user.id);
    if (!group) throw Object.assign(new Error('You are not in a group.'), { statusCode: 404 });
    sendJson(res, 200, { channels: social.channelsFor(group.id), groupId: group.id });
  },

  'GET /api/group/messages': async (req, res) => {
    const user = requireUser(req);
    const group = groups.getGroupForUser(user.id);
    if (!group) throw Object.assign(new Error('You are not in a group.'), { statusCode: 404 });

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const channel = url.searchParams.get('channel') || 'general';
    const since = Number(url.searchParams.get('since')) || 0;
    sendJson(res, 200, { messages: social.getMessages(group.id, user.id, channel, { since }) });
  },

  'POST /api/group/messages': async (req, res) => {
    const user = requireUser(req);
    const group = groups.getGroupForUser(user.id);
    if (!group) throw Object.assign(new Error('You are not in a group.'), { statusCode: 404 });

    const body = await readJsonBody(req);
    const message = social.postMessage(group.id, user.id, body.channel || 'general', body.body);
    sendJson(res, 201, { message });
  },

  'POST /api/group/messages/delete': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, social.deleteMessage(Number(body.id), user.id));
  },

  // ----------------------------------------------------------- custom sets
  'GET /api/sets': async (req, res) => {
    const user = requireUser(req);
    sendJson(res, 200, { sets: social.listSets(user.id) });
  },

  'GET /api/set': async (req, res) => {
    const user = requireUser(req);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const set = social.getSet(Number(url.searchParams.get('id')), user.id);
    if (!set) throw Object.assign(new Error('Set not found.'), { statusCode: 404 });
    sendJson(res, 200, { set });
  },

  'POST /api/sets': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    sendJson(res, 201, { set: social.createSet(user.id, body) });
  },

  'POST /api/sets/update': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    social.replaceCards(Number(body.id), user.id, body.cards);
    sendJson(res, 200, { set: social.getSet(Number(body.id), user.id) });
  },

  'POST /api/sets/delete': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    sendJson(res, 200, social.deleteSet(Number(body.id), user.id));
  },

  // ----------------------------------------------------------- bug reports
  'POST /api/bugs': async (req, res) => {
    const user = currentUser(req);
    if (!enforceLimit(req, res, 'bugs', ratelimit.LIMITS.bugs)) return;
    const body = await readJsonBody(req);
    const result = social.fileBug(user ? user.id : null, {
      title: body.title,
      body: body.body,
      page: body.page,
      userAgent: req.headers['user-agent'],
      appVersion: TOS_VERSION,
    });
    sendJson(res, 201, { ...result, message: 'Thanks. Your report was saved locally.' });
  },

  'GET /api/bugs/mine': async (req, res) => {
    const user = requireUser(req);
    sendJson(res, 200, { bugs: social.myBugs(user.id) });
  },

  // -------------------------------------------------------------- legal
  'GET /api/legal': async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const which = url.searchParams.get('doc') === 'privacy' ? 'PRIVACY.md' : 'TERMS.md';
    const file = path.join(__dirname, 'legal', which);
    if (!fs.existsSync(file)) throw Object.assign(new Error('Not found.'), { statusCode: 404 });
    sendJson(res, 200, {
      version: TOS_VERSION,
      doc: which === 'PRIVACY.md' ? 'privacy' : 'terms',
      markdown: fs.readFileSync(file, 'utf8'),
    });
  },

  'GET /api/dashboard': async (req, res) => {
    const user = requireUser(req);
    sendJson(res, 200, {
      report: adaptive.buildMasteryReport(user.id),
      quota: plans.checkQuota(user.id),
      profile: adaptive.learningProfile(user.id),
    });
  },

  'GET /api/groups/me': async (req, res) => {
    const user = requireUser(req);
    const group = groups.getGroupForUser(user.id);
    sendJson(res, 200, {
      group,
      leaderboard: group ? groups.leaderboard(group.id) : [],
      minSeats: groups.MIN_SEATS,
      seatPriceCents: config.plans.group.priceCentsPerSeat,
    });
  },

  'POST /api/groups': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const group = groups.createGroup(user.id, body.name);
    sendJson(res, 201, { group });
  },

  'POST /api/groups/join': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const group = groups.joinGroup(user.id, body.inviteCode);
    sendJson(res, 200, { group, user: publicUser(user) });
  },

  'POST /api/groups/leave': async (req, res) => {
    const user = requireUser(req);
    const result = groups.leaveGroup(user.id);
    sendJson(res, 200, { ...result, user: publicUser(user) });
  },

  'POST /api/billing/premium': async (req, res) => {
    const user = requireUser(req);
    const result = await billing.startPremiumCheckout(user);
    sendJson(res, 200, { ...result, user: publicUser(auth.getUserById(user.id)) });
  },

  'POST /api/billing/group': async (req, res) => {
    const user = requireUser(req);
    const body = await readJsonBody(req);
    const group = groups.getGroupForUser(user.id);
    if (!group) throw Object.assign(new Error('Create or join a group first.'), { statusCode: 400 });
    const result = await billing.startGroupCheckout(user, group.id, body.seats);
    sendJson(res, 200, { ...result, group: groups.getGroup(group.id), user: publicUser(auth.getUserById(user.id)) });
  },

  'POST /api/billing/cancel': async (req, res) => {
    const user = requireUser(req);
    billing.cancelDemo(user);
    sendJson(res, 200, { user: publicUser(auth.getUserById(user.id)) });
  },

  'POST /api/webhooks/stripe': async (req, res) => {
    const raw = await readBody(req);
    const signature = req.headers['stripe-signature'];

    if (!billing.isBillingLive()) {
      return sendJson(res, 400, { error: 'Billing is in demo mode; webhooks are disabled.' });
    }
    const ok = billing.verifyWebhookSignature(raw, signature, config.stripe.webhookSecret);
    if (!ok) return sendJson(res, 400, { error: 'Invalid signature.' });

    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: 'Invalid payload.' });
    }
    const result = billing.applyWebhookEvent(event);
    sendJson(res, 200, { received: true, ...result });
  },

  'GET /api/health': async (req, res) => {
    sendJson(res, 200, {
      status: 'ok',
      questions: questions.countQuestions(),
      billingMode: isBillingLive() ? 'live' : 'demo',
      mailMode: mailer.isLive() ? 'live' : 'console',
      ...monitor.snapshot(),
    });
  },
};

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

function serveStatic(req, res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, relative);

  // Prevent path traversal out of the public directory.
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown paths fall back to the app shell so client-side views work.
      if (!path.extname(relative)) {
        return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, shell) => {
          if (e2) return sendJson(res, 404, { error: 'Not found' });
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(shell);
        });
      }
      return sendJson(res, 404, { error: 'Not found' });
    }
    // Every asset must revalidate.
    //
    // An earlier version cached JS and CSS for an hour. Because index.html was
    // served fresh, a browser could end up running the PREVIOUS app.js against
    // the NEW markup, querying elements that no longer existed and crashing on
    // the first null. "no-cache" does not mean "do not store": the browser
    // keeps the file and revalidates with an ETag, so unchanged assets still
    // come back as a cheap 304. Correctness beats the few milliseconds saved.
    const etag = `W/"${data.length.toString(16)}-${Math.trunc(fs.statSync(filePath).mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ETag: etag,
      ...SECURITY_HEADERS,
    });
    res.end(data);
  });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const key = `${req.method} ${url.pathname}`;
    const handler = routes[key];

    // Reject cross-origin state changes. Stripe webhooks are exempt because
    // they are server-to-server and authenticated by signature.
    const isWebhook = url.pathname === '/api/webhooks/stripe';
    if (req.method !== 'GET' && !isWebhook && !originAllowed(req)) {
      return sendJson(res, 403, { error: 'Cross-origin request rejected.' });
    }

    if (req.method !== 'GET' && !isWebhook) {
      if (!enforceLimit(req, res, 'write', ratelimit.LIMITS.write)) return;
    }

    if (!handler) {
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 404, { error: `No route for ${key}` });
      }
      if (req.method === 'GET') return serveStatic(req, res, url.pathname);
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    monitor.recordRequest();
    try {
      await handler(req, res);
    } catch (err) {
      const status = err.statusCode || 500;
      // 4xx responses are normal user error (wrong password, expired link) and
      // would drown out real problems. Only 5xx gets reported.
      if (status >= 500) {
        monitor.recordError(err, { route: key, status });
      }
      sendJson(res, status, {
        error: status >= 500
          ? 'Something went wrong on our end. Please try again.'
          : err.message || 'Something went wrong.',
      });
    }
  });
}

function warnAboutProductionConfig() {
  const warnings = [];
  if (config.sessionSecret === 'dev-only-insecure-secret' || config.sessionSecret === 'change-me-in-production') {
    warnings.push('SESSION_SECRET is still the default. Set a random value before going live.');
  }
  if (isBillingLive() && !config.stripe.webhookSecret) {
    warnings.push('Stripe keys are set but STRIPE_WEBHOOK_SECRET is missing; subscriptions will not activate.');
  }
  if (isBillingLive() && !config.publicUrl.startsWith('https://')) {
    warnings.push('Billing is live but PUBLIC_URL is not https. Session cookies will not be marked Secure.');
  }
  return warnings;
}

function start() {
  initDb();
  try {
    questions.seed({ quiet: true });
  } catch (err) {
    console.error('Failed to load the question bank:');
    console.error(err.message);
    process.exit(1);
  }

  const server = createServer();

  // Housekeeping: expired sessions and stale rate-limit buckets.
  const janitor = setInterval(() => {
    try {
      auth.purgeExpiredSessions();
      tokens.purgeExpired();
      ratelimit.sweep();
    } catch (err) {
      console.error('[janitor]', err.message);
    }
  }, 60 * 60 * 1000);
  janitor.unref();

  server.listen(config.port, () => {
    console.log(`\n  Whetstone running at ${config.publicUrl}`);
    console.log(`  Questions loaded: ${questions.countQuestions()}`);
    console.log(`  Billing mode: ${isBillingLive() ? 'LIVE (Stripe)' : 'DEMO (no payments taken)'}`);
    for (const warning of warnAboutProductionConfig()) {
      console.warn(`  WARNING: ${warning}`);
    }
    console.log('');
  });

  // Finish in-flight requests before exiting, so a deploy does not cut a
  // student off mid-answer.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n  ${signal} received, shutting down.`);
    clearInterval(janitor);
    server.close(() => {
      try { require('./lib/db').close(); } catch { /* already closed */ }
      process.exit(0);
    });
    // Do not hang forever on a stuck connection.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason);
  });

  return server;
}

if (require.main === module) start();

module.exports = { createServer, start, routes };
