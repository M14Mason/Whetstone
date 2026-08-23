'use strict';

/**
 * End-to-end smoke test. Boots the real HTTP server against a throwaway
 * database file and drives an actual user journey over the network:
 * sign up, answer questions, hit the free-tier wall, upgrade, form a group.
 *
 * Run with: node test/e2e.js
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Kept in the OS temp directory so the test never writes into the repo.
const TMP_DB = path.join(require('node:os').tmpdir(), `whetstone-e2e-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
}

const db = require('../lib/db');
db.init(TMP_DB);

const { createServer } = require('../server');
const questions = require('../lib/questions');
const ratelimit = require('../lib/ratelimit');

questions.seed({ quiet: true });

let passed = 0;
const checks = [];
function check(label, fn) { checks.push({ label, fn }); }

let BASE = '';
let cookie = '';

async function call(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data };
}

// ---------------------------------------------------------------------------

check('health endpoint reports a loaded question bank', async () => {
  const { status, data } = await call('GET', '/api/health');
  assert.strictEqual(status, 200);
  assert.strictEqual(data.status, 'ok');
  assert.ok(data.questions >= 90, `only ${data.questions} questions loaded`);
  assert.strictEqual(data.billingMode, 'demo');
});

check('landing page and static assets are served', async () => {
  for (const [route, needle] of [['/', 'Whetstone'], ['/styles.css', ':root'], ['/app.js', 'Whetstone front end']]) {
    const res = await fetch(`${BASE}${route}`);
    assert.strictEqual(res.status, 200, `${route} returned ${res.status}`);
    assert.ok((await res.text()).includes(needle), `${route} missing expected content`);
  }
});

check('anonymous users cannot reach the quiz', async () => {
  const { status } = await call('GET', '/api/quiz/next');
  assert.strictEqual(status, 401);
});

check('signup creates a session and returns a free-plan user', async () => {
  const { status, data } = await call('POST', '/api/auth/signup', {
    displayName: 'E2E Student',
    email: 'e2e@example.com',
    password: 'a-good-long-password',
    birthYear: 2008,
    acceptTerms: true,
  });
  assert.strictEqual(status, 201);
  assert.strictEqual(data.user.plan, 'free');
  assert.strictEqual(data.user.quota.limit, 5);
  assert.ok(cookie.startsWith('whetstone_session='), 'no session cookie set');
});

check('under-13 signup is rejected over HTTP', async () => {
  const saved = cookie;
  cookie = '';
  const { status, data } = await call('POST', '/api/auth/signup', {
    displayName: 'Too Young',
    email: 'young@example.com',
    password: 'a-good-long-password',
    birthYear: new Date().getFullYear() - 9,
    acceptTerms: true,
  });
  assert.strictEqual(status, 400);
  assert.match(data.error, /at least 13/);
  cookie = saved;
});

check('quiz serves a question without leaking the answer', async () => {
  const { status, data } = await call('GET', '/api/quiz/next');
  assert.strictEqual(status, 200);
  assert.ok(data.question.id);
  assert.ok(Array.isArray(data.question.choices));
  assert.strictEqual(data.question.answer, undefined, 'answer leaked to client');
  assert.strictEqual(data.question.explanation, undefined, 'explanation leaked to client');
});

check('answering returns grading, explanation, and rating movement', async () => {
  const { data: next } = await call('GET', '/api/quiz/next');
  const { status, data } = await call('POST', '/api/quiz/answer', {
    questionId: next.question.id,
    choice: 0,
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(typeof data.correct, 'boolean');
  assert.ok(typeof data.explanation === 'string' && data.explanation.length > 0);
  assert.ok(Number.isInteger(data.progress.abilityAfter));
  // Quota counts answers, not questions fetched: this is the first answer.
  // Free Learn allowance is 3/day (config.freeDailyLimits.learn).
  assert.strictEqual(data.quota.used, 1);
  assert.strictEqual(data.quota.remaining, 2);
});

check('an invalid answer index is rejected', async () => {
  const { data: next } = await call('GET', '/api/quiz/next');
  const { status } = await call('POST', '/api/quiz/answer', {
    questionId: next.question.id,
    choice: 99,
  });
  assert.strictEqual(status, 400);
});

check('free tier blocks once the Learn allowance is gone', async () => {
  // Two answered above; burn the rest.
  for (let i = 0; i < 10; i++) {
    const nextRes = await call('GET', '/api/quiz/next');
    if (nextRes.status === 402) break;
    await call('POST', '/api/quiz/answer', {
      questionId: nextRes.data.question.id,
      choice: 0,
    });
  }
  const { status, data } = await call('GET', '/api/quiz/next');
  assert.strictEqual(status, 402, 'free tier should be exhausted');
  assert.strictEqual(data.upgrade, true);
  assert.strictEqual(data.quota.remaining, 0);
});

check('free users cannot select two subjects', async () => {
  const { status, data } = await call('POST', '/api/subjects', { subjects: ['Math', 'Coding'] });
  assert.strictEqual(status, 402);
  assert.match(data.error, /Free plan covers 1 subject/);
});

check('demo upgrade unlocks unlimited practice', async () => {
  const { status, data } = await call('POST', '/api/billing/premium', {});
  assert.strictEqual(status, 200);
  assert.strictEqual(data.mode, 'demo');
  assert.strictEqual(data.user.plan, 'premium');

  const quiz = await call('GET', '/api/quiz/next');
  assert.strictEqual(quiz.status, 200, 'premium user should not be rate limited');
  assert.strictEqual(quiz.data.quota.limit, null);
});

check('premium users can select every subject', async () => {
  const { status, data } = await call('POST', '/api/subjects', {
    subjects: ['Math', 'Coding', 'Science', 'English', 'Test Strategy'],
  });
  assert.strictEqual(status, 200);
  assert.strictEqual(data.active.length, 5);
});

check('dashboard reports real progress', async () => {
  // Learn only allows 3/day on free, so top up through the separate Review
  // allowance to get enough attempts on the board.
  for (let i = 0; i < 5; i++) {
    const nx = await call('GET', '/api/quiz/next?mode=review');
    if (nx.status !== 200) break;
    await call('POST', '/api/quiz/answer', {
      questionId: nx.data.question.id, choice: 0, mode: 'review',
    });
  }
  const { status, data } = await call('GET', '/api/dashboard');
  assert.strictEqual(status, 200);
  assert.ok(data.report.totals.totalAttempts >= 5,
    `only ${data.report.totals.totalAttempts} attempts recorded`);
  assert.ok(Array.isArray(data.report.subjects));
  assert.ok(data.report.subjects.length >= 1);
});

check('a group needs 3 members before it can be paid for', async () => {
  const created = await call('POST', '/api/groups', { name: 'E2E Study Group' });
  assert.strictEqual(created.status, 201);
  const invite = created.data.group.inviteCode;
  assert.strictEqual(created.data.group.active, false);
  assert.strictEqual(created.data.group.seatsNeededToActivate, 2);

  // Owner tries to pay with only themselves in the group.
  const tooEarly = await call('POST', '/api/billing/group', {});
  assert.strictEqual(tooEarly.status, 400);
  assert.match(tooEarly.data.error, /at least 3 members/);

  // Two friends join from their own sessions.
  const ownerCookie = cookie;
  for (const n of [2, 3]) {
    cookie = '';
    await call('POST', '/api/auth/signup', {
      displayName: `Friend ${n}`,
      email: `friend${n}@example.com`,
      password: 'a-good-long-password',
      birthYear: 2008,
      acceptTerms: true,
    });
    const joined = await call('POST', '/api/groups/join', { inviteCode: invite });
    assert.strictEqual(joined.status, 200, `friend ${n} could not join`);
  }

  cookie = ownerCookie;
  const activated = await call('POST', '/api/billing/group', {});
  assert.strictEqual(activated.status, 200);
  assert.strictEqual(activated.data.group.active, true);
  assert.strictEqual(activated.data.group.memberCount, 3);
});

check('group membership upgrades a free member', async () => {
  // Friend 3 is on the free plan personally but sits in an active group.
  cookie = '';
  await call('POST', '/api/auth/login', {
    email: 'friend3@example.com',
    password: 'a-good-long-password',
  });
  const me = await call('GET', '/api/me');
  assert.strictEqual(me.data.user.plan, 'group');
  assert.strictEqual(me.data.user.quota.limit, null, 'group member should be unlimited');

  const board = await call('GET', '/api/groups/me');
  assert.strictEqual(board.status, 200);
  assert.strictEqual(board.data.leaderboard.length, 3);
  assert.strictEqual(board.data.leaderboard[0].rank, 1);
});

check('logout ends the session', async () => {
  await call('POST', '/api/auth/logout');
  cookie = '';
  const { data } = await call('GET', '/api/me');
  assert.strictEqual(data.user, null);
});

check('stripe webhook is rejected while in demo mode', async () => {
  const { status } = await call('POST', '/api/webhooks/stripe', { type: 'checkout.session.completed' });
  assert.strictEqual(status, 400);
});

check('security headers are present on every response', async () => {
  const page = await fetch(`${BASE}/`);
  const apiRes = await fetch(`${BASE}/api/health`);
  for (const res of [page, apiRes]) {
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
    assert.ok(res.headers.get('content-security-policy'), 'missing CSP');
    assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
});

check('an answer is rejected if it was not the question issued', async () => {
  cookie = '';
  await call('POST', '/api/auth/signup', {
    displayName: 'Pin Test',
    email: 'pin@example.com',
    password: 'a-good-long-password',
    birthYear: 2008,
    acceptTerms: true,
    timezoneOffsetMinutes: 300,
    acceptTerms: true,
  });

  const { data: served } = await call('GET', '/api/quiz/next');
  const issuedId = served.question.id;

  // Answer a DIFFERENT question than the one issued.
  const otherId = issuedId === 'math-lin-001' ? 'math-lin-003' : 'math-lin-001';
  const wrongTarget = await call('POST', '/api/quiz/answer', { questionId: otherId, choice: 0 });
  assert.strictEqual(wrongTarget.status, 409, 'answering an unissued question should be refused');

  // The issued question still works.
  const correctTarget = await call('POST', '/api/quiz/answer', { questionId: issuedId, choice: 0 });
  assert.strictEqual(correctTarget.status, 200);

  // Replaying the same question to farm rating is refused.
  const replay = await call('POST', '/api/quiz/answer', { questionId: issuedId, choice: 0 });
  assert.strictEqual(replay.status, 409, 'replaying an answered question should be refused');
});

check('the chosen answer is persisted, not dropped', async () => {
  const { data: served } = await call('GET', '/api/quiz/next');
  const res = await call('POST', '/api/quiz/answer', { questionId: served.question.id, choice: 1 });
  assert.strictEqual(res.status, 200);

  const row = db.getDb()
    .prepare('SELECT chosen FROM attempts ORDER BY id DESC LIMIT 1')
    .get();
  assert.strictEqual(row.chosen, 1);
});

check('cross-origin state changes are rejected', async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ email: 'demo@x.com', password: 'whatever' }),
  });
  assert.strictEqual(res.status, 403);
});

check('repeated failed logins get rate limited', async () => {
  let sawLimit = false;
  for (let i = 0; i < 15; i++) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'nobody@example.com', password: `guess-${i}` }),
    });
    if (res.status === 429) {
      sawLimit = true;
      assert.ok(res.headers.get('retry-after'), 'missing Retry-After header');
      break;
    }
  }
  assert.ok(sawLimit, 'brute-force attempts were never throttled');
});

check('the full password reset flow works end to end', async () => {
  const mailer = require('../lib/mailer');
  // The suite creates more accounts than the signup limit allows from one IP,
  // which is the limiter working correctly. Clear it so later checks can run.
  ratelimit.reset();

  cookie = '';
  const signup = await call('POST', '/api/auth/signup', {
    displayName: 'Reset Test',
    email: 'resetme@example.com',
    password: 'original-password-1',
    birthYear: 2007,
    acceptTerms: true,
  });
  assert.strictEqual(signup.status, 201, `signup failed: ${JSON.stringify(signup.data)}`);

  // Log in from a second "device" so we can prove the reset kills it.
  const otherDevice = cookie;

  cookie = '';
  const requested = await call('POST', '/api/auth/request-reset', { email: 'resetme@example.com' });
  assert.strictEqual(requested.status, 200);
  assert.strictEqual(requested.data.mailMode, 'console');

  // Pull the token out of the email the app just "sent".
  const sent = mailer.outbox[mailer.outbox.length - 1];
  assert.strictEqual(sent.to, 'resetme@example.com');
  const token = sent.text.match(/token=([a-f0-9]+)/)[1];

  // The link should validate before the form is shown.
  const valid = await call('GET', `/api/auth/reset-valid?token=${token}`);
  assert.strictEqual(valid.data.valid, true);

  const reset = await call('POST', '/api/auth/reset', { token, password: 'a-new-better-password' });
  assert.strictEqual(reset.status, 200);
  assert.ok(reset.data.sessionsRevoked >= 1);

  // Old password rejected, new password accepted.
  cookie = '';
  const oldPw = await call('POST', '/api/auth/login', {
    email: 'resetme@example.com', password: 'original-password-1',
  });
  assert.strictEqual(oldPw.status, 401);

  cookie = '';
  const newPw = await call('POST', '/api/auth/login', {
    email: 'resetme@example.com', password: 'a-new-better-password',
  });
  assert.strictEqual(newPw.status, 200);

  // The other device's session must be dead.
  cookie = otherDevice;
  const stale = await call('GET', '/api/me');
  assert.strictEqual(stale.data.user, null, 'reset must log out existing sessions');
});

check('a reset link cannot be reused', async () => {
  const mailer = require('../lib/mailer');
  ratelimit.reset();
  cookie = '';
  await call('POST', '/api/auth/request-reset', { email: 'resetme@example.com' });
  const token = mailer.outbox[mailer.outbox.length - 1].text.match(/token=([a-f0-9]+)/)[1];

  const first = await call('POST', '/api/auth/reset', { token, password: 'password-number-three' });
  assert.strictEqual(first.status, 200);

  const replay = await call('POST', '/api/auth/reset', { token, password: 'attacker-password' });
  assert.strictEqual(replay.status, 400, 'a used reset link must not work again');
});

check('reset requests do not reveal whether an account exists', async () => {
  cookie = '';
  const real = await call('POST', '/api/auth/request-reset', { email: 'resetme@example.com' });
  const fake = await call('POST', '/api/auth/request-reset', { email: 'nobody-here@example.com' });
  assert.strictEqual(real.status, fake.status);
  assert.strictEqual(real.data.message, fake.data.message);
});

check('email verification works end to end', async () => {
  const mailer = require('../lib/mailer');
  ratelimit.reset();
  cookie = '';
  const signup = await call('POST', '/api/auth/signup', {
    displayName: 'Verify Test',
    email: 'verifyme@example.com',
    password: 'a-good-long-password',
    birthYear: 2007,
    acceptTerms: true,
  });
  assert.strictEqual(signup.status, 201, `signup failed: ${JSON.stringify(signup.data)}`);

  const me = await call('GET', '/api/me');
  assert.strictEqual(me.data.user.emailVerified, false);

  const sendRes = await call('POST', '/api/auth/send-verification', {});
  assert.strictEqual(sendRes.status, 200);

  const token = mailer.outbox[mailer.outbox.length - 1].text.match(/token=([a-f0-9]+)/)[1];
  const verified = await call('POST', '/api/auth/verify', { token });
  assert.strictEqual(verified.status, 200);

  const after = await call('GET', '/api/me');
  assert.strictEqual(after.data.user.emailVerified, true);
});

check('health endpoint exposes monitoring counters', async () => {
  const { status, data } = await call('GET', '/api/health');
  assert.strictEqual(status, 200);
  assert.ok(data.questions >= 1000, `expected 1000+ questions, got ${data.questions}`);
  assert.strictEqual(data.mailMode, 'console');
  assert.ok(Number.isInteger(data.requests));
  assert.ok(Number.isInteger(data.errors));
  assert.ok(typeof data.uptimeSeconds === 'number');
});

/* AP exam routes.
 *
 * These exist because the unit tests exercise lib/apexam.js directly and so
 * never touch the HTTP layer. A typo in the route handler (calling readJson
 * instead of readJsonBody) shipped a 500 on every grade request while the unit
 * suite stayed green. */
check('AP exam routes are gated, then work end to end', async () => {
  const email = `ap-${Date.now()}@example.com`;
  let r = await call('POST', '/api/auth/signup', {
    displayName: 'AP Tester', email, password: 'correct-horse-battery',
    birthYear: 2009, timezoneOffsetMinutes: 0, acceptTerms: true,
  });
  assert.strictEqual(r.status, 201, 'signup failed');

  r = await call('POST', '/api/onboarding', {
    gradeLevel: 11, courseIds: ['ap-biology'], goal: 'exams',
  });
  assert.strictEqual(r.status, 200, 'onboarding failed');

  // Free plan must not reach the exam.
  r = await call('GET', '/api/ap/exam?courseId=ap-biology');
  assert.strictEqual(r.status, 402, `expected 402 for a free user, got ${r.status}`);

  r = await call('POST', '/api/billing/premium', {});
  assert.strictEqual(r.status, 200, 'upgrade failed');

  r = await call('GET', '/api/ap/exam?courseId=ap-biology&mcqLimit=5');
  assert.strictEqual(r.status, 200, `exam fetch returned ${r.status}`);
  const exam = r.data.exam;
  assert.strictEqual(exam.verified, true);
  assert.ok(exam.source.includes('collegeboard.org'), 'must cite the official source');

  const mcq = exam.sections.find((x) => x.kind === 'mcq');
  assert.ok(mcq.servedCount > 0, 'no questions served');
  assert.strictEqual(mcq.officialCount, 60, 'must report the real Section I length');

  const answers = {};
  for (const q of mcq.questions) answers[q.id] = 0;
  r = await call('POST', '/api/ap/grade-mcq', { courseId: 'ap-biology', answers });
  assert.strictEqual(r.status, 200, `grade-mcq returned ${r.status}`);
  assert.strictEqual(r.data.total, mcq.servedCount);
  assert.ok(/^\d-\d$/.test(r.data.estimate.band), 'estimate must be a band');
});

check('FRQ checking reports facts and never a score', async () => {
  const r = await call('POST', '/api/ap/check-frq', {
    text: 'Although limited, the reforms mattered.\n\nDocument 1 and Doc 2 show this.\n\nTherefore it changed.',
    checks: ['thesis', 'length:400', 'documents:2', 'paragraphs:3'],
  });
  assert.strictEqual(r.status, 200, `check-frq returned ${r.status}`);
  assert.strictEqual(r.data.paragraphs, 3);

  const docs = r.data.checks.find((c) => c.kind === 'Document citations');
  assert.ok(docs.pass, 'should have counted 2 documents');
  const len = r.data.checks.find((c) => c.kind === 'Length');
  assert.strictEqual(len.pass, false, 'a short answer must fail the length check');

  for (const c of r.data.checks) {
    assert.ok(!('score' in c) && !('points' in c),
      'auto-checks must never emit anything score-shaped');
  }
  assert.strictEqual(r.data.checks.find((c) => c.kind.startsWith('Thesis')).hint, true,
    'the thesis check must declare itself a hint');
});

check('an unverified AP course is refused rather than guessed', async () => {
  const r = await call('GET', '/api/ap/exam?courseId=ap-art-history');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.exam.verified, false);
  assert.ok(!r.data.exam.sections, 'must not fabricate a format');
});

check('free tier gets separate Learn and Review allowances', async () => {
  const email = `quota-${Date.now()}@example.com`;
  let r = await call('POST', '/api/auth/signup', {
    displayName: 'Quota Tester', email, password: 'correct-horse-battery',
    birthYear: 2009, timezoneOffsetMinutes: 0, acceptTerms: true,
  });
  assert.strictEqual(r.status, 201);
  await call('POST', '/api/onboarding', { gradeLevel: 11, courseIds: ['hs-biology'], goal: 'grades' });

  // Learn is the shorter allowance.
  r = await call('GET', '/api/quiz/next');
  assert.strictEqual(r.status, 200);
  const learnLimit = r.data.quota.limit;
  assert.strictEqual(learnLimit, 3, `expected a 3-question Learn allowance, got ${learnLimit}`);

  // Burn Learn completely.
  for (let i = 0; i < learnLimit; i++) {
    const nx = await call('GET', '/api/quiz/next');
    if (nx.status !== 200) break;
    await call('POST', '/api/quiz/answer', { questionId: nx.data.question.id, choice: 0, mode: 'learn' });
  }
  r = await call('GET', '/api/quiz/next');
  assert.strictEqual(r.status, 402, 'Learn should be exhausted');

  // Review must still be reachable: its allowance is separate.
  r = await call('GET', '/api/modes/review');
  assert.strictEqual(r.status, 200,
    `Review must not be consumed by Learn, got ${r.status}`);
  assert.strictEqual(r.data.quota.limit, 5, 'Review allowance should be 5');
  assert.ok(r.data.quota.remaining > 0, 'Review should have questions left');
});

check('review is metered, not locked, for free users', async () => {
  const email = `rev-${Date.now()}@example.com`;
  await call('POST', '/api/auth/signup', {
    displayName: 'Rev', email, password: 'correct-horse-battery',
    birthYear: 2009, timezoneOffsetMinutes: 0, acceptTerms: true,
  });
  await call('POST', '/api/onboarding', { gradeLevel: 11, courseIds: ['hs-biology'], goal: 'grades' });

  const r = await call('GET', '/api/modes/review');
  assert.strictEqual(r.status, 200, 'free users must reach Review');

  // AP exam stays fully paywalled.
  const ap = await call('GET', '/api/ap/exam?courseId=ap-biology');
  assert.strictEqual(ap.status, 402, 'AP exam must stay locked for free users');
});

check('switching plans actually changes what you can reach', async () => {
  const email = `plan-${Date.now()}@example.com`;
  let r = await call('POST', '/api/auth/signup', {
    displayName: 'Plan Tester', email, password: 'correct-horse-battery',
    birthYear: 2009, timezoneOffsetMinutes: 0, acceptTerms: true,
  });
  assert.strictEqual(r.status, 201);
  await call('POST', '/api/onboarding', { gradeLevel: 11, courseIds: ['hs-biology'], goal: 'grades' });

  // Free: a premium mode is refused.
  r = await call('GET', '/api/modes/match');
  assert.strictEqual(r.status, 402, 'free plan should be refused');

  // Premium unlocks it, and the response carries a refreshed user so the UI
  // does not keep showing stale free-tier limits.
  r = await call('POST', '/api/billing/premium', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.plan, 'premium');
  assert.strictEqual(r.data.user.quota.limit, null, 'premium quota must be unlimited');

  r = await call('GET', '/api/modes/match');
  assert.strictEqual(r.status, 200, 'premium should reach match');

  // Cancelling must put the gate back.
  r = await call('POST', '/api/billing/cancel', {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.user.plan, 'free');
  r = await call('GET', '/api/modes/match');
  assert.strictEqual(r.status, 402, 'cancelling must re-lock premium modes');
});

check('the legal documents are actually served', async () => {
  // Regression guard for a real outage: the Dockerfile did not copy legal/, so
  // /api/legal returned 404 in production for every request while passing
  // locally. This asserts real content comes back, not just a 200.
  for (const doc of ['terms', 'privacy']) {
    const { status, data } = await call('GET', `/api/legal?doc=${doc}`);
    assert.strictEqual(status, 200, `/api/legal?doc=${doc} returned ${status}`);
    assert.ok(data.markdown && data.markdown.length > 500,
      `${doc} came back empty or truncated`);
    assert.ok(/whetstone/i.test(data.markdown), `${doc} does not look like our document`);
  }
});

check('the legal directory ships with the app', async () => {
  const fsx = require('node:fs');
  const pathx = require('node:path');
  for (const f of ['TERMS.md', 'PRIVACY.md']) {
    assert.ok(fsx.existsSync(pathx.join(__dirname, '..', 'legal', f)),
      `legal/${f} is missing from the build`);
  }
});

check('the reset and verify pages are served', async () => {
  for (const route of ['/reset?token=abc', '/verify?token=abc']) {
    const res = await fetch(`${BASE}${route}`);
    assert.strictEqual(res.status, 200, `${route} returned ${res.status}`);
    assert.ok((await res.text()).includes('Whetstone'));
  }
});

check('path traversal on static files is blocked', async () => {
  const res = await fetch(`${BASE}/../lib/config.js`);
  assert.ok(res.status === 403 || res.status === 404, `expected block, got ${res.status}`);
  const body = await res.text();
  assert.ok(!body.includes('SESSION_SECRET'), 'leaked a server file');
});

// ---------------------------------------------------------------------------

(async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`\nWhetstone end-to-end test  (${BASE})\n`);

  let failed = 0;
  for (const { label, fn } of checks) {
    try {
      await fn();
      passed++;
      console.log(`  PASS  ${label}`);
    } catch (err) {
      failed++;
      console.log(`  FAIL  ${label}`);
      console.log(`        ${err.message}`);
    }
  }

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('-'.repeat(52) + '\n');

  server.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
  }
  process.exit(failed > 0 ? 1 : 0);
})();
