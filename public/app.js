'use strict';

/* Whetstone front end. Vanilla JS, no build step, no framework. */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  user: null,
  view: 'landing',
  scope: { courseId: null, courseName: null, unit: null },
  question: null,
  answered: false,
  flash: { cards: [], index: 0, flipped: false },
  match: { tiles: [], picked: null, matched: 0, pairs: 0, start: 0, timer: null, locked: false },
  test: { questions: [], index: 0, answers: {}, start: 0 },
  onboarding: { grade: null, courses: new Set(), goal: null },
  catalog: null,
};

// ------------------------------------------------------------------ helpers
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function levelPill(levelLabel) {
  const key = String(levelLabel || 'Regular').toLowerCase().replace(/\s+/g, '-');
  return `<span class="pill pill-${key}">${esc(levelLabel)}</span>`;
}

// ------------------------------------------------------------------ routing
function showView(name) {
  state.view = name;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $(`#view-${name}`);
  if (el) el.classList.remove('hidden');
  $$('.nav-btn, .mobile-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (name === 'home') renderHome();
  if (name === 'courses') loadCourses();
  if (name === 'progress') loadDashboard();
  if (name === 'group') { loadGroup(); loadChannels(); loadMessages(); startChatPolling(); }
  else stopChatPolling();
  if (name === 'plan') loadPlan();
  if (name === 'settings') loadSettings();
}

function renderChrome() {
  const signedIn = Boolean(state.user);
  $('#nav').classList.toggle('hidden', !signedIn);
  $('#mobile-nav').classList.toggle('hidden', !signedIn);
  $('#avatar').classList.toggle('hidden', !signedIn);
  if (signedIn) {
    $('#avatar').textContent = (state.user.displayName || '?').charAt(0).toUpperCase();
  }
}

$$('.nav-btn, .mobile-nav button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});
$$('[data-back]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.back)));
$('#avatar').addEventListener('click', () => showView('plan'));

// ------------------------------------------------------------------ auth
function authError(msg, target = '#auth-error') {
  const e = $(target);
  e.textContent = msg;
  e.classList.remove('hidden');
}

$('#go-signin').addEventListener('click', () => showView('signin'));
$('#go-signup').addEventListener('click', () => showView('landing'));

$('#signup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    if (!$('#accept-terms').checked) {
      authError('You need to accept the Terms of Service and Privacy Policy.');
      return;
    }
    const { user } = await api('POST', '/api/auth/signup', {
      displayName: f.get('displayName'), email: f.get('email'),
      password: f.get('password'), birthYear: Number(f.get('birthYear')),
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
      acceptTerms: true,
    });
    state.user = user;
    renderChrome();
    startOnboarding();
  } catch (err) { authError(err.message); }
});

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { user } = await api('POST', '/api/auth/login', { email: f.get('email'), password: f.get('password') });
    state.user = user;
    renderChrome();
    showView(user.onboarded ? 'home' : 'onboarding');
    if (!user.onboarded) startOnboarding();
  } catch (err) { authError(err.message, '#signin-error'); }
});

$('#logout-btn').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  state.user = null;
  renderChrome();
  showView('landing');
});

$('#forgot-link').addEventListener('click', () => {
  $('#login-form').classList.add('hidden'); $('#forgot-form').classList.remove('hidden');
  $('#signin-error').classList.add('hidden');
});
$('#forgot-cancel').addEventListener('click', () => {
  $('#forgot-form').classList.add('hidden'); $('#login-form').classList.remove('hidden');
  $('#auth-notice').classList.add('hidden');
});
$('#forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const data = await api('POST', '/api/auth/request-reset', { email: new FormData(e.target).get('email') });
    const n = $('#auth-notice');
    n.textContent = data.mailMode === 'console'
      ? `${data.message} (Demo mode: the link is printed in the server terminal.)`
      : data.message;
    n.classList.remove('hidden');
    $('#signin-error').classList.add('hidden');
  } catch (err) { authError(err.message, '#signin-error'); }
});

// ------------------------------------------------------------------ onboarding
const GRADES = [
  { v: 9, t: '9th', s: 'Freshman' }, { v: 10, t: '10th', s: 'Sophomore' },
  { v: 11, t: '11th', s: 'Junior' }, { v: 12, t: '12th', s: 'Senior' },
  { v: 13, t: 'College', s: '1st year' }, { v: 14, t: 'College', s: '2nd year' },
  { v: 15, t: 'College', s: '3rd year' }, { v: 16, t: 'College', s: '4th year' },
];
const GOALS = [
  { v: 'grades', t: 'Class grades', s: 'Tests and quizzes' },
  { v: 'ap', t: 'AP exams', s: 'May exam scores' },
  { v: 'sat', t: 'SAT / ACT', s: 'College admissions' },
  { v: 'mastery', t: 'Just learn it', s: 'Long-term retention' },
];

function startOnboarding() {
  showView('onboarding');
  $('#ob-step-1').classList.remove('hidden');
  $('#ob-step-2').classList.add('hidden');
  $('#ob-step-3').classList.add('hidden');

  $('#grade-choices').innerHTML = GRADES.map((g) => `
    <button class="choice" data-grade="${g.v}">
      <span class="choice-title">${g.t}</span><span class="choice-sub">${g.s}</span>
    </button>`).join('');
  $$('#grade-choices .choice').forEach((b) => b.addEventListener('click', () => {
    $$('#grade-choices .choice').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
    state.onboarding.grade = Number(b.dataset.grade);
    $('#ob-next-1').disabled = false;
  }));

  $('#goal-choices').innerHTML = GOALS.map((g) => `
    <button class="choice" data-goal="${g.v}">
      <span class="choice-title">${g.t}</span><span class="choice-sub">${g.s}</span>
    </button>`).join('');
  $$('#goal-choices .choice').forEach((b) => b.addEventListener('click', () => {
    $$('#goal-choices .choice').forEach((x) => x.classList.remove('selected'));
    b.classList.add('selected');
    state.onboarding.goal = b.dataset.goal;
    $('#ob-finish').disabled = false;
  }));
}

function setSteps(n) {
  $$('.step-dot').forEach((d, i) => d.classList.toggle('done', i < n));
}

$('#ob-next-1').addEventListener('click', async () => {
  setSteps(2);
  $('#ob-step-1').classList.add('hidden');
  $('#ob-step-2').classList.remove('hidden');
  const { courses } = await api('GET', `/api/courses/suggested?grade=${state.onboarding.grade}`);
  state.catalog = courses;
  renderObCourses(courses);
});

function renderObCourses(list) {
  $('#ob-courses').innerHTML = list.length === 0
    ? '<p class="muted">No courses matched.</p>'
    : list.map((c) => `
      <button class="course-row${state.onboarding.courses.has(c.id) ? ' selected' : ''}" data-id="${esc(c.id)}">
        <span class="course-check">✓</span>
        <span class="course-row-name">${esc(c.name)}</span>
        ${levelPill(c.levelLabel)}
      </button>`).join('');

  $$('#ob-courses .course-row').forEach((b) => b.addEventListener('click', () => {
    const id = b.dataset.id;
    if (state.onboarding.courses.has(id)) state.onboarding.courses.delete(id);
    else state.onboarding.courses.add(id);
    b.classList.toggle('selected');
    const n = state.onboarding.courses.size;
    $('#ob-count').textContent = n === 0 ? '' : `${n} selected`;
    $('#ob-next-2').disabled = n === 0;
  }));
}

$('#ob-search').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  if (!q) return renderObCourses(state.catalog || []);
  const { groups } = await api('GET', `/api/courses?search=${encodeURIComponent(q)}`);
  renderObCourses(groups.flatMap((g) => g.courses));
});

$('#ob-back-2').addEventListener('click', () => {
  setSteps(1);
  $('#ob-step-2').classList.add('hidden'); $('#ob-step-1').classList.remove('hidden');
});
$('#ob-next-2').addEventListener('click', () => {
  setSteps(3);
  $('#ob-step-2').classList.add('hidden'); $('#ob-step-3').classList.remove('hidden');
});
$('#ob-back-3').addEventListener('click', () => {
  setSteps(2);
  $('#ob-step-3').classList.add('hidden'); $('#ob-step-2').classList.remove('hidden');
});

$('#ob-finish').addEventListener('click', async () => {
  try {
    const { user } = await api('POST', '/api/onboarding', {
      gradeLevel: state.onboarding.grade,
      courseIds: [...state.onboarding.courses],
      goal: state.onboarding.goal,
    });
    state.user = user;
    renderChrome();
    showView('home');
    toast('You are all set. Pick a study mode.', 'good');
  } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ home
function scopeLabel() {
  if (state.scope.unit) return `${state.scope.courseName} · ${state.scope.unit}`;
  if (state.scope.courseId) return state.scope.courseName;
  return null;
}

async function renderHome() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#home-greeting').textContent = `${greet}, ${state.user.displayName}`;

  const q = state.user.quota;
  $('#home-sub').textContent = q.limit === null
    ? `${state.user.planLabel} · unlimited practice`
    : `${q.remaining} of ${q.limit} free questions left today`;

  const banner = $('#scope-banner');
  const label = scopeLabel();
  if (label) {
    banner.innerHTML = `<span>Studying <strong>${esc(label)}</strong></span>
      <button class="linkish" id="clear-scope" style="margin-left:auto">Study everything instead</button>`;
    banner.classList.remove('hidden');
    $('#clear-scope').addEventListener('click', () => {
      state.scope = { courseId: null, courseName: null, unit: null };
      renderHome();
    });
  } else {
    banner.classList.add('hidden');
  }

  // Stat strip. The top of the app looked empty with just a greeting; these
  // give an at-a-glance reason to keep going.
  try {
    const { report } = await api('GET', '/api/dashboard');
    const t = report.totals;
    $('#home-stats').innerHTML = `
      <div class="mini-stat">
        <span class="mini-stat-icon" style="background:var(--good-soft);color:var(--good)">✓</span>
        <span><span class="mini-stat-value">${t.overallAccuracy === null ? '—' : t.overallAccuracy + '%'}</span>
        <span class="mini-stat-label">Accuracy</span></span>
      </div>
      <div class="mini-stat">
        <span class="mini-stat-icon" style="background:var(--accent-soft);color:#b9aeff">◎</span>
        <span><span class="mini-stat-value">${t.totalAttempts}</span>
        <span class="mini-stat-label">Answered</span></span>
      </div>
      <div class="mini-stat">
        <span class="mini-stat-icon" style="background:#fb923c22;color:#fbbf24">★</span>
        <span><span class="mini-stat-value">${t.topicsMastered}</span>
        <span class="mini-stat-label">Mastered</span></span>
      </div>
      <div class="mini-stat">
        <span class="mini-stat-icon" style="background:var(--bad-soft);color:var(--bad)">↻</span>
        <span><span class="mini-stat-value">${report.weakSpots.length}</span>
        <span class="mini-stat-label">Weak spots</span></span>
      </div>`;
  } catch { $('#home-stats').innerHTML = ''; }

  try {
    const { courses } = await api('GET', '/api/my-courses');
    $('#home-course-count').textContent = courses.length;
    $('#home-courses').innerHTML = courses.length === 0
      ? `<div class="card empty-state"><span class="empty-emoji">▦</span>
         <h3>No courses yet</h3><p class="muted">Add your classes to practice by unit.</p></div>`
      : courses.map((c) => `
        <button class="course-card course-open" data-id="${esc(c.course.id)}">
          <div class="row-between" style="align-items:flex-start">
            <div style="min-width:0">
              <h3>${esc(c.course.name)}</h3>
              <div class="course-meta">${c.totals.unitsWithContent} of ${c.totals.units} units ready · ${c.totals.questions} questions</div>
            </div>
            ${levelPill(c.course.levelLabel)}
          </div>
          <div class="progress-mini"><span style="width:${c.totals.coveragePercent}%"></span></div>
        </button>`).join('');
    $$('.course-open').forEach((b) => b.addEventListener('click', () => openCourse(b.dataset.id)));
  } catch { /* signed out */ }

  loadSets();
}

async function loadSets() {
  try {
    const { sets } = await api('GET', '/api/sets');
    $('#home-set-count').textContent = sets.length;
    $('#home-sets').innerHTML = sets.length === 0
      ? `<div class="card empty-state"><span class="empty-emoji">✎</span>
         <h3>No study sets yet</h3><p class="muted">Make your own flashcards for anything the course banks do not cover.</p></div>`
      : sets.map((s) => `
        <div class="set-card">
          <span class="set-icon">✎</span>
          <div style="flex:1;min-width:0">
            <strong>${esc(s.title)}</strong>
            <div class="dim">${s.cardCount} cards${s.courseName ? ` · ${esc(s.courseName)}` : ''}</div>
          </div>
          <button class="btn btn-sm set-study" data-id="${s.id}">Study</button>
          <button class="btn btn-sm btn-ghost set-edit" data-id="${s.id}">Edit</button>
        </div>`).join('');

    $$('.set-edit').forEach((b) => b.addEventListener('click', () => openSetEditor(Number(b.dataset.id))));
    $$('.set-study').forEach((b) => b.addEventListener('click', () => studySet(Number(b.dataset.id))));
  } catch { /* signed out */ }
}

$$('.mode-card').forEach((b) => b.addEventListener('click', () => startMode(b.dataset.mode)));

function startMode(mode) {
  if (mode === 'learn') { showView('learn'); loadQuestion(); }
  else if (mode === 'flashcards') startFlashcards();
  else if (mode === 'match') startMatch();
  else if (mode === 'test') startTest();
  else if (mode === 'review') startReview();
}

// ------------------------------------------------------------------ learn
function scopeQuery() {
  const p = new URLSearchParams();
  if (state.scope.courseId) p.set('courseId', state.scope.courseId);
  if (state.scope.unit) p.set('unit', state.scope.unit);
  return p.toString() ? `?${p}` : '';
}

function renderBreadcrumb(el, q) {
  const parts = [];
  if (q.courseName || q.course) parts.push(`<span class="crumb-course">${esc(q.courseName || q.course)}</span>`);
  else parts.push(`<span class="crumb-course">${esc(q.subject)}</span>`);
  if (q.unit && q.unit !== q.topic) parts.push(`<span class="sep">›</span><span>${esc(q.unit)}</span>`);
  else if (q.topic) parts.push(`<span class="sep">›</span><span>${esc(q.topic)}</span>`);
  el.innerHTML = parts.join('');
}

async function loadQuestion() {
  $('#q-feedback').classList.add('hidden');
  $('#next-btn').classList.add('hidden');
  state.answered = false;

  try {
    const data = await api('GET', `/api/quiz/next${scopeQuery()}`);
    state.question = data.question;
    $('#quiz-empty').classList.add('hidden');
    $('#quiz-card').classList.remove('hidden');

    renderBreadcrumb($('#q-breadcrumb'), data.question);
    const d = $('#q-difficulty');
    d.textContent = data.question.difficulty;
    d.className = `chip chip-${data.question.difficulty}`;

    $('#q-prompt').textContent = data.question.prompt;
    $('#quota-note').textContent = data.quota.limit === null
      ? '' : `${data.quota.remaining} left today`;

    const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
    $('#q-choices').innerHTML = data.question.choices.map((c, i) => `
      <button class="choice-btn" data-i="${i}">
        <span class="choice-key">${keys[i]}</span><span>${esc(c)}</span>
      </button>`).join('');
    $$('#q-choices .choice-btn').forEach((b) =>
      b.addEventListener('click', () => submitAnswer(Number(b.dataset.i))));
  } catch (err) {
    $('#quiz-card').classList.add('hidden');
    $('#quiz-empty').classList.remove('hidden');
    if (err.status === 402) {
      $('#quiz-empty-title').textContent = 'Daily limit reached';
      $('#quiz-empty-msg').textContent = 'You have used your free questions for today. Upgrade for unlimited practice, or come back tomorrow.';
    } else {
      $('#quiz-empty-title').textContent = 'Nothing here yet';
      $('#quiz-empty-msg').textContent = err.message;
    }
  }
}

async function submitAnswer(choice) {
  if (state.answered || !state.question) return;
  state.answered = true;
  try {
    const data = await api('POST', '/api/quiz/answer', { questionId: state.question.id, choice });

    $$('#q-choices .choice-btn').forEach((b) => {
      const i = Number(b.dataset.i);
      b.disabled = true;
      if (i === data.correctChoice) b.classList.add('correct');
      else if (i === choice) b.classList.add('wrong');
    });

    const p = data.progress;
    const next = p.nextReviewMinutes === 0 ? 'coming right back'
      : p.nextReviewMinutes < 60 ? `back in ~${p.nextReviewMinutes} min`
        : `back in ~${Math.round(p.nextReviewMinutes / 60)} hr`;

    const fb = $('#q-feedback');
    fb.className = `feedback ${data.correct ? 'is-correct' : 'is-wrong'}`;
    fb.innerHTML = `
      <div class="feedback-head">${data.correct ? '✓ Correct' : '✕ Not quite'}</div>
      <div class="feedback-body">${esc(data.explanation)}</div>
      <div class="delta">
        <span>${esc(p.topic)} <b class="${p.abilityDelta >= 0 ? 'up' : 'down'}">${p.abilityDelta >= 0 ? '+' : ''}${p.abilityDelta}</b></span>
        <span>Mastery <b>${p.masteryPercent}%</b></span>
        <span>This topic is ${next}</span>
        ${p.streak > 1 ? `<span><b>${p.streak}</b> in a row</span>` : ''}
      </div>`;
    fb.classList.remove('hidden');
    $('#next-btn').classList.remove('hidden');
    $('#next-btn').focus();
    $('#quota-note').textContent = data.quota.limit === null ? '' : `${data.quota.remaining} left today`;
    if (state.user) state.user.quota = data.quota;
  } catch (err) {
    state.answered = false;
    if (err.status === 409) { toast('That question expired. Here is a fresh one.'); loadQuestion(); return; }
    toast(err.message, 'bad');
  }
}

$('#next-btn').addEventListener('click', loadQuestion);

// ------------------------------------------------------------------ flashcards
async function startFlashcards() {
  showView('flashcards');
  try {
    const { cards } = await api('GET', `/api/modes/flashcards${scopeQuery()}`);
    if (cards.length === 0) { toast('No flashcards for this selection yet.', 'bad'); showView('home'); return; }
    state.flash = { cards, index: 0, flipped: false };
    renderFlash();
  } catch (err) { toast(err.message, 'bad'); showView('home'); }
}

function renderFlash() {
  const { cards, index } = state.flash;
  const card = cards[index];
  if (!card) return;
  $('#flash-front').textContent = card.front;
  $('#flash-back').textContent = card.back;
  $('#flash-card').classList.toggle('flipped', state.flash.flipped);
  $('#flash-counter').textContent = `${index + 1} of ${cards.length}`;
  $('#flash-progress').style.width = `${((index + 1) / cards.length) * 100}%`;
  $('#flash-prev').disabled = index === 0;
  $('#flash-next').textContent = index === cards.length - 1 ? 'Finish' : 'Next →';
}

function flipCard() { state.flash.flipped = !state.flash.flipped; renderFlash(); }
$('#flash-card').addEventListener('click', flipCard);
$('#flash-prev').addEventListener('click', () => {
  if (state.flash.index > 0) { state.flash.index--; state.flash.flipped = false; renderFlash(); }
});
$('#flash-next').addEventListener('click', () => {
  if (state.flash.index < state.flash.cards.length - 1) {
    state.flash.index++; state.flash.flipped = false; renderFlash();
  } else { toast('Deck complete.', 'good'); showView('home'); }
});

// ------------------------------------------------------------------ match
async function startMatch() {
  showView('match');
  $('#match-done').classList.add('hidden');
  $('#match-grid').classList.remove('hidden');
  try {
    const data = await api('GET', `/api/modes/match${scopeQuery()}`);
    state.match = {
      tiles: data.tiles, picked: null, matched: 0, pairs: data.pairs,
      start: Date.now(), timer: null, locked: false,
    };
    $('#match-best').textContent = data.bestMs ? `Best: ${(data.bestMs / 1000).toFixed(1)}s` : '';
    renderMatch();
    state.match.timer = setInterval(() => {
      $('#match-timer').textContent = ((Date.now() - state.match.start) / 1000).toFixed(1);
    }, 100);
  } catch (err) { toast(err.message, 'bad'); showView('home'); }
}

function renderMatch() {
  $('#match-grid').innerHTML = state.match.tiles.map((t) => `
    <button class="match-tile ${t.kind === 'term' ? 'is-term' : ''}" data-id="${esc(t.id)}" data-pair="${esc(t.pairId)}">
      ${esc(t.text)}
    </button>`).join('');
  $$('#match-grid .match-tile').forEach((b) => b.addEventListener('click', () => pickTile(b)));
}

function pickTile(el) {
  const m = state.match;
  if (m.locked || el.classList.contains('matched') || el === m.picked) return;

  if (!m.picked) { m.picked = el; el.classList.add('picked'); return; }

  if (m.picked.dataset.pair === el.dataset.pair) {
    el.classList.add('matched'); m.picked.classList.add('matched');
    m.picked = null; m.matched++;
    if (m.matched === m.pairs) finishMatch();
  } else {
    const first = m.picked;
    el.classList.add('miss'); first.classList.add('miss');
    m.locked = true;
    setTimeout(() => {
      el.classList.remove('miss'); first.classList.remove('miss', 'picked');
      m.picked = null; m.locked = false;
    }, 400);
  }
}

async function finishMatch() {
  clearInterval(state.match.timer);
  const durationMs = Date.now() - state.match.start;
  $('#match-grid').classList.add('hidden');
  $('#match-done').classList.remove('hidden');
  $('#match-result-time').textContent = `${(durationMs / 1000).toFixed(1)} seconds`;
  try {
    const r = await api('POST', '/api/modes/match/complete', {
      durationMs, pairs: state.match.pairs,
      courseId: state.scope.courseId, unit: state.scope.unit,
    });
    $('#match-result-note').textContent = r.isPersonalBest
      ? 'New personal best.'
      : `Your best is ${(r.previousBest / 1000).toFixed(1)}s.`;
  } catch { $('#match-result-note').textContent = ''; }
}
$('#match-again').addEventListener('click', startMatch);

// ------------------------------------------------------------------ test
async function startTest() {
  showView('test');
  $('#test-results').classList.add('hidden');
  $('#test-active').classList.remove('hidden');
  try {
    const { questions } = await api('GET', `/api/modes/test${scopeQuery()}`);
    state.test = { questions, index: 0, answers: {}, start: Date.now() };
    renderTest();
  } catch (err) { toast(err.message, 'bad'); showView('home'); }
}

function renderTest() {
  const { questions, index, answers } = state.test;
  const q = questions[index];
  if (!q) return;

  renderBreadcrumb($('#test-breadcrumb'), q);
  const d = $('#test-difficulty');
  d.textContent = q.difficulty; d.className = `chip chip-${q.difficulty}`;
  $('#test-prompt').textContent = q.prompt;
  $('#test-counter').textContent = `Question ${index + 1} of ${questions.length}`;
  $('#test-progress').style.width = `${((index + 1) / questions.length) * 100}%`;

  const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
  $('#test-choices').innerHTML = q.choices.map((c, i) => `
    <button class="choice-btn${answers[q.id] === i ? ' correct' : ''}" data-i="${i}">
      <span class="choice-key">${keys[i]}</span><span>${esc(c)}</span>
    </button>`).join('');
  $$('#test-choices .choice-btn').forEach((b) => b.addEventListener('click', () => {
    state.test.answers[q.id] = Number(b.dataset.i);
    renderTest();
  }));

  $('#test-prev').disabled = index === 0;
  $('#test-next').textContent = index === questions.length - 1 ? 'Submit test' : 'Next →';
}

$('#test-prev').addEventListener('click', () => {
  if (state.test.index > 0) { state.test.index--; renderTest(); }
});
$('#test-next').addEventListener('click', async () => {
  const { questions, index } = state.test;
  if (index < questions.length - 1) { state.test.index++; renderTest(); return; }

  try {
    const graded = await api('POST', '/api/modes/test/grade', {
      answers: state.test.answers,
      courseId: state.scope.courseId, unit: state.scope.unit,
      durationMs: Date.now() - state.test.start,
    });
    $('#test-active').classList.add('hidden');
    $('#test-results').classList.remove('hidden');
    $('#test-results').innerHTML = `
      <div class="card center card-pad-lg">
        <div class="stat-value" style="font-size:3.2rem">${graded.percent}%</div>
        <p class="muted">${graded.correct} of ${graded.total} correct</p>
        <button class="btn btn-primary" data-back="home">Back to study</button>
      </div>
      ${graded.results.map((r) => `
        <div class="card">
          <div class="row" style="gap:.5rem;margin-bottom:.5rem">
            <span class="chip ${r.correct ? 'chip-easy' : 'chip-hard'}">${r.correct ? 'Correct' : 'Missed'}</span>
            <span class="dim">${esc(r.topic)}</span>
          </div>
          <p style="white-space:pre-wrap;font-weight:500">${esc(r.prompt)}</p>
          <p class="dim">Correct answer: <strong style="color:var(--good)">${esc(r.choices[r.correctChoice])}</strong></p>
          <p class="muted" style="font-size:.9rem;margin:0">${esc(r.explanation)}</p>
        </div>`).join('')}`;
    $$('#test-results [data-back]').forEach((b) => b.addEventListener('click', () => showView('home')));
  } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ review
async function startReview() {
  try {
    const { questions } = await api('GET', '/api/modes/review');
    if (questions.length === 0) {
      toast('Nothing to review yet. Miss a few questions first.', '');
      return;
    }
    state.test = { questions, index: 0, answers: {}, start: Date.now() };
    showView('test');
    $('#test-results').classList.add('hidden');
    $('#test-active').classList.remove('hidden');
    renderTest();
  } catch (err) { toast(err.message, 'bad'); }
}

// ------------------------------------------------------------------ courses
async function loadCourses() {
  $('#course-detail').classList.add('hidden');
  $('#course-browse').classList.remove('hidden');
  const { groups, stats } = await api('GET', '/api/courses');
  $('#catalog-stats').textContent = `${stats.courses} courses · ${stats.units} units mapped`;
  renderCourseGroups(groups);
}

function renderCourseGroups(groups) {
  $('#course-groups').innerHTML = groups.map((g) => `
    <div class="card">
      <h2>${esc(g.category)}</h2>
      <div class="stack" style="gap:.4rem;margin-top:.75rem">
        ${g.courses.map((c) => `
          <button class="course-row course-open" data-id="${esc(c.id)}">
            <span class="course-row-name">${esc(c.name)}</span>
            <span class="dim">${c.units.length} units</span>
            ${levelPill(c.levelLabel)}
          </button>`).join('')}
      </div>
    </div>`).join('');
  $$('#course-groups .course-open').forEach((b) =>
    b.addEventListener('click', () => openCourse(b.dataset.id)));
}

$('#course-search').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  const { groups } = await api('GET', `/api/courses${q ? `?search=${encodeURIComponent(q)}` : ''}`);
  renderCourseGroups(groups);
});

async function openCourse(courseId) {
  showView('courses');
  const data = await api('GET', `/api/course?id=${encodeURIComponent(courseId)}`);
  $('#course-browse').classList.add('hidden');
  $('#course-detail').classList.remove('hidden');

  $('#cd-name').textContent = data.course.name;
  $('#cd-level').outerHTML = levelPill(data.course.levelLabel).replace('<span', '<span id="cd-level"');
  $('#cd-coverage').textContent =
    `${data.totals.unitsWithContent} of ${data.totals.units} units have questions · ${data.totals.questions} total`;

  $('#cd-units').innerHTML = data.units.map((u) => `
    <button class="unit-row${u.questions === 0 ? ' empty' : ''}" data-unit="${esc(u.name)}" ${u.questions === 0 ? 'disabled' : ''}>
      <span class="unit-num">${u.order}</span>
      <span class="unit-name">${esc(u.name)}</span>
      <span class="unit-count">${u.questions === 0 ? 'Coming soon' : `${u.questions} questions`}</span>
    </button>`).join('');

  $$('#cd-units .unit-row:not(.empty)').forEach((b) => b.addEventListener('click', () => {
    state.scope = { courseId: data.course.id, courseName: data.course.name, unit: b.dataset.unit };
    showView('home');
    toast(`Studying ${b.dataset.unit}`, 'good');
  }));

  $('#cd-study').onclick = () => {
    state.scope = { courseId: data.course.id, courseName: data.course.name, unit: null };
    showView('home');
  };
}

$('#course-back').addEventListener('click', loadCourses);
$('#edit-courses-btn').addEventListener('click', () => {
  state.onboarding.courses = new Set((state.user.courses || []).map((c) => c.id));
  state.onboarding.grade = state.user.gradeLevel || 10;
  startOnboarding();
  $('#ob-next-1').disabled = false;
  $$('#grade-choices .choice').forEach((b) => {
    if (Number(b.dataset.grade) === state.onboarding.grade) b.classList.add('selected');
  });
});

// ------------------------------------------------------------------ progress
function barColor(p) {
  if (p === null) return 'var(--border)';
  if (p >= 85) return 'var(--good)';
  if (p >= 60) return 'var(--accent)';
  return 'var(--bad)';
}
function topicRow(t) {
  const p = t.masteryPercent;
  return `<div class="topic-row">
    <div><div class="topic-name">${esc(t.topic)}</div><div class="dim">${t.attempts} answered</div></div>
    <div class="bar"><span style="width:${p === null ? 0 : p}%;background:${barColor(p)}"></span></div>
    <div class="pct" style="color:${barColor(p)}">${p === null ? '—' : `${p}%`}</div>
  </div>`;
}

async function loadDashboard() {
  const { report, profile } = await api('GET', '/api/dashboard');
  renderProfile(profile);
  const t = report.totals;
  $('#stat-row').innerHTML = `
    <div class="card stat-card"><div class="stat-value">${t.overallAccuracy === null ? '—' : `${t.overallAccuracy}%`}</div><div class="stat-label">Accuracy</div></div>
    <div class="card stat-card"><div class="stat-value">${t.totalAttempts}</div><div class="stat-label">Answered</div></div>
    <div class="card stat-card"><div class="stat-value">${t.topicsTouched}</div><div class="stat-label">Topics started</div></div>
    <div class="card stat-card"><div class="stat-value" style="color:var(--good)">${t.topicsMastered}</div><div class="stat-label">Mastered</div></div>`;

  $('#weak-spots').innerHTML = report.weakSpots.length === 0
    ? '<p class="muted">Answer more questions and your weak spots will appear here.</p>'
    : report.weakSpots.map(topicRow).join('');

  $('#mastery-subjects').innerHTML = report.subjects
    .filter((s) => s.topics.some((x) => x.attempts > 0))
    .map((s) => `<div class="card"><h2>${esc(s.subject)}</h2>
      ${s.topics.filter((x) => x.attempts > 0).map(topicRow).join('')}</div>`).join('')
    || '<div class="card empty-state"><span class="empty-emoji">◱</span><h3>No data yet</h3><p class="muted">Answer some questions to see your mastery map.</p></div>';
}

// ------------------------------------------------------------------ group
async function loadGroup() {
  const data = await api('GET', '/api/groups/me');
  const has = Boolean(data.group);
  $('#group-none').classList.toggle('hidden', has);
  $('#group-detail').classList.toggle('hidden', !has);
  if (!has) return;

  const g = data.group;
  $('#group-name').textContent = g.name;
  $('#group-code').textContent = g.inviteCode;
  const s = $('#group-status');
  s.textContent = g.active ? 'Active' : `${g.seatsNeededToActivate} more to unlock`;
  s.className = `pill ${g.active ? 'pill-test-prep' : 'pill-regular'}`;

  const seats = Math.max(g.minSeats, g.memberCount);
  $('#group-seats').innerHTML = Array.from({ length: seats }, (_, i) =>
    `<div class="seat${i < g.memberCount ? ' filled' : ''}"></div>`).join('');

  const btn = $('#activate-group-btn');
  const can = g.memberCount >= g.minSeats && !g.active && g.ownerId === state.user.id;
  btn.classList.toggle('hidden', !can);
  if (can) btn.textContent = `Activate ${g.memberCount} seats — $${((data.seatPriceCents * g.memberCount) / 100).toFixed(2)}/mo`;

  $('#leaderboard').innerHTML = data.leaderboard.map((r) => `
    <div class="lb-row${r.rank === 1 ? ' first' : ''}">
      <div class="lb-rank">${r.rank}</div>
      <div>${esc(r.displayName)}${r.userId === state.user.id ? ' <span class="dim">(you)</span>' : ''}</div>
      <div class="num">${r.answered}</div>
      <div class="num">${r.accuracyPercent === null ? '—' : `${r.accuracyPercent}%`}</div>
    </div>`).join('');
}

$('#create-group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('POST', '/api/groups', { name: new FormData(e.target).get('name') }); loadGroup(); toast('Group created.', 'good'); }
  catch (err) { toast(err.message, 'bad'); }
});
$('#join-group-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const d = await api('POST', '/api/groups/join', { inviteCode: new FormData(e.target).get('inviteCode') });
    state.user = d.user; loadGroup(); toast('Joined.', 'good');
  } catch (err) { toast(err.message, 'bad'); }
});
$('#leave-group-btn').addEventListener('click', async () => {
  if (!confirm('Leave this study group?')) return;
  const d = await api('POST', '/api/groups/leave');
  state.user = d.user; loadGroup(); toast('You left the group.');
});
$('#activate-group-btn').addEventListener('click', async () => {
  try {
    const d = await api('POST', '/api/billing/group', {});
    if (d.url) { window.location.href = d.url; return; }
    state.user = d.user; toast(d.message || 'Group activated.', 'good'); loadGroup();
  } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ plan
async function loadPlan() {
  $('#plan-label').textContent = state.user.planLabel;
  $('#upgrade-btn').classList.toggle('hidden', state.user.plan !== 'free');
  $('#cancel-btn').classList.toggle('hidden', state.user.plan === 'free' || state.user.billingMode !== 'demo');
  $('#verify-banner').classList.toggle('hidden', Boolean(state.user.emailVerified));
  $('#verify-banner').innerHTML = 'Your email is not confirmed yet. <button class="linkish" id="send-verify">Send confirmation</button>';
  const sv = $('#send-verify');
  if (sv) sv.addEventListener('click', async () => {
    try { const d = await api('POST', '/api/auth/send-verification', {}); toast(d.alreadyVerified ? 'Already confirmed.' : 'Verification email sent.', 'good'); }
    catch (err) { toast(err.message, 'bad'); }
  });

  const b = $('#billing-banner');
  if (state.user.billingMode === 'demo') {
    b.textContent = 'Billing is in demo mode. Upgrades are simulated and no card is charged.';
    b.classList.remove('hidden');
  } else b.classList.add('hidden');
}

$('#upgrade-btn').addEventListener('click', async () => {
  try {
    const d = await api('POST', '/api/billing/premium', {});
    if (d.url) { window.location.href = d.url; return; }
    state.user = d.user; toast('Upgraded.', 'good'); loadPlan(); renderChrome();
  } catch (err) { toast(err.message, 'bad'); }
});
$('#cancel-btn').addEventListener('click', async () => {
  if (!confirm('Cancel and return to the Free plan?')) return;
  const d = await api('POST', '/api/billing/cancel', {});
  state.user = d.user; toast('Back on the Free plan.'); loadPlan();
});

// ------------------------------------------------------------------ reset/verify
$('#reset-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  if (f.get('password') !== f.get('confirm')) { $('#reset-message').textContent = 'The two passwords do not match.'; return; }
  try {
    const d = await api('POST', '/api/auth/reset', {
      token: new URLSearchParams(location.search).get('token'), password: f.get('password'),
    });
    $('#reset-message').textContent = d.message;
    setTimeout(() => { location.href = '/'; }, 1500);
  } catch (err) { $('#reset-message').textContent = err.message; }
});
$('#verify-continue').addEventListener('click', () => { location.href = '/'; });

async function handleTokenRoutes() {
  const path = location.pathname;
  const token = new URLSearchParams(location.search).get('token');

  if (path === '/reset') {
    showView('reset');
    if (!token) { $('#reset-message').textContent = 'This link is missing its token.'; return true; }
    const { valid } = await api('GET', `/api/auth/reset-valid?token=${encodeURIComponent(token)}`);
    if (!valid) {
      $('#reset-form').classList.add('hidden');
      $('#reset-message').textContent = 'This reset link is invalid or has expired. Request a new one.';
    }
    return true;
  }
  if (path === '/verify') {
    showView('verify');
    try {
      await api('POST', '/api/auth/verify', { token });
      $('#verify-title').textContent = 'Email confirmed';
      $('#verify-message').textContent = 'Your account is fully set up.';
    } catch (err) {
      $('#verify-title').textContent = 'Could not confirm';
      $('#verify-message').textContent = err.message;
    }
    $('#verify-continue').classList.remove('hidden');
    return true;
  }
  return false;
}


// ------------------------------------------------------------------ custom sets
let editingSetId = null;

function cardRowHtml(front = '', back = '') {
  return `<div class="card-editor-row">
    <input type="text" class="cr-front" placeholder="Term" value="${esc(front)}" maxlength="200">
    <input type="text" class="cr-back" placeholder="Definition" value="${esc(back)}" maxlength="500">
    <button type="button" class="btn btn-ghost cr-del" title="Remove">×</button>
  </div>`;
}

function bindCardRows() {
  $$('#set-cards .cr-del').forEach((b) => b.addEventListener('click', () => {
    if ($$('#set-cards .card-editor-row').length > 1) b.closest('.card-editor-row').remove();
  }));
}

async function openSetEditor(setId = null) {
  editingSetId = setId;
  showView('set');
  $('#set-msg').textContent = '';
  $('#delete-set').classList.toggle('hidden', !setId);

  if (setId) {
    const { set } = await api('GET', `/api/set?id=${setId}`);
    $('#set-title').value = set.title;
    $('#set-cards').innerHTML = set.cards.length
      ? set.cards.map((c) => cardRowHtml(c.front, c.back)).join('')
      : cardRowHtml();
  } else {
    $('#set-title').value = '';
    $('#set-cards').innerHTML = cardRowHtml() + cardRowHtml() + cardRowHtml() + cardRowHtml();
  }
  bindCardRows();
}

$('#new-set-btn').addEventListener('click', () => openSetEditor(null));
$('#add-card-row').addEventListener('click', () => {
  $('#set-cards').insertAdjacentHTML('beforeend', cardRowHtml());
  bindCardRows();
});

function collectCards() {
  return $$('#set-cards .card-editor-row').map((row) => ({
    front: row.querySelector('.cr-front').value.trim(),
    back: row.querySelector('.cr-back').value.trim(),
  })).filter((c) => c.front && c.back);
}

$('#save-set').addEventListener('click', async () => {
  const title = $('#set-title').value.trim();
  const cards = collectCards();
  if (!title) { $('#set-msg').textContent = 'Give your set a title.'; return; }
  // Match needs at least 3 pairs and multiple choice needs 4 options, so a
  // set smaller than this cannot power the study modes it promises.
  if (cards.length < 4) { $('#set-msg').textContent = 'Add at least 4 complete cards.'; return; }

  try {
    if (editingSetId) {
      await api('POST', '/api/sets/update', { id: editingSetId, cards });
    } else {
      const { set } = await api('POST', '/api/sets', { title, cards });
      editingSetId = set.id;
    }
    toast('Set saved.', 'good');
    showView('home');
  } catch (err) { $('#set-msg').textContent = err.message; }
});

$('#delete-set').addEventListener('click', async () => {
  if (!editingSetId || !confirm('Delete this set?')) return;
  await api('POST', '/api/sets/delete', { id: editingSetId });
  toast('Set deleted.');
  showView('home');
});

/** Study a custom set as flashcards, reusing the existing deck view. */
async function studySet(setId) {
  const { set } = await api('GET', `/api/set?id=${setId}`);
  if (set.cards.length === 0) { toast('That set has no cards yet.', 'bad'); return; }
  state.flash = {
    cards: set.cards.map((c) => ({ id: c.id, front: c.front, back: c.back })),
    index: 0, flipped: false,
  };
  showView('flashcards');
  renderFlash();
}

// ------------------------------------------------------------------ group chat
const chat = { channel: 'general', lastId: 0, timer: null };

async function loadChannels() {
  try {
    const { channels } = await api('GET', '/api/group/channels');
    $('#channel-list').innerHTML = channels.map((c) => `
      <button class="channel-btn${c.id === chat.channel ? ' active' : ''}" data-ch="${esc(c.id)}">
        <span class="channel-hash">#</span>
        <span>${esc(c.id === 'general' ? 'general' : c.name)}</span>
        ${c.messages ? `<span class="count-badge">${c.messages}</span>` : ''}
      </button>`).join('');
    $$('.channel-btn').forEach((b) => b.addEventListener('click', () => {
      chat.channel = b.dataset.ch;
      chat.lastId = 0;
      $('#chat-messages').innerHTML = '';
      loadChannels();
      loadMessages();
    }));
  } catch { /* not in a group */ }
}

function messageHtml(m) {
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `<div class="msg${m.mine ? ' mine' : ''}">
    <span class="msg-avatar">${esc((m.displayName || '?').charAt(0).toUpperCase())}</span>
    <div class="msg-body">
      <div class="msg-head"><span class="msg-author">${esc(m.displayName)}</span><span class="msg-time">${time}</span></div>
      <div class="msg-text">${esc(m.body)}</div>
    </div>
  </div>`;
}

async function loadMessages() {
  try {
    const { messages } = await api('GET', `/api/group/messages?channel=${encodeURIComponent(chat.channel)}&since=${chat.lastId}`);
    if (messages.length === 0) return;
    const box = $('#chat-messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.insertAdjacentHTML('beforeend', messages.map(messageHtml).join(''));
    chat.lastId = messages[messages.length - 1].id;
    if (atBottom) box.scrollTop = box.scrollHeight;
  } catch { /* not in a group */ }
}

$('#chat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#chat-input');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  try {
    await api('POST', '/api/group/messages', { channel: chat.channel, body });
    await loadMessages();
  } catch (err) { toast(err.message, 'bad'); }
});

// Light polling. A websocket would be better, but this keeps the server
// dependency-free and a study group is not a high-traffic chat room.
function startChatPolling() {
  stopChatPolling();
  chat.timer = setInterval(() => {
    if (state.view === 'group') loadMessages();
  }, 4000);
}
function stopChatPolling() { if (chat.timer) clearInterval(chat.timer); chat.timer = null; }

/**
 * The learning profile card.
 *
 * Deliberately NOT a streak warning. It states what the app has figured out
 * about this student so far, which grows on its own the more they use it. The
 * value is real rather than manufactured: a rival app genuinely does start
 * from nothing, because this is a model of one person, not a pile of content.
 */
function renderProfile(p) {
  const host = $('#profile-card');
  if (!host) return;
  if (!p || p.answered === 0) {
    host.innerHTML = `
      <h2>Your learning profile</h2>
      <p class="muted">
        Answer a few questions and this fills in. Whetstone starts building a
        picture of which topics you personally keep missing, and that picture
        is what makes the practice worth doing.
      </p>`;
    return;
  }

  const acc = Math.round((p.correct / p.answered) * 100);
  const weak = p.weakest.length
    ? p.weakest.map((t) => `<span class="chip chip-weak">${esc(t)}</span>`).join('')
    : '<span class="muted">Nothing clearly weak yet.</span>';

  host.innerHTML = `
    <h2>What Whetstone knows about you</h2>
    <p class="muted" style="font-size:.92rem;margin-bottom:1rem">
      Built from ${p.answered} answer${p.answered === 1 ? '' : 's'} across
      ${p.daysStudied} day${p.daysStudied === 1 ? '' : 's'}.
    </p>

    <div class="profile-grid">
      <div><span class="profile-num">${p.topicsTracked}</span><span class="profile-lbl">topics tracked</span></div>
      <div><span class="profile-num" style="color:var(--good)">${p.topicsMastered}</span><span class="profile-lbl">mastered</span></div>
      <div><span class="profile-num">${acc}%</span><span class="profile-lbl">accuracy</span></div>
      <div><span class="profile-num">${p.dueNow}</span><span class="profile-lbl">queued for review</span></div>
    </div>

    <div class="label" style="margin:1.1rem 0 .45rem">Your specific weak spots</div>
    <div class="chip-row">${weak}</div>

    <p class="muted" style="font-size:.85rem;margin-top:1.1rem">
      This profile is yours. It is not a list of popular topics, it is what
      <em>you</em> keep missing, and it gets sharper every session.
    </p>`;
}

// ------------------------------------------------------------------ settings
async function loadSettings() {
  if (!state.user) return;
  const u = state.user;

  $('#account-kv').innerHTML = `
    <dt>Display name</dt><dd>${esc(u.displayName || '-')}</dd>
    <dt>Email</dt><dd>${esc(u.email || '-')}</dd>
    <dt>Plan</dt><dd>${esc(u.plan || 'free')}</dd>`;
  $('#set-display').value = u.displayName || '';

  // The switcher only exists when the server says testing mode is on.
  $('#tester-card').classList.toggle('hidden', !state.testingMode);
  if (state.testingMode) {
    $('#tester-current').textContent = u.plan || 'free';
    $$('#plan-switch button').forEach((b) => {
      b.classList.toggle('active', b.dataset.plan === (u.plan || 'free'));
    });
  }

  loadMyBugs();
}

$('#plan-switch').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-plan]');
  if (!btn) return;
  try {
    const d = await api('POST', '/api/dev/plan', { plan: btn.dataset.plan });
    state.user.plan = d.plan;
    toast(d.message, 'good');
    loadSettings();
    renderChrome();
  } catch (err) { toast(err.message, 'bad'); }
});

$('#save-display').addEventListener('click', async () => {
  const name = $('#set-display').value.trim();
  if (!name) return toast('Give yourself a name.', 'bad');
  try {
    await api('POST', '/api/account/display-name', { displayName: name });
    state.user.displayName = name;
    toast('Name updated.', 'good');
    loadSettings();
    renderChrome();
  } catch (err) { toast(err.message, 'bad'); }
});

$('#settings-signout').addEventListener('click', async () => {
  await api('POST', '/api/auth/logout');
  state.user = null;
  renderChrome();
  showView('landing');
});

// ------------------------------------------------------------------ bug reports
$('#bug-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/bugs', {
      title: f.get('title'), body: f.get('body'), page: state.view,
    });
    e.target.reset();
    toast('Report saved. Thanks.', 'good');
    loadMyBugs();
  } catch (err) { toast(err.message, 'bad'); }
});

async function loadMyBugs() {
  try {
    const { bugs } = await api('GET', '/api/bugs/mine');
    $('#my-bugs').innerHTML = bugs.length === 0 ? '' :
      `<div class="label" style="margin-bottom:.4rem">Your reports</div>` +
      bugs.map((b) => `<div class="bug-item">
        <span class="status-dot status-${esc(b.status)}"></span>
        <span style="flex:1">${esc(b.title)}</span>
        <span class="dim">${esc(b.status)}</span>
      </div>`).join('');
  } catch { /* signed out */ }
}

// ------------------------------------------------------------------ legal modal
async function showLegal(doc) {
  try {
    const data = await api('GET', `/api/legal?doc=${doc}`);
    $('#modal-host').innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop">
        <div class="modal">
          <div class="row-between" style="margin-bottom:1rem">
            <h2 style="margin:0">${doc === 'privacy' ? 'Privacy Policy' : 'Terms of Service'}</h2>
            <button class="btn btn-sm btn-ghost" id="modal-close">Close</button>
          </div>
          <div class="modal-doc">${esc(data.markdown)}</div>
        </div>
      </div>`;
    const close = () => { $('#modal-host').innerHTML = ''; };
    $('#modal-close').addEventListener('click', close);
    $('#modal-backdrop').addEventListener('click', (e) => {
      if (e.target.id === 'modal-backdrop') close();
    });
  } catch (err) { toast(err.message, 'bad'); }
}

document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-legal]');
  if (btn) { e.preventDefault(); showLegal(btn.dataset.legal); }
});

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

  if (state.view === 'learn') {
    if (!state.answered && /^[1-6]$/.test(e.key)) {
      const b = $(`#q-choices .choice-btn[data-i="${Number(e.key) - 1}"]`);
      if (b) b.click();
    } else if (state.answered && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault(); loadQuestion();
    }
  }
  if (state.view === 'flashcards') {
    if (e.key === ' ') { e.preventDefault(); flipCard(); }
    if (e.key === 'ArrowRight') $('#flash-next').click();
    if (e.key === 'ArrowLeft') $('#flash-prev').click();
  }
  if (state.view === 'test' && /^[1-6]$/.test(e.key)) {
    const b = $(`#test-choices .choice-btn[data-i="${Number(e.key) - 1}"]`);
    if (b) b.click();
  }
});

// ------------------------------------------------------------------ boot
(async function boot() {
  try {
    const { user, testingMode } = await api('GET', '/api/me');
    state.user = user;
    state.testingMode = Boolean(testingMode);
  } catch { state.user = null; }

  if (await handleTokenRoutes()) { renderChrome(); return; }

  renderChrome();
  if (!state.user) showView('landing');
  else if (!state.user.onboarded) startOnboarding();
  else showView('home');
})();
