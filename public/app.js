'use strict';

/* Keen front end. Vanilla JS, no build step, no framework. */

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
  premiumModes: [],
  progression: null,
  myCourses: [],
};


// ------------------------------------------------------------------ theme
/* Light, dark, or follow the system.
 *
 * Default is 'auto', which tracks prefers-color-scheme live -- a phone that
 * flips to dark at sunset should take the app with it without a reload. An
 * explicit choice in Settings overrides that and persists.
 *
 * The initial theme is applied by a small inline-ish bootstrap before first
 * paint (see applyTheme call at the bottom of this file) so there is no
 * white flash for someone in dark mode. */
const THEME_KEY = 'keen:theme';

/* matchMedia is missing in some embedded webviews and in jsdom, and calling it
 * unguarded at module scope took the ENTIRE app down with
 * "window.matchMedia is not a function" -- not just the theme. A null-object
 * fallback keeps everything else running and simply means "not dark". */
const darkQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-color-scheme: dark)')
  : { matches: false, addEventListener() {}, removeEventListener() {} };

function storedTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'auto'; } catch { return 'auto'; }
}

function applyTheme(pref = storedTheme()) {
  const dark = pref === 'dark' || (pref === 'auto' && darkQuery.matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

function setTheme(pref) {
  try { localStorage.setItem(THEME_KEY, pref); } catch { /* private mode */ }
  applyTheme(pref);
  $$('[data-theme-choice]').forEach((b) =>
    b.classList.toggle('active', b.dataset.themeChoice === pref));
}

// Only meaningful while the preference is 'auto'.
darkQuery.addEventListener('change', () => { if (storedTheme() === 'auto') applyTheme('auto'); });

applyTheme();

// ------------------------------------------------------------------ helpers
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    // fetch only rejects on a network-level failure, so this really is the
    // connection rather than a server error. Say so plainly.
    setOffline(true);
    const err = new Error('You appear to be offline. Check your connection and try again.');
    err.status = 0;
    err.offline = true;
    throw err;
  }
  if (res.ok) setOffline(false);
  let data = {};
  try { data = await res.json(); } catch { /* no body */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    // A 401 while the client still believes it is signed in means the session
    // died underneath us -- expired, or the server lost its database. Showing
    // "You need to sign in." inside an empty quiz card, with the nav still
    // rendered, reads as a broken app. Drop to the sign-in screen and say what
    // happened.
    if (res.status === 401 && path !== '/api/me' && typeof handleSessionLoss === 'function') {
      handleSessionLoss();
    }
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

/* ---- runtime styles under a strict CSP -------------------------------------
 *
 * A few values genuinely have to be computed at runtime (a progress bar's
 * width, a mastery colour). They cannot be written as style="..." in a template
 * string: the Content-Security-Policy in server.js sets style-src without
 * 'unsafe-inline', so the browser DISCARDS style attributes outright. Bars
 * rendered at zero width and every percentage looked broken, with nothing in
 * the console to explain why.
 *
 * Assigning through the CSSOM (el.style.x = v) is NOT covered by style-src, so
 * the value travels in a data-* attribute and is applied here after insertion.
 */
/* Restart a CSS animation on an element already in the DOM.
 *
 * Removing and re-adding the class in the same frame does nothing: the browser
 * batches style changes, sees no net difference, and never restarts the
 * animation. Reading offsetWidth forces a synchronous reflow, which commits the
 * removal first. The read is deliberately not optimised away. */
function replayAnimation(el, className) {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth; // force reflow -- do not remove
  el.classList.add(className);
}

const DYNAMIC_SELECTOR = '[data-width], [data-bg], [data-color]';

function applyOne(el) {
  const { width, bg, color } = el.dataset;
  if (width !== undefined) el.style.width = `${width}%`;
  if (bg !== undefined) el.style.background = bg;
  if (color !== undefined) el.style.color = color;
}

function applyDynamicStyles(root = document) {
  // The root itself may be the styled element, so check it before descendants.
  if (root.nodeType === 1 && root.matches(DYNAMIC_SELECTOR)) applyOne(root);
  root.querySelectorAll(DYNAMIC_SELECTOR).forEach(applyOne);
}

/* Watch for injected markup instead of calling applyDynamicStyles at each
 * render site. Those sites are spread across several functions, and a missed
 * call produces a silently zero-width bar -- the exact failure this prevents.
 * Only childList is observed, so writing el.style cannot retrigger this.
 * Scoped to #main because the chat view polls and appends continuously. */
function watchForDynamicStyles() {
  const target = $('#main') || document.body;
  new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === 1) applyDynamicStyles(node);
      }
    }
  }).observe(target, { childList: true, subtree: true });
}

function levelPill(levelLabel) {
  const key = String(levelLabel || 'Regular').toLowerCase().replace(/\s+/g, '-');
  return `<span class="pill pill-${key}">${esc(levelLabel)}</span>`;
}

// ------------------------------------------------------------------ routing
/* Onboarding is a gate, not a page.
 *
 * A signed-in user who has not finished onboarding has no grade level and no
 * courses, so every other view would query an empty scope and render blank
 * shells. Rather than defend each of those views individually, we refuse to
 * leave onboarding until it is done. */
function onboardingPending() {
  return Boolean(state.user) && !state.user.onboarded;
}

/**
 * Anything that sets body.modal-open must be torn down when the view changes.
 *
 * body.modal-open sets overflow:hidden. Opening the Terms modal and then
 * tapping the nav left that class on the body forever, so the home screen
 * silently stopped scrolling and the only cure was a reload. Navigation is the
 * one event guaranteed to happen, so it is the right place to clean up.
 */
function closeOverlays() {
  const host = $('#modal-host');
  if (host) host.innerHTML = '';
  const pw = $('#paywall');
  if (pw) pw.classList.add('hidden');
  // BOTH classes set overflow:hidden. Clearing only modal-open left
  // is-reordering behind, which is a second, identical way to end up on a page
  // that will not scroll.
  document.body.classList.remove('modal-open', 'is-reordering');
}

/* Last line of defence for scroll locking.
 *
 * Every overflow:hidden on the body is added by one code path and removed by
 * another, and the removal is always conditional on something happening:
 * a pointerup, a close button, a navigation. Anything that interrupts that --
 * a lost pointer capture, a re-render mid-drag, an alt-tab, a dropped event --
 * leaves the page permanently unscrollable with no visible cause. It is the
 * single most confusing failure the app has had, and it has now been reported
 * three times.
 *
 * So rather than trusting each path, this asserts the invariant: if no overlay
 * is actually on screen and no drag is actually in progress, the body must not
 * be locked. Cheap, runs on events that fire constantly anyway, and it cannot
 * mask a real overlay because it checks whether one is visible first.
 */
/**
 * Is this element genuinely on screen, as opposed to merely "not hidden"?
 *
 * The distinction is the whole bug. The paywall was display:grid with opacity 0
 * because a stalled CSS animation held it at its `from` frame, so a class check
 * said "an overlay is open, keep the page locked" while the user saw an empty
 * screen that would not scroll. A lock may only be held by something a person
 * can actually SEE.
 */
function isReallyVisible(el) {
  if (!el || el.classList.contains('hidden')) return false;
  const cs = getComputedStyle(el);
  if (cs.display === 'none' || cs.visibility === 'hidden') return false;
  if (Number(cs.opacity) < 0.05) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function assertScrollable() {
  const paywallOpen = isReallyVisible($('#paywall'));
  const host = $('#modal-host');
  const modalOpen = Boolean(host && host.innerHTML) && isReallyVisible(host.firstElementChild);
  const dragging = Boolean(document.querySelector('.course-tile-wrap.dragging'));
  if (!paywallOpen && !modalOpen) document.body.classList.remove('modal-open');
  if (!dragging) document.body.classList.remove('is-reordering');
}

// pointerup fires at the end of every click and every drag, anywhere on the
// page, including drags that ended somewhere unexpected. visibilitychange
// covers coming back from another tab or app.
window.addEventListener('pointerup', assertScrollable);
window.addEventListener('pointercancel', assertScrollable);
document.addEventListener('visibilitychange', () => { if (!document.hidden) assertScrollable(); });

function showView(name) {
  // The only escape hatch is signing out, which clears state.user first.
  if (onboardingPending() && name !== 'onboarding') return;

  closeOverlays();
  state.view = name;
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const el = $(`#view-${name}`);
  if (el) el.classList.remove('hidden');
  $$('.nav-btn, .mobile-nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  window.scrollTo({ top: 0, behavior: 'instant' });

  rememberView(name);

  if (name === 'home') renderHome();
  if (name === 'courses') loadCourses();
  if (name === 'profile') loadProfile();
  if (name === 'progress') loadDashboard();
  if (name === 'group') { loadGroup(); loadChannels(); loadMessages(); startChatPolling(); }
  else { stopChatPolling(); stopInviteTimer(); }
  // A running exam timer must not keep ticking after you navigate away.
  if (name !== 'apexam') apClearTimer();
  if (name === 'plan') loadPlan();
  if (name === 'settings') loadSettings();
}

function renderChrome() {
  const signedIn = Boolean(state.user);
  // Chrome appears only once onboarding is done. Previously it appeared the
  // moment you signed in, which let a half-onboarded user tap into empty views.
  const showChrome = signedIn && !onboardingPending();

  $('#nav').classList.toggle('hidden', !showChrome);
  $('#mobile-nav').classList.toggle('hidden', !showChrome);
  $('#avatar').classList.toggle('hidden', !showChrome);

  // Full-screen, distraction-free onboarding: no top bar, no way out.
  document.body.classList.toggle('onboarding-lock', onboardingPending());
  if (signedIn) {
    $('#avatar').textContent = (state.user.displayName || '?').charAt(0).toUpperCase();
    if (state.progression) renderXpBar(state.progression);
  }
  $('#xp-bar').classList.toggle('hidden', !showChrome);
}

$$('.nav-btn, .mobile-nav button').forEach((b) => {
  b.addEventListener('click', () => showView(b.dataset.view));
});
$$('[data-back]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.back)));
$('#avatar').addEventListener('click', () => showView('profile'));

// ------------------------------------------------------------------ auth
function authError(msg, target = '#auth-error') {
  const e = $(target);
  e.textContent = msg;
  e.classList.remove('hidden');
}

/* Smooth-scroll the landing page CTAs to their section. */
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-scroll-to]');
  if (!btn) return;
  const target = document.getElementById(btn.dataset.scrollTo);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

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

/**
 * Sign out cleanly. Shared by every sign-out control so they cannot drift.
 *
 * The logout call is best-effort: if it fails the local session is still torn
 * down, because a student who pressed Sign out must end up signed out
 * regardless of what the network did.
 */
async function signOut() {
  try { await api('POST', '/api/auth/logout'); } catch { /* clear locally anyway */ }
  state.user = null;
  state.myCourses = [];
  state.scope = { courseId: null, courseName: null, unit: null };
  closeOverlays();
  renderChrome();
  showView('landing');
}

/* Called when the server says 401 but the client thought it was signed in. */
let sessionLossShown = false;
function handleSessionLoss() {
  if (!state.user || sessionLossShown) return;
  sessionLossShown = true;
  state.user = null;
  state.myCourses = [];
  closeOverlays();
  renderChrome();
  showView('signin');
  const notice = $('#auth-notice');
  if (notice) {
    notice.textContent = 'Your session ended. Sign in again to pick up where you left off.';
    notice.classList.remove('hidden');
  }
  toast('Signed out. Please sign in again.', 'bad');
  setTimeout(() => { sessionLossShown = false; }, 3000);
}

$('#logout-btn').addEventListener('click', signOut);

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
    if (data.mailMode === 'console' && data.supportEmail) {
      // Being told "a link is on its way" when no mail provider exists is how
      // somebody ends up locked out of their own account, refreshing an inbox
      // that will never receive anything. Give them a person to contact.
      n.innerHTML = `${esc(data.message)} Email
        <a href="mailto:${esc(data.supportEmail)}?subject=Keen%20password%20reset">${esc(data.supportEmail)}</a>
        and we will reset it for you.`;
    } else {
      n.textContent = data.message;
    }
    n.classList.remove('hidden');
    $('#signin-error').classList.add('hidden');
  } catch (err) { authError(err.message, '#signin-error'); }
});

// ------------------------------------------------------------------ onboarding
/* High school only. College courses were removed: the product is aimed at
 * students picking their actual 9-12 schedule, and a catalogue spanning
 * freshman year through a college major made the course picker harder to use
 * for everyone without serving either audience well. */
const GRADES = [
  { v: 9, t: '9th', s: 'Freshman' }, { v: 10, t: '10th', s: 'Sophomore' },
  { v: 11, t: '11th', s: 'Junior' }, { v: 12, t: '12th', s: 'Senior' },
];
const GOALS = [
  { v: 'grades', t: 'Class grades', s: 'Tests and quizzes' },
  { v: 'ap', t: 'AP exams', s: 'May exam scores' },
  { v: 'sat', t: 'SAT / ACT', s: 'College admissions' },
  { v: 'mastery', t: 'Just learn it', s: 'Long-term retention' },
];

function startOnboarding() {
  renderChrome();          // applies the full-screen lock before the step paints
  showView('onboarding');
  $('#ob-step-1').classList.remove('hidden');
  $('#ob-step-2').classList.add('hidden');
  $('#ob-step-3').classList.add('hidden');
  $('#ob-step-4').classList.add('hidden');

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
    $('#ob-next-3').disabled = false;
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

/* Step 3 -> step 4. The upsell is shown AFTER the student has picked their
 * classes, because by then the pitch can be concrete about what they chose
 * rather than abstract. */
$('#ob-next-3').addEventListener('click', () => {
  setSteps(4);
  $('#ob-step-3').classList.add('hidden');
  $('#ob-step-4').classList.remove('hidden');

  // Make the limit personal: name the subjects they will lose access to.
  const picked = [...state.onboarding.courses]
    .map((id) => (state.catalog || []).flatMap((g) => g.courses || g.items || [g]).find((c) => c && c.id === id))
    .filter(Boolean);
  const subjects = [...new Set(picked.map((c) => c.category).filter(Boolean))];
  const note = $('#ob-premium-note');
  if (subjects.length > 1) {
    note.textContent = `You picked ${picked.length} classes across ${subjects.length} subjects. `
      + `On the free plan you can study one subject at a time and 5 questions a day.`;
  } else {
    note.textContent = 'On the free plan you will hit the daily limit after 5 questions.';
  }
});

$('#ob-back-4').addEventListener('click', () => {
  setSteps(3);
  $('#ob-step-4').classList.add('hidden');
  $('#ob-step-3').classList.remove('hidden');
});

/* Completing onboarding and upgrading are deliberately separate calls.
 * If the upgrade fails the account is still fully set up, so the student lands
 * in the app on the free plan instead of being stranded mid-onboarding. */
async function completeOnboarding() {
  const { user } = await api('POST', '/api/onboarding', {
    gradeLevel: state.onboarding.grade,
    courseIds: [...state.onboarding.courses],
    goal: state.onboarding.goal,
  });
  state.user = user;
  renderChrome();
  return user;
}

$('#ob-finish').addEventListener('click', async () => {
  try {
    await completeOnboarding();
    showView('home');
    toast('You are all set. Pick a study mode.', 'good');
  } catch (err) { toast(err.message, 'bad'); }
});

$('#ob-upgrade').addEventListener('click', async () => {
  const btn = $('#ob-upgrade');
  btn.disabled = true;
  try {
    await completeOnboarding();
    const d = await api('POST', '/api/billing/premium', {});
    // closeOverlays() first: see the paywall handler for why leaving with
    // body.modal-open applied breaks scrolling on the way back.
    if (d.url) { closeOverlays(); window.location.href = d.url; return; }
    state.user = d.user;
    renderChrome();
    showView('home');
    toast('You are on Premium. Everything is unlocked.', 'good');
  } catch (err) {
    // Onboarding already succeeded, so land them in the app regardless.
    toast(err.message, 'bad');
    showView('home');
  } finally { btn.disabled = false; }
});

// ------------------------------------------------------------------ home
function scopeLabel() {
  if (state.scope.unit) return `${state.scope.courseName} · ${state.scope.unit}`;
  if (state.scope.courseId) return state.scope.courseName;
  return null;
}

function renderUpsellBanner() {
  const el = $('#upsell-banner');
  if (!el) return;
  const free = Boolean(state.user) && state.user.plan === 'free';
  el.classList.toggle('hidden', !free);
  if (!free) return;

  const q = state.user.quota || {};
  const left = Number.isFinite(q.remaining) ? q.remaining : null;
  const lead = left === 0
    ? 'You are out of questions for today.'
    : left !== null
      ? `${left} of ${q.limit} free questions left today.`
      : 'You are on the free plan.';
  el.innerHTML = `<span>${esc(lead)} Premium removes the daily limit and unlocks every mode.</span>
    <button class="btn btn-sm btn-primary" data-upsell>See Premium</button>`;
  // Bound off the element rather than by id. The button is created here, so a
  // document-wide id lookup would look like a missing element to the DOM smoke
  // test that checks every queried id exists in index.html.
  // (Writing that selector literally in a comment is enough to trip it.)
  el.querySelector('[data-upsell]').addEventListener('click', () => showView('plan'));
}



// ------------------------------------------------------------------ profile
/* A real profile: who you are, how far you have got, what you have earned.
 *
 * Deliberately NOT a settings page. Account controls live in Settings; putting
 * them here made the profile read as a form rather than something you would
 * show someone. */

/* Avatars are drawn, not typed.
 *
 * These used to be text glyphs (⚡ ★ ☾ ❦). A glyph is at the mercy of whatever
 * font resolves it, and several of those characters have emoji presentation on
 * iOS and Android, so the "avatar" arrived as a full-colour emoji that ignored
 * the app's palette entirely. Every one of these is an inline SVG path drawn on
 * a 24x24 grid, so it inherits currentColor and looks the same everywhere.
 *
 * Sixteen instead of eight, because eight in a study group of five means people
 * collide almost immediately. */
/* Avatars come from the server now, over /api/me.
 *
 * There used to be a hardcoded list here AND a hardcoded whitelist in
 * server.js. The client offered sixteen, the server accepted eight, and the
 * other eight failed with "Unknown avatar." with no explanation. The list now
 * lives in lib/avatars.js only, so the two cannot disagree.
 *
 * The fallback below is deliberately just the default: if /api/me has not
 * landed yet, we draw one known-good avatar rather than a guessed catalogue
 * that might not match what the server will accept. */
let AVATARS = [
  { id: 'flame', label: 'Ember', path: 'M12 2.8c3.4 3.3 5.6 6 5.6 9.2a5.6 5.6 0 11-11.2 0c0-1.7.6-3 1.7-4.4.5 1 1.2 1.7 2 2 .3-2.5.9-4.6 1.9-6.8z' },
];

function avatarSvg(id, cls = '') {
  const a = AVATARS.find((x) => x.id === id) || AVATARS[0];
  return `<svg class="avatar-art ${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${a.path}"/></svg>`;
}

async function loadProfile() {
  const u = state.user;
  if (!u) return;

  $('#profile-name').textContent = u.displayName || 'You';
  $('#profile-since').textContent = u.createdAt
    ? `Studying since ${new Date(u.createdAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}`
    : '';
  $('#profile-avatar').dataset.avatar = u.avatar || 'flame';
  $('#profile-avatar').innerHTML = avatarSvg(u.avatar || 'flame');

  let prog = state.progression;
  try {
    const me = await api('GET', '/api/me');
    if (Array.isArray(me.avatars) && me.avatars.length) AVATARS = me.avatars;
    state.user = me.user || state.user;
    prog = me.progression || prog;
    state.progression = prog;
  } catch { /* keep whatever we already had */ }

  if (prog) {
    $('#profile-level').textContent = `Level ${prog.level}`;
    $('#profile-xp').textContent = `${prog.xp} XP total`;
    $('#profile-xp-fill').style.width = `${prog.percent}%`;
    $('#profile-next').textContent = prog.neededForNext > 0
      ? `${prog.neededForNext} XP to level ${prog.level + 1}`
      : 'Max level';

    const streak = prog.streak || {};
    $('#profile-stats').innerHTML = `
      <div class="pstat"><span class="pstat-num">${streak.current || 0}</span><span class="pstat-label">Day streak</span></div>
      <div class="pstat"><span class="pstat-num">${streak.best || 0}</span><span class="pstat-label">Best streak</span></div>
      <div class="pstat"><span class="pstat-num">${prog.badgeCount}/${prog.badgeTotal}</span><span class="pstat-label">Badges</span></div>
      <div class="pstat"><span class="pstat-num">${(state.myCourses || []).length}</span><span class="pstat-label">Classes</span></div>`;

    $('#profile-badge-count').textContent = `${prog.badgeCount} of ${prog.badgeTotal}`;
    $('#profile-badges').innerHTML = prog.badges.map((b) => `
      <div class="badge ${b.earned ? 'earned' : 'locked'}" title="${esc(b.description)}">
        <span class="badge-icon">${esc(b.icon)}</span>
        <span class="badge-name">${esc(b.name)}</span>
        <span class="badge-desc">${esc(b.description)}</span>
      </div>`).join('');
  }

  // Courses, with the progress the student has made in each.
  try {
    const { courses } = await api('GET', '/api/my-courses');
    state.myCourses = courses || [];
  } catch { /* leave as-is */ }

  $('#profile-courses').innerHTML = (state.myCourses || []).length === 0
    ? '<p class="muted">No classes yet.</p>'
    : state.myCourses.map((c) => `
        <div class="pcourse" data-subj="${subjectKey(c.category)}">
          <span class="pcourse-dot"></span>
          <span class="u-minw-0">
            <span class="pcourse-name">${esc(c.name)}</span>
            <span class="pcourse-meta dim">${c.masteryPercent === null ? 'Not started' : `${c.masteryPercent}% mastered`}</span>
          </span>
        </div>`).join('');

  $('#avatar-picker').innerHTML = AVATARS.map((a) => `
    <button class="avatar-opt${(state.user.avatar || 'flame') === a.id ? ' selected' : ''}"
            data-avatar-pick="${a.id}" data-avatar="${a.id}" title="${esc(a.label)}"
            aria-label="${esc(a.label)}">${avatarSvg(a.id)}</button>`).join('');

  $$('#avatar-picker [data-avatar-pick]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.avatarPick;
    try {
      await api('POST', '/api/account/avatar', { avatar: id });
      state.user.avatar = id;
      loadProfile();
      renderChrome();
    } catch (err) { toast(err.message, 'bad'); }
  }));

  // Plan and Settings moved off the mobile nav to make room for Group.
  $$('#view-profile [data-goto]').forEach((b) =>
    b.addEventListener('click', () => showView(b.dataset.goto)));
}

// ------------------------------------------------------------------ classes
/* The home screen is the class list, the way Canvas and Google Classroom work.
 *
 * "Study everything" is gone on purpose: it produced sessions that wandered
 * across four subjects, which felt busy but taught nothing in particular. You
 * pick a class, then a mode inside it. */

const SUBJECT_KEY = {
  'Math': 'math', 'Science': 'science', 'English': 'english',
  'Social Studies': 'social', 'World Languages': 'language', 'Arts': 'arts',
  'Computer Science': 'cs', 'Business and Economics': 'business',
  'Health and PE': 'health', 'Engineering and Technology': 'engineering',
};
function subjectKey(category) { return SUBJECT_KEY[category] || 'other'; }

function courseSort() {
  try { return localStorage.getItem('keen:sort') || 'mine'; } catch { return 'mine'; }
}
function setCourseSort(v) {
  try { localStorage.setItem('keen:sort', v); } catch { /* private mode */ }
}

/* Manual order lives client-side and only applies to "My order". Choosing
 * Weakest or Recent does not overwrite it, so switching back restores the
 * arrangement the student made. */
function manualOrder() {
  try { return JSON.parse(localStorage.getItem('keen:order') || '[]'); } catch { return []; }
}
/* Saved in two places on purpose.
 *
 * localStorage is instant and survives a reload with no network, so the board
 * never flickers back to the old order. The server copy is the durable one:
 * without it, arranging your classes on a laptop did nothing on your phone,
 * and clearing site data lost the arrangement entirely. The write is
 * fire-and-forget because failing to save a preference must never interrupt
 * what the student was doing. */
function setManualOrder(ids) {
  try { localStorage.setItem('keen:order', JSON.stringify(ids)); } catch { /* private mode */ }
  api('POST', '/api/my-courses/order', { order: ids }).catch(() => { /* retried next reorder */ });
}

function sortCourses(list, mode) {
  const copy = [...list];
  if (mode === 'weakest') {
    // Lowest mastery first; a course with no data yet sorts last rather than
    // pretending to be 0% mastered.
    return copy.sort((a, b) => {
      const am = a.masteryPercent, bm = b.masteryPercent;
      if (am === null && bm === null) return a.name.localeCompare(b.name);
      if (am === null) return 1;
      if (bm === null) return -1;
      return am - bm;
    });
  }
  if (mode === 'recent') {
    return copy.sort((a, b) => (b.lastStudied || '').localeCompare(a.lastStudied || ''));
  }
  const order = manualOrder();
  return copy.sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
}

function courseCard(c) {
  const key = subjectKey(c.category);
  const mastery = c.masteryPercent === null ? null : c.masteryPercent;
  const weak = c.weakCount || 0;
  // The tile is wrapped so the drag handle can sit OUTSIDE the button. A button
  // nested inside a button is invalid HTML and the inner one stops receiving
  // reliable events, which is half of why reordering never worked.
  return `
    <div class="course-tile-wrap" data-course-wrap="${esc(c.id)}">
    <span class="tile-handle" data-handle role="button" tabindex="0"
          aria-label="Drag to reorder ${esc(c.name)}" title="Drag to reorder">
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M2 8h12M2 12h12"/></svg>
    </span>
    <button class="course-tile" data-course="${esc(c.id)}" data-subj="${key}">
      <span class="course-tile-bar"></span>
      <span class="course-tile-top">
        <span class="course-tile-name">${esc(c.name)}</span>
        <span class="pill pill-${esc(String(c.level || 'regular'))}">${esc(c.levelLabel || 'Regular')}</span>
      </span>
      <span class="course-tile-meta">${esc(c.category || '')}</span>
      <span class="course-tile-track"><span class="course-tile-fill" data-width="${mastery === null ? 0 : mastery}"></span></span>
      <span class="course-tile-stats">
        <span>${mastery === null ? 'Not started' : `${mastery}% mastered`}</span>
        ${weak > 0 ? `<span class="course-weak">${weak} weak topic${weak === 1 ? '' : 's'}</span>` : ''}
      </span>
      ${c.nextUnit ? `<span class="course-tile-next">Next: ${esc(c.nextUnit)}</span>` : ''}
      ${c.lastStudied ? `<span class="course-tile-when dim">${esc(timeAgo(c.lastStudied))}</span>` : ''}
    </button>
    </div>`;
}

async function renderHome() {
  renderUpsellBanner();
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#home-greeting').textContent = `${greet}, ${state.user.displayName}`;

  const q = state.user.quota || {};
  $('#home-sub').textContent = q.limit === null
    ? 'Premium. Study as much as you like.'
    : 'Pick a class to get started.';

  $$('#course-sort .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.sort === courseSort()));

  try {
    const { courses, order } = await api('GET', '/api/my-courses');
    state.myCourses = courses || [];
    // Adopt the server's order so a device that has never been reordered
    // locally still shows the arrangement made somewhere else.
    if (Array.isArray(order) && order.length) {
      try { localStorage.setItem('keen:order', JSON.stringify(order)); } catch { /* private mode */ }
    }
    const board = $('#course-board');
    $('#course-board-empty').classList.toggle('hidden', state.myCourses.length > 0);
    board.innerHTML = sortCourses(state.myCourses, courseSort()).map(courseCard).join('');

    $$('#course-board [data-course]').forEach((el) =>
      el.addEventListener('click', () => openCourseBoard(el.dataset.course)));
    // The handle lives on the wrapper, not the button.
    $$('#course-board [data-course-wrap]').forEach(bindTileDrag);
  } catch (err) {
    if (err.status !== 401) toast(err.message, 'bad');
  }

  try {
    const home = await api('GET', '/api/dashboard');
    const t = home.report.totals;
    $('#home-stats').innerHTML = `
      <div class="mini-stat"><span class="mini-stat-icon u-bg-good-soft u-c-good">✓</span>
        <div class="u-minw-0"><div class="mini-stat-value">${t.overallAccuracy === null ? '—' : `${t.overallAccuracy}%`}</div>
        <div class="mini-stat-label">Accuracy</div></div></div>
      <div class="mini-stat"><span class="mini-stat-icon u-bg-accent-soft u-c-hb9aeff">◎</span>
        <div class="u-minw-0"><div class="mini-stat-value">${t.totalAttempts}</div>
        <div class="mini-stat-label">Answered</div></div></div>
      <div class="mini-stat"><span class="mini-stat-icon u-bg-hfb923c22 u-c-hfbbf24">★</span>
        <div class="u-minw-0"><div class="mini-stat-value">${t.topicsMastered}</div>
        <div class="mini-stat-label">Mastered</div></div></div>
      <div class="mini-stat"><span class="mini-stat-icon u-bg-bad-soft u-c-bad">↻</span>
        <div class="u-minw-0"><div class="mini-stat-value">${home.report.weakSpots.length}</div>
        <div class="mini-stat-label">Weak spots</div></div></div>`;
  } catch { $('#home-stats').innerHTML = ''; }

  loadSets();
}


/**
 * Reorder classes by dragging the handle.
 *
 * This replaces HTML5 drag and drop (draggable="true" plus dragstart/dragover),
 * which had two fatal problems: it does not fire on touch devices AT ALL, so
 * reordering was simply impossible on a phone, and on desktop it was attached
 * to the whole tile, so a slightly-draggy click read as a drag instead of
 * opening the class.
 *
 * Pointer Events cover mouse, touch and stylus in one code path, and confining
 * the drag to an explicit handle means the rest of the tile stays a plain
 * button. The handle is the standard three lines people already recognise.
 */
function bindTileDrag(wrap) {
  const handle = wrap.querySelector('[data-handle]');
  if (!handle) return;

  const board = $('#course-board');
  let dragging = false;

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    wrap.classList.remove('dragging');
    document.body.classList.remove('is-reordering');
    setManualOrder($$('#course-board [data-course-wrap]').map((x) => x.dataset.courseWrap));
    // Having arranged them by hand, you plainly want to see that arrangement.
    if (courseSort() !== 'mine') { setCourseSort('mine'); renderHome(); }
    else toast('Order saved.', 'good');
  };

  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();          // stop the browser starting a text selection
    dragging = true;
    wrap.classList.add('dragging');
    // Locks page scrolling for the duration, otherwise dragging a tile on a
    // phone scrolls the list out from under your finger.
    document.body.classList.add('is-reordering');
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    // With the pointer captured, events keep coming to the handle even when the
    // finger is over another tile, so ask the document what is actually under
    // the cursor rather than relying on the event target.
    const over = document.elementFromPoint(e.clientX, e.clientY);
    const target = over && over.closest('[data-course-wrap]');
    if (!target || target === wrap) return;

    const tiles = $$('#course-board [data-course-wrap]');
    const from = tiles.indexOf(wrap);
    const to = tiles.indexOf(target);
    if (from === -1 || to === -1) return;
    if (from < to) board.insertBefore(wrap, target.nextSibling);
    else board.insertBefore(wrap, target);
  });

  handle.addEventListener('pointerup', finish);
  handle.addEventListener('pointercancel', finish);

  // Keyboard equivalent. A drag-only control is unusable without a pointer,
  // and this is two lines of code.
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    const sibling = e.key === 'ArrowUp'
      ? wrap.previousElementSibling
      : wrap.nextElementSibling;
    if (!sibling) return;
    if (e.key === 'ArrowUp') board.insertBefore(wrap, sibling);
    else board.insertBefore(sibling, wrap);
    handle.focus();
    setManualOrder($$('#course-board [data-course-wrap]').map((x) => x.dataset.courseWrap));
    if (courseSort() !== 'mine') setCourseSort('mine');
  });
}

$('#course-sort').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sort]');
  if (!btn) return;
  setCourseSort(btn.dataset.sort);
  renderHome();
});

/* One class. Modes here are scoped to it, so tapping Learn drills this course
 * rather than everything at once. */
async function openCourseBoard(courseId) {
  const course = (state.myCourses || []).find((c) => c.id === courseId);
  if (!course) return;

  state.scope = { courseId, courseName: course.name, unit: null };
  showView('course');

  $('#course-head-name').textContent = course.name;
  $('#course-head-sub').textContent = `${course.levelLabel || 'Regular'} · ${course.category || ''}`;
  $('#course-head-dot').dataset.subj = subjectKey(course.category);

  const pct = course.masteryPercent === null ? 0 : course.masteryPercent;
  $('#course-progress-fill').style.width = `${pct}%`;
  $('#course-progress-label').textContent = course.masteryPercent === null
    ? 'No questions answered yet'
    : `${pct}% mastered`;

  renderModeLocks();

  try {
    // The route reads ?id=. Sending ?courseId= made courseCoverage(null) return
    // nothing, so every class opened to "Course not found." with zero units --
    // the view had already switched, which is why it looked like a half-failure
    // rather than a dead request.
    const data = await api('GET', `/api/course?id=${encodeURIComponent(courseId)}`);
    const units = data.units || [];
    $('#course-unit-count').textContent = `${units.length} unit${units.length === 1 ? '' : 's'}`;
    $('#course-units').innerHTML = units.map((u) => `
      <button class="unit-row" data-unit="${esc(u.name)}" ${u.questions === 0 ? 'disabled' : ''}>
        <span class="unit-row-main">
          <span class="unit-row-name">${esc(u.name)}</span>
          <span class="unit-row-meta dim">${u.questions === 0 ? 'No questions yet' : `${u.questions} questions`}</span>
        </span>
        <span class="unit-row-go">${u.questions === 0 ? '' : '→'}</span>
      </button>`).join('');

    $$('#course-units [data-unit]').forEach((b) => b.addEventListener('click', () => {
      state.scope = { courseId, courseName: course.name, unit: b.dataset.unit };
      showView('learn');
      loadQuestion();
    }));
  } catch (err) { toast(err.message, 'bad'); }
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
          <div class="u-flex-1 u-minw-0">
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

/* Premium modes stay VISIBLE to free users, greyed out with a lock, rather than
 * being hidden. Hiding them makes the app look thin and gives no reason to
 * upgrade; showing them makes the value concrete. The server enforces the
 * actual gate -- this is presentation only. */
function isLockedMode(mode) {
  return (state.premiumModes || []).includes(mode)
    && Boolean(state.user)
    && state.user.plan === 'free';
}

function renderModeLocks() {
  $$('.mode-card').forEach((card) => {
    const locked = isLockedMode(card.dataset.mode);
    card.classList.toggle('locked', locked);
    let badge = card.querySelector('.lock-badge');
    if (locked && !badge) {
      badge = document.createElement('span');
      badge.className = 'lock-badge';
      badge.textContent = 'Premium';
      card.querySelector('h3')?.append(' ');
      card.querySelector('h3')?.append(badge);
    } else if (!locked && badge) {
      badge.remove();
    }
  });
}

function startMode(mode) {
  // A locked card is still clickable: tapping it explains why, instead of
  // doing nothing, which is the usual complaint about gated interfaces.
  if (isLockedMode(mode)) {
    const names = { match: 'Match', test: 'Practice Test', review: 'Review Mistakes', apexam: 'AP Exam practice' };
    showPaywall('mode', { modeName: names[mode], courses: (state.user?.courses || []).length });
    return;
  }
  if (mode === 'apexam') { startApExam(); return; }
  if (mode === 'learn') { showView('learn'); loadQuestion(); }
  else if (mode === 'flashcards') startFlashcards();
  else if (mode === 'match') startMatch();
  else if (mode === 'test') startTest();
  else if (mode === 'review') startReview();
}


// ------------------------------------------------------------------ AP exam
/* The AP flow is deliberately split in two.
 *
 * Section I (multiple choice) is graded exactly -- we know the right answers.
 * The free-response side never claims to grade writing. It reports objective
 * auto-checks (word count, documents cited, parts answered) and then hands the
 * student the real College Board rubric to score themselves against. Anything
 * else would be inventing a number for something a student takes seriously. */
const apState = {
  exam: null, index: 0, answers: {}, timer: null, endsAt: 0, frq: null,
};

function apClearTimer() {
  if (apState.timer) clearInterval(apState.timer);
  apState.timer = null;
}

function apStartTimer(minutes, el, onDone) {
  apClearTimer();
  apState.endsAt = Date.now() + minutes * 60_000;
  const tick = () => {
    const left = Math.max(0, apState.endsAt - Date.now());
    const m = Math.floor(left / 60000);
    const sec = Math.floor((left % 60000) / 1000);
    el.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    el.classList.toggle('timer-low', left < 60_000 && left > 0);
    if (left <= 0) { apClearTimer(); if (onDone) onDone(); }
  };
  tick();
  apState.timer = setInterval(tick, 1000);
}

function apShow(pane) {
  ['ap-picker', 'ap-brief', 'ap-mcq', 'ap-results', 'ap-frq']
    .forEach((id) => $(`#${id}`).classList.toggle('hidden', id !== pane));
}

async function startApExam() {
  showView('apexam');
  apClearTimer();
  apShow('ap-picker');

  const list = $('#ap-course-list');

  /* /api/ap/coverage returns exactly the AP courses, so intersecting against it
   * decides membership. Filtering on the user payload directly does not work:
   * publicUser() exposes levelLabel ("AP") but not level ("ap"), so a naive
   * c.level check silently matched nothing and the picker came up empty. */
  let coverage = [];
  try { coverage = (await api('GET', '/api/ap/coverage')).courses || []; } catch { /* signed out */ }
  const byId = new Map(coverage.map((c) => [c.id, c]));
  const mine = (state.user?.courses || []).filter((c) => byId.has(c.id));

  if (mine.length === 0) {
    $('#ap-picker-sub').textContent = 'You are not enrolled in any AP classes yet.';
    list.innerHTML = `<p class="muted">Add an AP course from the Courses tab and it will show up here.</p>`;
    return;
  }
  $('#ap-picker-sub').textContent = 'Pick one of your AP classes.';

  list.innerHTML = mine.map((c) => {
    const cov = byId.get(c.id) || {};
    // Say plainly which exams we have verified rather than implying all are equal.
    const tag = cov.verifiedFormat
      ? `<span class="pill pill-ap">Official format</span>`
      : cov.portfolio
        ? `<span class="pill pill-honors">Portfolio course</span>`
        : `<span class="pill pill-regular">Format not verified</span>`;
    const frq = cov.frqCount ? `<span class="dim">${cov.frqCount} free-response</span>` : '';
    return `<button class="course-card" data-ap="${esc(c.id)}">
        <span class="course-card-title">${esc(c.name)}</span>
        <span class="row u-g-p5rem">${tag} ${frq}</span>
      </button>`;
  }).join('');

  $$('#ap-course-list [data-ap]').forEach((b) =>
    b.addEventListener('click', () => loadApExam(b.dataset.ap)));
}

async function loadApExam(courseId) {
  try {
    // 20 is a realistic sitting for practice; the brief still states the
    // official section length so the student knows what the real thing is.
    const { exam } = await api('GET', `/api/ap/exam?courseId=${encodeURIComponent(courseId)}&mcqLimit=20`);
    apState.exam = exam;
    apState.answers = {};
    apState.index = 0;

    $('#ap-brief-title').textContent = exam.name;

    if (!exam.verified) {
      $('#ap-brief-delivery').textContent = 'Unverified';
      $('#ap-brief-body').innerHTML = `<div class="banner">${esc(exam.message)}</div>
        <p class="muted"><a href="${esc(exam.officialUrl)}" target="_blank" rel="noopener noreferrer">Check the official format on College Board</a></p>`;
      $('#ap-start-mcq').classList.add('hidden');
      $('#ap-start-frq').classList.add('hidden');
      apShow('ap-brief');
      return;
    }

    $('#ap-brief-delivery').textContent = exam.delivery === 'hybrid' ? 'Hybrid digital' : 'Fully digital';
    const rows = exam.sections.map((s) => `
      <tr><td><strong>${esc(s.label)}</strong><div class="dim">${esc(s.note || '')}</div></td>
          <td>${s.count} q</td><td>${s.minutes} min</td><td>${s.weight}%</td></tr>`).join('');

    $('#ap-brief-body').innerHTML = `
      <div class="banner u-mb-1rem">
        <strong>${exam.durationMin} minutes</strong> total &middot; ${esc(exam.examDate)} &middot; ${esc(exam.calculator)}
      </div>
      <table class="ap-table"><thead><tr><th>Section</th><th>Questions</th><th>Time</th><th>Weight</th></tr></thead>
        <tbody>${rows}</tbody></table>
      <p class="dim u-mt-1rem">Format verified against
        <a href="${esc(exam.source)}" target="_blank" rel="noopener noreferrer">College Board</a>.
        ${exam.delivery === 'hybrid'
          ? 'On the real exam you type multiple choice in Bluebook and handwrite free response on paper.'
          : 'On the real exam everything is typed in Bluebook.'}</p>`;

    const mcq = exam.sections.find((s) => s.kind === 'mcq');
    $('#ap-start-mcq').classList.toggle('hidden', !mcq || !mcq.servedCount);
    if (mcq && mcq.servedCount) {
      $('#ap-start-mcq').textContent = mcq.servedCount < mcq.officialCount
        ? `Start ${mcq.servedCount} practice questions`
        : 'Start Section I';
    }
    $('#ap-start-frq').classList.toggle('hidden', !(exam.frqs || []).length);
    apShow('ap-brief');
  } catch (err) {
    toast(err.message, 'bad');
    if (err.status === 402) showView('plan');
  }
}

function apRenderQuestion() {
  const mcq = apState.exam.sections.find((s) => s.kind === 'mcq');
  const q = mcq.questions[apState.index];
  const keys = ['A', 'B', 'C', 'D', 'E', 'F'];

  $('#ap-mcq-progress').textContent = `Question ${apState.index + 1} of ${mcq.questions.length}`;
  $('#ap-mcq-bar').style.width = `${((apState.index + 1) / mcq.questions.length) * 100}%`;
  $('#ap-q-prompt').textContent = q.prompt;
  $('#ap-q-choices').innerHTML = q.choices.map((c, i) => `
    <button class="choice-btn${apState.answers[q.id] === i ? ' picked' : ''}" data-i="${i}">
      <span class="choice-key">${keys[i]}</span><span>${esc(c)}</span>
    </button>`).join('');

  $$('#ap-q-choices .choice-btn').forEach((b) => b.addEventListener('click', () => {
    apState.answers[q.id] = Number(b.dataset.i);
    apRenderQuestion();
  }));
  $('#ap-prev').disabled = apState.index === 0;
  $('#ap-next').disabled = apState.index >= mcq.questions.length - 1;
  replayAnimation($('#ap-mcq-card'), 'q-enter');
}

function apStartMcq() {
  const mcq = apState.exam.sections.find((s) => s.kind === 'mcq');
  // Scale the official time to the number actually served, so the pacing
  // pressure matches the real exam even on a shorter practice section.
  const perQuestion = mcq.minutes / mcq.officialCount;
  apState.index = 0;
  apShow('ap-mcq');
  apRenderQuestion();
  apStartTimer(Math.max(1, Math.round(perQuestion * mcq.servedCount)), $('#ap-timer'), () => {
    toast('Time is up. Submitting your section.', 'bad');
    apSubmitMcq();
  });
}

async function apSubmitMcq() {
  apClearTimer();
  try {
    const graded = await api('POST', '/api/ap/grade-mcq', {
      courseId: apState.exam.courseId, answers: apState.answers,
    });
    const mcq = apState.exam.sections.find((s) => s.kind === 'mcq');
    const wrong = graded.results.filter((r) => !r.correct);

    $('#ap-results').innerHTML = `
      <h1 class="u-fs-1p9rem u-mb-p15rem">${graded.correct} / ${graded.total}</h1>
      <p class="muted">${graded.percent}% on this practice section.</p>
      <div class="banner u-mb-1p25rem">
        <strong>Estimated band: ${esc(graded.estimate.band)}</strong>
        <div class="dim">${esc(graded.estimate.note)} This is a rough guide from multiple choice alone.
        Real AP cut scores are set per administration and are not published as fixed percentages.</div>
      </div>
      ${mcq.servedCount < mcq.officialCount
        ? `<p class="dim">You answered ${mcq.servedCount}; the real Section I has ${mcq.officialCount} in ${mcq.minutes} minutes.</p>` : ''}
      <div class="section-head"><h2>What you missed</h2></div>
      ${wrong.length === 0 ? '<p class="muted">Nothing. Every answer was correct.</p>'
        : wrong.map((r) => `<div class="card u-mb-1rem">
            <div class="label">${esc(r.topic)}</div>
            <p class="u-m-0">${esc(r.explanation)}</p></div>`).join('')}
      <div class="row u-mt-1p25rem">
        <button class="btn btn-primary" data-ap-again>Try another section</button>
        ${(apState.exam.frqs || []).length ? '<button class="btn btn-ghost" data-ap-to-frq>Practise free response</button>' : ''}
      </div>`;
    apShow('ap-results');
    // These two buttons are created just above, so they are bound off the
    // container rather than by global id (a global lookup reads as a missing
    // element to the DOM smoke test).
    const out = $('#ap-results');
    out.querySelector('[data-ap-again]').addEventListener('click', () => loadApExam(apState.exam.courseId));
    const toFrq = out.querySelector('[data-ap-to-frq]');
    if (toFrq) toFrq.addEventListener('click', apChooseFrq);
  } catch (err) { toast(err.message, 'bad'); }
}

function apChooseFrq() {
  const list = apState.exam.frqs || [];
  if (!list.length) return;
  apShow('ap-frq');
  $('#ap-frq-out').classList.add('hidden');
  $('#ap-frq-text').value = '';

  if (list.length === 1) { apLoadFrq(list[0]); return; }

  // While choosing, the answer box and timer are hidden: showing an empty
  // textarea and a dead "--:--" clock next to a list of options reads as if
  // the page is half-broken.
  apSetFrqComposer(false);
  $('#ap-frq-type').textContent = 'Choose a question';
  $('#ap-frq-prompt').innerHTML = list.map((f, i) =>
    `<button class="btn btn-ghost btn-block u-mb-p5rem" data-frq="${i}">${esc(f.type)} &middot; ${f.maxPoints} points &middot; ${f.minutes} min</button>`).join('');
  $('#ap-frq-guidance').textContent = '';
  $('#ap-frq-meta').textContent = `${apState.exam.name} · choose a question`;
  $$('#ap-frq-prompt [data-frq]').forEach((b) =>
    b.addEventListener('click', () => apLoadFrq(list[Number(b.dataset.frq)])));
}

/* Toggle the write-and-submit half of the pane. */
function apSetFrqComposer(on) {
  ['ap-frq-text', 'ap-frq-check', 'ap-frq-timer'].forEach((id) =>
    $(`#${id}`).classList.toggle('hidden', !on));
  $('#ap-frq-label').classList.toggle('hidden', !on);
  $('#ap-frq-back').classList.toggle('hidden', !on);
}

function apLoadFrq(frq) {
  apState.frq = frq;
  apSetFrqComposer(true);
  $('#ap-frq-type').textContent = `${frq.type} · ${frq.maxPoints} points`;
  $('#ap-frq-prompt').textContent = frq.prompt;
  $('#ap-frq-guidance').textContent = frq.guidance || '';
  $('#ap-frq-meta').textContent = `${apState.exam.name} · ${frq.minutes} minutes`;
  $('#ap-frq-out').classList.add('hidden');
  $('#ap-frq-text').value = '';
  apStartTimer(frq.minutes, $('#ap-frq-timer'), () => toast('Time is up. Finish your thought, then score yourself.'));
}

async function apCheckFrq() {
  const frq = apState.frq;
  if (!frq) return;
  const text = $('#ap-frq-text').value;
  if (!text.trim()) { toast('Write a response first.'); return; }
  apClearTimer();

  try {
    const res = await api('POST', '/api/ap/check-frq', { text, checks: frq.autoChecks || [] });
    const checks = res.checks.map((c) => `
      <li class="ap-check ${c.pass ? 'ok' : 'no'}">
        <span class="ap-check-mark">${c.pass ? '✓' : '✕'}</span>
        <span><strong>${esc(c.kind)}</strong> — ${esc(c.detail)}</span>
      </li>`).join('');

    const rubric = frq.rubric.map((row, i) => `
      <div class="rubric-row">
        <div class="rubric-head">
          <strong>${esc(row.label)}</strong>
          <span class="dim">0–${row.max}</span>
        </div>
        <p class="dim u-m-0">${esc(row.criteria)}</p>
        <div class="rubric-points" data-row="${i}">
          ${Array.from({ length: row.max + 1 }, (_, n) =>
            `<button class="rubric-pt" data-row="${i}" data-pt="${n}">${n}</button>`).join('')}
        </div>
      </div>`).join('');

    $('#ap-frq-out').innerHTML = `
      <div class="card">
        <h3 class="u-mt-0">Auto-checks</h3>
        <p class="dim">These are countable facts about what you wrote — ${res.words} words,
          ${res.paragraphs} paragraphs. They are not a score, and the ones marked
          "hint" are rough heuristics, not judgements of quality.</p>
        <ul class="ap-checks">${checks}</ul>
      </div>
      <div class="card u-mt-1rem">
        <h3 class="u-mt-0">Score yourself against the real rubric</h3>
        <p class="dim">This is the College Board rubric for this question type. No offline tool can
          honestly judge a thesis or the sophistication of an argument, so you score it —
          reading your own writing against the rubric is most of the learning anyway.</p>
        ${rubric}
        <div class="row-between u-mt-1p25rem">
          <strong>Your score</strong>
          <span class="ap-total" data-ap-total>— / ${frq.maxPoints}</span>
        </div>
      </div>`;
    $('#ap-frq-out').classList.remove('hidden');

    const picked = {};
    $$('#ap-frq-out .rubric-pt').forEach((b) => b.addEventListener('click', () => {
      const row = b.dataset.row;
      picked[row] = Number(b.dataset.pt);
      $$(`#ap-frq-out .rubric-pt[data-row="${row}"]`).forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      const total = Object.values(picked).reduce((a, n) => a + n, 0);
      const done = Object.keys(picked).length === frq.rubric.length;
      $('#ap-frq-out').querySelector('[data-ap-total]').textContent = `${total} / ${frq.maxPoints}${done ? '' : ' (in progress)'}`;
    }));
    $('#ap-frq-out').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) { toast(err.message, 'bad'); }
}

$('#ap-start-mcq').addEventListener('click', apStartMcq);
$('#ap-start-frq').addEventListener('click', apChooseFrq);
$('#ap-prev').addEventListener('click', () => { apState.index--; apRenderQuestion(); });
$('#ap-next').addEventListener('click', () => { apState.index++; apRenderQuestion(); });
$('#ap-submit').addEventListener('click', apSubmitMcq);
$('#ap-frq-check').addEventListener('click', apCheckFrq);
$('#ap-frq-back').addEventListener('click', apChooseFrq);



// ------------------------------------------------------------------ upgrades
/* Quality-of-life work that is invisible when it succeeds. */

/* 1. Offline / connection loss.
 *
 * A student on school wifi drops connection constantly. Without this, every
 * fetch failure surfaced as the generic "Request failed" toast, which reads as
 * "the app is broken" rather than "your wifi died". */
let offlineBannerEl = null;
function setOffline(isOffline) {
  if (!offlineBannerEl) {
    offlineBannerEl = document.createElement('div');
    offlineBannerEl.className = 'offline-banner hidden';
    offlineBannerEl.textContent = 'You are offline. Your progress is saved and will sync when you reconnect.';
    document.body.appendChild(offlineBannerEl);
  }
  offlineBannerEl.classList.toggle('hidden', !isOffline);
  document.body.classList.toggle('is-offline', isOffline);
}
window.addEventListener('offline', () => setOffline(true));
window.addEventListener('online', () => { setOffline(false); toast('Back online.', 'good'); });

/* 2. Double-submit guard.
 *
 * Tapping a button twice on a slow connection fired two requests. On the
 * upgrade button that meant two upgrade attempts. */
function guard(btn, fn) {
  return async (...args) => {
    if (!btn || btn.dataset.busy === '1') return;
    if (btn) { btn.dataset.busy = '1'; btn.classList.add('is-busy'); }
    try { return await fn(...args); }
    finally { if (btn) { btn.dataset.busy = '0'; btn.classList.remove('is-busy'); } }
  };
}

/* 3. Keyboard shortcuts beyond the quiz. Power users navigate far faster, and
 *    it costs nothing to support. */
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  // Escape backs out of anything modal-ish.
  if (e.key === 'Escape') {
    if (!$('#paywall').classList.contains('hidden')) { hidePaywall(); return; }
  }
  // g-then-key: a familiar pattern from Gmail and GitHub.
  if (e.key === 'g') { keyboard.pendingGoto = true; setTimeout(() => { keyboard.pendingGoto = false; }, 900); return; }
  if (keyboard.pendingGoto) {
    const map = { h: 'home', c: 'courses', p: 'progress', s: 'settings', l: 'plan' };
    const dest = map[e.key];
    keyboard.pendingGoto = false;
    if (dest && state.user) { showView(dest); }
  }
});
const keyboard = { pendingGoto: false };

/* 4. Remember where the student was.
 *
 * Reloading mid-session used to dump you back on the home screen. */
function rememberView(name) {
  try { sessionStorage.setItem('keen:view', name); } catch { /* private mode */ }
}
function lastView() {
  try { return sessionStorage.getItem('keen:view'); } catch { return null; }
}

/* 5. Relative time, used by the group chat and bug list. */
function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}


/* ---- count-up numbers on the landing page --------------------------------
 *
 * The big proof numbers animate from 0 to their real value when they scroll
 * into view. Three deliberate choices:
 *
 * 1. IntersectionObserver, not a scroll listener. A scroll handler fires on
 *    every frame of every scroll for the life of the page; the observer fires
 *    once per element and then unobserves itself.
 * 2. requestAnimationFrame with a timestamp, not setInterval. setInterval drifts
 *    and stutters, and rAF is paused automatically in a background tab, so the
 *    animation cannot "finish" while nobody is looking.
 * 3. The real number is already in the HTML. The animation overwrites it and
 *    puts it back at the end, so a browser with no JS, no IntersectionObserver,
 *    or reduced motion enabled simply shows the correct number immediately.
 *    The content never depends on the effect running.
 */
function animateCount(el) {
  const target = Number(el.dataset.count);
  if (!Number.isFinite(target)) return;
  const finish = () => { el.textContent = String(target); };
  if (target === 0) return finish();

  // Browsers pause requestAnimationFrame entirely in a hidden tab. If the
  // element scrolls into view while the tab is in the background, the first
  // frame never arrives, the callback never runs, and the number sits on "0"
  // until the page is reloaded. Testing this in a background tab is exactly how
  // that was found. Show the real value instead of scheduling an animation
  // that cannot start.
  if (document.hidden) return finish();

  const DURATION = 900;
  let started = null;
  // Ease-out cubic: fast at the start, settling at the end. A linear count
  // reads like a loading spinner; the deceleration is what makes it feel like
  // it is arriving at a value.
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const step = (now) => {
    if (started === null) started = now;
    const t = Math.min(1, (now - started) / DURATION);
    el.textContent = String(Math.round(ease(t) * target));
    if (t < 1) requestAnimationFrame(step); else finish();
  };
  requestAnimationFrame(step);
}

function initCountUps() {
  const els = $$('[data-count]');
  if (els.length === 0) return;

  // Respect the OS setting. Someone who has asked for less motion, often
  // because animation makes them ill, should just see the number.
  const reduced = window.matchMedia
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced || !('IntersectionObserver' in window)) return;

  const io = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      obs.unobserve(entry.target);   // count once, never again
      // Zero it here, at the last possible moment, rather than up front. If we
      // blanked every number on load and the animation then failed to run for
      // any reason, the page would display zeros as though they were the data.
      entry.target.textContent = '0';
      animateCount(entry.target);
    });
  }, { threshold: 0.6 });

  els.forEach((el) => io.observe(el));
}

// ------------------------------------------------------------------ rewards
/* XP, level-ups, badges, streaks, and the small sensory rewards that go with
 * them.
 *
 * Sound is opt-out and defaults ON, but it is synthesised with the Web Audio
 * API rather than shipped as audio files: two short tones cost nothing to
 * download and cannot fail to load.
 *
 * Vibration was removed entirely. iOS Safari ignores navigator.vibrate, so it
 * only ever fired on Android, which meant it was a feature that silently did
 * nothing for most users and could not be relied on for feedback. A setting
 * that does nothing is worse than no setting. */
const rewards = { audio: null };

function soundEnabled() {
  try { return localStorage.getItem('keen:sound') !== 'off'; } catch { return true; }
}
function setSoundEnabled(on) {
  try { localStorage.setItem('keen:sound', on ? 'on' : 'off'); } catch { /* private mode */ }
}

function tone(freqs, duration = 0.12) {
  if (!soundEnabled()) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    rewards.audio = rewards.audio || new Ctx();
    const ctx = rewards.audio;
    // Browsers suspend audio until a gesture; every caller here follows a tap.
    if (ctx.state === 'suspended') ctx.resume();
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const start = ctx.currentTime + i * duration * 0.72;
      gain.gain.setValueAtTime(0.0001, start);
      // Peak was 0.16, which is inaudible over a classroom, headphones at a
      // normal level, or a phone speaker outdoors. A pure sine wave also reads
      // much quieter than its numeric amplitude suggests, because there are no
      // harmonics. 0.52 is loud enough to be felt as feedback and still well
      // under clipping. A triangle wave carries further than a sine at the
      // same amplitude, so the tone also has some body to it now.
      gain.gain.exponentialRampToValueAtTime(0.52, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(start); osc.stop(start + duration + 0.02);
    });
  } catch { /* audio is a nicety, never a failure path */ }
}

const sfx = {
  correct() { tone([660, 880], 0.13); },
  wrong() { tone([220, 165], 0.17); },
  levelUp() { tone([523, 659, 784, 1047], 0.15); },
  badge() { tone([784, 1047, 1319], 0.17); },
};

/* A single celebration queue, so a level-up and two badges at once become one
 * calm sequence rather than three overlapping popups. */
const celebrations = [];
let celebrating = false;

function queueCelebration(html, kind) {
  celebrations.push({ html, kind });
  if (!celebrating) nextCelebration();
}

function nextCelebration() {
  const next = celebrations.shift();
  if (!next) { celebrating = false; return; }
  celebrating = true;

  const el = document.createElement('div');
  el.className = `celebrate celebrate-${next.kind}`;
  el.innerHTML = next.html;
  document.body.appendChild(el);
  if (next.kind === 'level') sfx.levelUp(); else sfx.badge();

  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => { el.remove(); nextCelebration(); }, 320);
  }, 2400);
}

function renderXpBar(prog) {
  const bar = $('#xp-bar');
  if (!bar || !prog) return;
  bar.classList.remove('hidden');
  $('#xp-level').textContent = prog.level;
  $('#xp-fill').style.width = `${prog.percent}%`;
  $('#xp-count').textContent = `${prog.intoLevel} / ${prog.intoLevel + prog.neededForNext} XP`;

  const streak = prog.streak || {};
  const chip = $('#streak-chip');
  if (chip) {
    const has = (streak.current || 0) > 0;
    chip.classList.toggle('hidden', !has);
    if (has) {
      chip.textContent = `${streak.current} day${streak.current === 1 ? '' : 's'}`;
      // At risk means "answered yesterday, nothing today yet". Nudge, do not
      // panic: one question inside the free allowance keeps it alive.
      chip.classList.toggle('at-risk', Boolean(streak.atRisk));
      chip.title = streak.atRisk
        ? 'Answer one question today to keep your streak.'
        : `Best: ${streak.best} days`;
    }
  }
}

/* Called after every answer. */
function applyRewards(data) {
  if (data.correct) sfx.correct(); else sfx.wrong();

  if (data.xp) {
    state.progression = { ...(state.progression || {}), ...data.xp, streak: data.streak };
    renderXpBar({
      level: data.xp.level,
      percent: data.xp.percent,
      intoLevel: data.xp.total,
      neededForNext: 0,
      streak: data.streak,
    });
    if (data.xp.gained > 0) floatXp(data.xp.gained);
    if (data.xp.leveledUp) {
      queueCelebration(
        `<span class="celebrate-icon">▲</span>
         <strong>Level ${data.xp.level}</strong>
         <span>Nice. Keep going.</span>`, 'level');
    }
  }

  (data.newBadges || []).forEach((b) => queueCelebration(
    `<span class="celebrate-icon">${esc(b.icon)}</span>
     <strong>${esc(b.name)}</strong>
     <span>${esc(b.description)}</span>`, 'badge'));
}

function floatXp(amount) {
  const host = $('#quiz-card') || document.body;
  const el = document.createElement('span');
  el.className = 'xp-float';
  el.textContent = `+${amount} XP`;
  host.appendChild(el);
  setTimeout(() => el.remove(), 1100);
}

// ------------------------------------------------------------------ paywall
/* Conversion prompts.
 *
 * Three triggers, one component:
 *   'midway'   a soft, dismissible prompt part-way through a free session,
 *              shown while the student is engaged rather than after they have
 *              already been cut off.
 *   'limit'    the hard wall when the daily quota is gone.
 *   'mode'     tapping a locked study mode.
 *
 * Deliberately NOT used here: fake countdowns, invented scarcity, or a hidden
 * dismiss button. The audience is teenagers, and a prompt that has to trick
 * someone to convert is one that produces refunds and complaints from parents.
 * Everything below is true: the limits are real and the free tier really does
 * stay free. */
const paywall = {
  shownThisSession: new Set(),
  // Annual is preselected: it is the better deal for the student AND the
  // better outcome for the business, so it should not be the hidden option.
  interval: 'annual',
};

function paywallCopy(trigger, ctx = {}) {
  if (trigger === 'limit') {
    return {
      kicker: 'Daily limit reached',
      title: 'You are out of questions for today.',
      sub: `You answered all ${ctx.limit || 5}. Premium removes the cap entirely, so a study session ends when you decide it does.`,
    };
  }
  if (trigger === 'reviewLimit') {
    return {
      kicker: 'Review limit reached',
      title: `That is your ${ctx.limit || 5} free review questions for today.`,
      sub: 'Reviewing what you got wrong is the fastest way to fix it. Premium gives you the whole weak-topic queue, every day.',
    };
  }
  if (trigger === 'mode') {
    return {
      kicker: 'Premium feature',
      title: `${ctx.modeName || 'That mode'} is part of Premium.`,
      sub: 'Match, Practice Test, Review and full AP exam practice all come with it.',
    };
  }
  return {
    kicker: 'You are on a roll',
    title: ctx.remaining === 1
      ? 'One question left today.'
      : `${ctx.remaining} questions left today.`,
    // The "5" here was hardcoded while the Learn allowance is 3, so the paywall
    // said "2 questions left today. Free accounts get 5 a day." directly above
    // a stat reading "1 question today". Three numbers, two of them disagreeing.
    // Read the real limit off the quota the server just sent.
    sub: ctx.limit
      ? `Free accounts get ${ctx.limit} a day. You are mid-session and about to run out. Premium keeps it going.`
      : 'You are mid-session and about to run out. Premium keeps it going.',
  };
}

function showPaywall(trigger, ctx = {}) {
  const el = $('#paywall');
  const copy = paywallCopy(trigger, ctx);

  $('#paywall-kicker').textContent = copy.kicker;
  $('#paywall-title').textContent = copy.title;
  $('#paywall-sub').textContent = copy.sub;

  // Personalised, factual stats. Nothing invented: these come from the
  // student's own record.
  const q = state.user?.quota || {};
  const stats = [];
  if (Number.isFinite(q.used)) stats.push([q.used, q.used === 1 ? 'question today' : 'questions today']);
  if (ctx.streak > 1) stats.push([ctx.streak, 'in a row']);
  if (ctx.courses) stats.push([ctx.courses, ctx.courses === 1 ? 'class added' : 'classes added']);
  $('#paywall-stats').innerHTML = stats.map(([n, label]) =>
    `<div class="paywall-stat"><strong>${esc(String(n))}</strong><span>${esc(label)}</span></div>`).join('');

  el.classList.remove('hidden');
  document.body.classList.add('modal-open');
  // Hard wall cannot be dismissed back into questions there are none of.
  const hardWall = trigger === 'limit' || trigger === 'reviewLimit';
  $('#paywall-dismiss').textContent = hardWall ? 'Back to study modes' : 'Not now';
  paywall.lastTrigger = trigger;
}

function hidePaywall() {
  $('#paywall').classList.add('hidden');
  document.body.classList.remove('modal-open');
  if (paywall.lastTrigger === 'limit' || paywall.lastTrigger === 'reviewLimit') showView('home');
}

/* ---- group invite codes ----------------------------------------------------
 *
 * Codes are valid for two minutes. That is short enough that the countdown has
 * to be visible, or the feature just reads as broken: you would show someone a
 * code, they would type it, and it would be rejected with no explanation.
 *
 * One interval for the whole screen, cleared whenever the code is repainted or
 * the view changes. A timer per render leaks one interval per navigation, and
 * on a page people leave open all evening that adds up.
 */
let inviteTimer = null;

function stopInviteTimer() {
  if (inviteTimer) { clearInterval(inviteTimer); inviteTimer = null; }
}

function paintInviteCode(code, expiresAt) {
  stopInviteTimer();
  const codeEl = $('#group-code');
  const timerEl = $('#group-code-timer');
  const btn = $('#group-code-new');
  if (!codeEl || !timerEl || !btn) return;

  if (!code || !expiresAt) {
    codeEl.textContent = '······';
    codeEl.classList.add('is-empty');
    timerEl.textContent = 'No active code';
    timerEl.className = 'invite-timer is-dead';
    btn.textContent = 'Get a code';
    return;
  }

  codeEl.textContent = code;
  codeEl.classList.remove('is-empty');
  btn.textContent = 'New code';

  const deadline = Date.parse(expiresAt);
  const tick = () => {
    const left = deadline - Date.now();
    if (left <= 0) {
      // Expire it in the UI at the same moment the server would reject it, so
      // nobody reads out a code that has already stopped working.
      stopInviteTimer();
      paintInviteCode(null, null);
      return;
    }
    const secs = Math.ceil(left / 1000);
    timerEl.textContent = `Expires in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    timerEl.className = `invite-timer${secs <= 30 ? ' is-urgent' : ''}`;
  };
  tick();
  inviteTimer = setInterval(tick, 250);
}

const inviteBtn = $('#group-code-new');
if (inviteBtn) {
  inviteBtn.addEventListener('click', async () => {
    inviteBtn.disabled = true;
    try {
      const r = await api('POST', '/api/groups/invite');
      paintInviteCode(r.inviteCode, r.inviteExpiresAt);
      toast('New code. Valid for two minutes.', 'good');
    } catch (err) { toast(err.message, 'bad'); }
    inviteBtn.disabled = false;
  });
}

/* Show the mid-session prompt once per day per account, at the point where the
 * student is engaged but close to the cap. Repeating it every session would be
 * nagging, and nagging is what makes people uninstall. */
function maybeMidSessionPaywall(quota, streak) {
  if (!state.user || state.user.plan !== 'free') return;
  if (!quota || quota.limit === null) return;
  const key = `mid-${new Date().toDateString()}`;
  if (paywall.shownThisSession.has(key)) return;
  // Trigger with 2 left: enough runway that "keep going" is a real offer.
  if (quota.remaining > 2 || quota.remaining <= 0) return;
  paywall.shownThisSession.add(key);
  showPaywall('midway', {
    remaining: quota.remaining,
    limit: quota.limit,          // so the copy quotes the real allowance
    streak,
    courses: (state.user.courses || []).length,
  });
}

function renderQuotaMeter(quota) {
  const meter = $('#quota-meter');
  if (!meter) return;
  const free = state.user && state.user.plan === 'free' && quota && quota.limit !== null;
  meter.classList.toggle('hidden', !free);
  if (!free) { $('#quota-note').textContent = quota && quota.limit === null ? 'Unlimited' : ''; return; }

  // Pips make the cap concrete in a way "3 left" does not.
  $('#quota-pips').innerHTML = Array.from({ length: quota.limit }, (_, i) =>
    `<span class="pip${i < quota.used ? ' spent' : ''}"></span>`).join('');
  $('#quota-note').textContent = `${quota.remaining} of ${quota.limit} left today`;
  $('#quota-note').classList.toggle('quota-low', quota.remaining <= 2);
}

$('#paywall-interval').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-interval]');
  if (!btn) return;
  paywall.interval = btn.dataset.interval;
  $$('#paywall-interval .seg-btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.interval === paywall.interval));
  const annual = paywall.interval === 'annual';
  $('#paywall-amount').textContent = annual ? '$29.99' : '$4.99';
  $('#paywall-period').textContent = annual ? '/year' : '/month';
  $('#paywall-equiv').textContent = annual ? 'works out at $2.50 a month' : 'billed monthly, cancel any time';
});

$('#paywall-dismiss').addEventListener('click', hidePaywall);
$('#paywall-upgrade').addEventListener('click', async () => {
  const btn = $('#paywall-upgrade');
  const original = btn.textContent;
  btn.disabled = true;
  // Creating a Stripe Checkout session is a server-to-Stripe round trip, so
  // there is a real second or two here where nothing visibly happens. Without
  // a label change the button just looks dead and people click it again.
  btn.textContent = 'Taking you to checkout…';
  try {
    const d = await api('POST', '/api/billing/premium', { interval: paywall.interval });
    if (d.url) {
      // Tear the overlay down BEFORE leaving the page.
      //
      // This was the scroll bug. body.modal-open sets overflow:hidden. We used
      // to navigate to Stripe with it still applied, and when the student
      // pressed Back the browser restored the page from the back/forward cache
      // with the DOM byte-for-byte as it was -- overlay class included. The
      // paywall itself was gone from view, so all you noticed was that the page
      // would no longer scroll, with no way to fix it but a reload.
      closeOverlays();
      window.location.href = d.url;
      return;
    }
    state.user = d.user;
    hidePaywall();
    renderChrome(); renderModeLocks(); renderUpsellBanner();
    toast('You are on Premium. Everything is unlocked.', 'good');
    if (state.view === 'learn') loadQuestion();
  } catch (err) { toast(err.message, 'bad'); }
  finally { btn.disabled = false; btn.textContent = original; }
});

/* Belt and braces for the same class of bug.
 *
 * pageshow fires on a normal load AND on a back/forward-cache restore, and
 * event.persisted tells you which. Clearing overlay state here means that no
 * matter how the page was left -- Stripe, an external link, a mis-timed
 * navigation -- coming back never leaves the body stuck at overflow:hidden.
 * Any future code that forgets to clean up is covered too. */
window.addEventListener('pageshow', (e) => {
  if (e.persisted) closeOverlays();
});

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
    renderQuotaMeter(data.quota);

    const keys = ['A', 'B', 'C', 'D', 'E', 'F'];
    $('#q-choices').innerHTML = data.question.choices.map((c, i) => `
      <button class="choice-btn" data-i="${i}">
        <span class="choice-key">${keys[i]}</span><span>${esc(c)}</span>
      </button>`).join('');
    $$('#q-choices .choice-btn').forEach((b) =>
      b.addEventListener('click', () => submitAnswer(Number(b.dataset.i))));

    replayAnimation($('#quiz-card'), 'q-enter');
  } catch (err) {
    $('#quiz-card').classList.add('hidden');
    $('#quiz-empty').classList.remove('hidden');
    if (err.status === 402) {
      // Hard wall rather than a sad empty state: this is the highest-intent
      // moment a free user ever reaches.
      showPaywall('limit', { limit: state.user?.quota?.limit || 5 });
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
    if (state.user) state.user.quota = data.quota;
    renderQuotaMeter(data.quota);
    applyRewards(data);
    maybeMidSessionPaywall(data.quota, p.streak);
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

  const hint = $('#flash-swipe-hint');
  if (hint) {
    hint.innerHTML = swipeEnabled()
      ? `<div class="swipe-legend">
           <span class="sl-retest">← Swipe left: <b>retest</b></span>
           <span class="sl-know">Swipe right: <b>got it</b> →</span>
         </div>`
      // Free users are told what swiping does, not blocked mid-gesture. The
      // deck still works exactly as it always has for them.
      : `<p class="hint center dim">Premium adds swipe sorting: right to drop a card you know,
         left to send it back into the deck.</p>`;
  }
}

function flipCard() { state.flash.flipped = !state.flash.flipped; renderFlash(); }
$('#flash-card').addEventListener('click', flipCard);
$('#flash-prev').addEventListener('click', () => {
  if (state.flash.index > 0) { state.flash.index--; state.flash.flipped = false; renderFlash(); }
});
$('#flash-next').addEventListener('click', () => advanceFlash());

/* ---- swipe to sort ---------------------------------------------------------
 *
 * Premium only. Swipe right means you knew it and the card leaves the deck.
 * Swipe left means retest, and the card is pushed back into the deck rather
 * than dropped, so the run is not over until you have actually got them all.
 *
 * Free users keep the deck exactly as it was: Previous, Next, flip. Nothing is
 * taken away from them, which matters because a paywall that removes something
 * people already had is the fastest way to make them quit. This is why the
 * pointer handlers refuse to arm at all on the free plan rather than arming and
 * then showing an upgrade prompt mid-gesture.
 *
 * Pointer Events, not touchstart/touchmove: one code path covers finger, mouse
 * and stylus, and setPointerCapture means a fast flick that leaves the element
 * still delivers its pointerup.
 */
function swipeEnabled() {
  return Boolean(state.user) && state.user.plan !== 'free';
}

function advanceFlash() {
  const f = state.flash;
  if (f.index < f.cards.length - 1) {
    f.index++; f.flipped = false; renderFlash();
  } else {
    toast('Deck complete.', 'good');
    showView('home');
  }
}

/** Right: known, remove it. Left: retest, requeue it a few cards later. */
function sortFlash(direction) {
  const f = state.flash;
  const card = f.cards[f.index];
  if (!card) return;

  if (direction === 'right') {
    f.known = (f.known || 0) + 1;
    f.cards.splice(f.index, 1);
    if (f.index >= f.cards.length) f.index = Math.max(0, f.cards.length - 1);
    if (f.cards.length === 0) {
      toast(`Deck cleared. ${f.known} known.`, 'good');
      showView('home');
      return;
    }
  } else {
    // Move it back by three, or to the end if the deck is short. Putting it
    // straight to the end means you see it once more at best; three back means
    // it comes round again while it is still fresh, which is the point.
    const [c] = f.cards.splice(f.index, 1);
    const target = Math.min(f.cards.length, f.index + 3);
    f.cards.splice(target, 0, c);
    f.retested = (f.retested || 0) + 1;
    if (f.index >= f.cards.length) f.index = 0;
  }
  f.flipped = false;
  renderFlash();
}

(function bindFlashSwipe() {
  const card = $('#flash-card');
  if (!card) return;
  let startX = 0, startY = 0, dx = 0, dragging = false, moved = false;
  const THRESHOLD = 70;   // px before a drag counts as a swipe

  card.addEventListener('pointerdown', (e) => {
    if (!swipeEnabled()) return;
    dragging = true; moved = false;
    startX = e.clientX; startY = e.clientY; dx = 0;
    card.setPointerCapture(e.pointerId);
    card.classList.add('is-dragging');
  });

  card.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    dx = e.clientX - startX;
    const dy = e.clientY - startY;
    // A mostly-vertical drag is the user scrolling the page, not sorting.
    if (!moved && Math.abs(dy) > Math.abs(dx)) { dragging = false; card.classList.remove('is-dragging'); return; }
    if (Math.abs(dx) > 4) moved = true;
    card.style.transform = `translateX(${dx}px) rotate(${dx * 0.04}deg)`;
    card.style.opacity = String(Math.max(0.45, 1 - Math.abs(dx) / 420));
    card.dataset.swipe = Math.abs(dx) < THRESHOLD ? '' : (dx > 0 ? 'right' : 'left');
  });

  const release = () => {
    if (!dragging) return;
    dragging = false;
    card.classList.remove('is-dragging');
    card.style.transform = '';
    card.style.opacity = '';
    card.dataset.swipe = '';
    if (Math.abs(dx) >= THRESHOLD) sortFlash(dx > 0 ? 'right' : 'left');
    dx = 0;
  };
  card.addEventListener('pointerup', release);
  card.addEventListener('pointercancel', release);

  // A drag must not also register as a click, or every swipe would flip the
  // card on the way past.
  card.addEventListener('click', (e) => {
    if (moved) { e.stopImmediatePropagation(); moved = false; }
  }, true);
})();

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
        <div class="stat-value u-fs-3p2rem">${graded.percent}%</div>
        <p class="muted">${graded.correct} of ${graded.total} correct</p>
        <button class="btn btn-primary" data-back="home">Back to study</button>
      </div>
      ${graded.results.map((r) => `
        <div class="card">
          <div class="row u-g-p5rem u-mb-p5rem">
            <span class="chip ${r.correct ? 'chip-easy' : 'chip-hard'}">${r.correct ? 'Correct' : 'Missed'}</span>
            <span class="dim">${esc(r.topic)}</span>
          </div>
          <p class="u-ws-pre-wrap u-fwt-500">${esc(r.prompt)}</p>
          <p class="dim">Correct answer: <strong class="u-c-good">${esc(r.choices[r.correctChoice])}</strong></p>
          <p class="muted u-fs-p9rem u-m-0">${esc(r.explanation)}</p>
        </div>`).join('')}`;
    $$('#test-results [data-back]').forEach((b) => b.addEventListener('click', () => showView('home')));
  } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ review
async function startReview() {
  try {
    const { questions, quota } = await api('GET', '/api/modes/review');
    if (quota) renderQuotaMeter(quota);
    if (questions.length === 0) {
      toast('Nothing to review yet. Miss a few questions first.', '');
      return;
    }
    state.test = { questions, index: 0, answers: {}, start: Date.now() };
    showView('test');
    $('#test-results').classList.add('hidden');
    $('#test-active').classList.remove('hidden');
    renderTest();
  } catch (err) {
    if (err.status === 402) { showPaywall('reviewLimit', { limit: err.data?.quota?.limit || 5 }); return; }
    toast(err.message, 'bad');
  }
}

// ------------------------------------------------------------------ courses
async function loadCourses() {
  $('#course-detail').classList.add('hidden');
  $('#course-browse').classList.remove('hidden');
  try {
    // Enrolment first: every row needs to know whether to show Add or Added,
    // and landing straight on this tab means state.myCourses may be empty.
    const { courses } = await api('GET', '/api/my-courses');
    state.myCourses = courses || [];
  } catch { /* signed out; rows fall back to "Add" */ }
  try {
    const { groups, stats } = await api('GET', '/api/courses');
    $('#catalog-stats').textContent = `${stats.courses} courses · ${stats.units} units mapped`;
    renderCourseGroups(groups);
  } catch (err) { toast(err.message, 'bad'); }
}

/* The set of course ids the student has actually enrolled in. Kept as a Set so
 * every row can answer "am I already in this?" without a lookup per render. */
function myCourseIds() {
  return new Set((state.myCourses || []).map((c) => c.id));
}

/**
 * Add or drop a class, then refresh anything showing the enrolment.
 *
 * This endpoint takes the WHOLE list, not a delta, so both directions are the
 * same call with a different array.
 */
async function setEnrolled(courseId, enrolled) {
  const ids = myCourseIds();
  if (enrolled) ids.add(courseId); else ids.delete(courseId);
  try {
    await api('POST', '/api/my-courses', { courseIds: [...ids] });
    const { courses } = await api('GET', '/api/my-courses');
    state.myCourses = courses || [];
    if (state.user) state.user.courses = state.myCourses;
    toast(enrolled ? 'Added to your classes.' : 'Removed from your classes.', enrolled ? 'good' : '');
    return true;
  } catch (err) {
    toast(err.message, 'bad');
    return false;
  }
}

function renderCourseGroups(groups) {
  const mine = myCourseIds();
  $('#course-groups').innerHTML = groups.map((g) => `
    <div class="card">
      <h2>${esc(g.category)}</h2>
      <div class="stack u-g-p4rem u-mt-p75rem">
        ${g.courses.map((c) => `
          <div class="course-row-wrap">
            <button class="course-row course-open" data-id="${esc(c.id)}">
              <span class="course-row-name">${esc(c.name)}</span>
              <span class="dim">${c.units.length} units</span>
              ${levelPill(c.levelLabel)}
            </button>
            <button class="course-add${mine.has(c.id) ? ' is-added' : ''}"
                    data-add="${esc(c.id)}"
                    title="${mine.has(c.id) ? 'Remove from my classes' : 'Add to my classes'}"
                    aria-pressed="${mine.has(c.id)}">${mine.has(c.id) ? '✓' : '+'}<span class="sr-only">${mine.has(c.id) ? 'Remove' : 'Add'} ${esc(c.name)}</span></button>
          </div>`).join('')}
      </div>
    </div>`).join('');
  $$('#course-groups .course-open').forEach((b) =>
    b.addEventListener('click', () => openCourse(b.dataset.id)));

  // Adding is a one-tap action from the list. Making the student open the
  // course first, then find a button, is what made "add a class" feel missing.
  $$('#course-groups [data-add]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.add;
    const nowEnrolled = !myCourseIds().has(id);
    b.disabled = true;
    if (await setEnrolled(id, nowEnrolled)) {
      b.textContent = nowEnrolled ? '✓' : '+';
      b.classList.toggle('is-added', nowEnrolled);
      b.setAttribute('aria-pressed', String(nowEnrolled));
      b.title = nowEnrolled ? 'Remove from my classes' : 'Add to my classes';
    }
    b.disabled = false;
  }));
}

$('#course-search').addEventListener('input', async (e) => {
  const q = e.target.value.trim();
  try {
    const { groups } = await api('GET', `/api/courses${q ? `?search=${encodeURIComponent(q)}` : ''}`);
    renderCourseGroups(groups);
  } catch (err) { toast(err.message, 'bad'); }
});

async function openCourse(courseId) {
  // Already on this tab in the normal case; re-entering would re-run
  // loadCourses and fight this function over which panel is visible.
  if (state.view !== 'courses') showView('courses');
  let data;
  try {
    data = await api('GET', `/api/course?id=${encodeURIComponent(courseId)}`);
  } catch (err) { toast(err.message, 'bad'); return; }
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

  // Add / remove from this screen too, so whichever route the student took to
  // get here ends in the same obvious action.
  const paintAdd = () => {
    const added = myCourseIds().has(data.course.id);
    const btn = $('#cd-add');
    btn.textContent = added ? 'Remove from my classes' : 'Add to my classes';
    btn.classList.toggle('btn-primary', !added);
  };
  paintAdd();
  $('#cd-add').onclick = async () => {
    const btn = $('#cd-add');
    btn.disabled = true;
    await setEnrolled(data.course.id, !myCourseIds().has(data.course.id));
    paintAdd();
    btn.disabled = false;
  };

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
    <div class="bar"><span data-width="${p === null ? 0 : p}" data-bg="${barColor(p)}"></span></div>
    <div class="pct" data-color="${barColor(p)}">${p === null ? '—' : `${p}%`}</div>
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
    <div class="card stat-card"><div class="stat-value u-c-good">${t.topicsMastered}</div><div class="stat-label">Mastered</div></div>`;

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
  paintInviteCode(g.inviteCode, g.inviteExpiresAt);
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
    if (d.url) { closeOverlays(); window.location.href = d.url; return; }
    state.user = d.user; toast(d.message || 'Group activated.', 'good'); loadGroup();
  } catch (err) { toast(err.message, 'bad'); }
});

// ------------------------------------------------------------------ plan
async function loadPlan() {
  $('#plan-label').textContent = state.user.planLabel;
  $('#upgrade-btn').classList.toggle('hidden', state.user.plan !== 'free');
  // Was also hidden whenever billingMode !== 'demo', so the button vanished for
  // every real paying customer the moment Stripe went live -- the exact people
  // who need it. Show it to anyone who is not on the free plan; what it does
  // then depends on the mode, and the server decides that.
  $('#cancel-btn').classList.toggle('hidden', state.user.plan === 'free');
  $('#cancel-btn').textContent = state.user.billingMode === 'demo'
    ? 'Cancel subscription'
    : 'Manage or cancel subscription';
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
    if (d.url) { closeOverlays(); window.location.href = d.url; return; }
    state.user = d.user; toast('Upgraded. Everything is unlocked.', 'good');
    loadPlan(); renderChrome(); renderModeLocks(); renderUpsellBanner();
  } catch (err) { toast(err.message, 'bad'); }
});
$('#cancel-btn').addEventListener('click', async () => {
  const btn = $('#cancel-btn');
  btn.disabled = true;
  try {
    const d = await api('POST', '/api/billing/cancel', {});
    if (d.url) {
      // Live billing: Stripe's own portal handles the cancellation, and also
      // updating a card and viewing invoices. closeOverlays() first for the
      // same bfcache reason as checkout.
      closeOverlays();
      window.location.href = d.url;
      return;
    }
    // Demo mode downgrades on the spot. Locks and the upsell banner have to
    // come BACK, not just go away on upgrade, or a cancelled account keeps
    // premium modes unlocked in the UI until a full reload.
    state.user = d.user;
    toast('Back on the Free plan.');
    loadPlan(); renderChrome(); renderModeLocks(); renderUpsellBanner();
  } catch (err) { toast(err.message, 'bad'); }
  finally { btn.disabled = false; }
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

/* A card row. Numbered, labelled, and with the two fields stacked on a phone.
 * The old row was three bare controls in a line with placeholder text as the
 * only label, which is why it felt sharp and unfinished: placeholders vanish
 * the moment you type, so half way through filling it in you could no longer
 * tell which box was which. */
function cardRowHtml(front = '', back = '') {
  return `<div class="card-editor-row">
    <span class="cr-num"></span>
    <div class="cr-fields">
      <label class="cr-field">
        <span class="cr-label">Term</span>
        <input type="text" class="cr-front" value="${esc(front)}" maxlength="200"
               placeholder="mitochondrion">
      </label>
      <label class="cr-field">
        <span class="cr-label">Definition</span>
        <input type="text" class="cr-back" value="${esc(back)}" maxlength="500"
               placeholder="the organelle that produces most of a cell's ATP">
      </label>
    </div>
    <button type="button" class="cr-del" title="Remove this card" aria-label="Remove this card">×</button>
  </div>`;
}

/** Live count of complete cards, plus a Save button that explains itself. */
function refreshSetState() {
  const rows = $$('#set-cards .card-editor-row');
  rows.forEach((row, i) => {
    const n = row.querySelector('.cr-num');
    if (n) n.textContent = String(i + 1);
    // Mark half-finished rows so an obviously incomplete card is visible
    // before you press Save rather than after.
    const f = row.querySelector('.cr-front').value.trim();
    const b = row.querySelector('.cr-back').value.trim();
    row.classList.toggle('is-partial', Boolean(f) !== Boolean(b));
  });

  const done = collectCards().length;
  const need = 4;
  const prog = $('#set-progress');
  if (prog) {
    prog.textContent = `${done} of ${need} ready`;
    prog.classList.toggle('is-ready', done >= need);
  }
  const save = $('#save-set');
  if (save) {
    const titled = Boolean($('#set-title').value.trim());
    save.disabled = done < need || !titled;
    save.textContent = save.disabled
      ? (!titled ? 'Add a title to save' : `Add ${need - done} more card${need - done === 1 ? '' : 's'}`)
      : 'Save set';
  }
}

function bindCardRows() {
  $$('#set-cards .cr-del').forEach((b) => b.addEventListener('click', () => {
    if ($$('#set-cards .card-editor-row').length > 1) {
      b.closest('.card-editor-row').remove();
      refreshSetState();
    }
  }));
  $$('#set-cards input').forEach((i) => i.addEventListener('input', refreshSetState));
  refreshSetState();
}

async function openSetEditor(setId = null) {
  editingSetId = setId;
  showView('set');
  $('#set-msg').textContent = '';
  $('#delete-set').classList.toggle('hidden', !setId);

  // Offer the student's own classes so a set can be linked to one. That link
  // is what lets /api/set/quiz pull real answers from the course bank.
  const sel = $('#set-course');
  if (sel) {
    if (!state.myCourses || state.myCourses.length === 0) {
      try { state.myCourses = (await api('GET', '/api/my-courses')).courses || []; } catch { /* offline */ }
    }
    sel.innerHTML = '<option value="">Not tied to a class</option>'
      + (state.myCourses || []).map((c) =>
        `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  }

  if (setId) {
    const { set } = await api('GET', `/api/set?id=${setId}`);
    $('#set-heading').textContent = 'Edit study set';
    $('#set-title').value = set.title;
    if (sel) sel.value = set.courseId || '';
    $('#set-cards').innerHTML = set.cards.length
      ? set.cards.map((c) => cardRowHtml(c.front, c.back)).join('')
      : cardRowHtml();
  } else {
    $('#set-heading').textContent = 'Create a study set';
    $('#set-title').value = '';
    if (sel) sel.value = '';
    $('#set-cards').innerHTML = cardRowHtml() + cardRowHtml() + cardRowHtml() + cardRowHtml();
  }
  $('#set-title').oninput = refreshSetState;
  bindCardRows();
}

$('#new-set-btn').addEventListener('click', () => openSetEditor(null));
$('#add-card-row').addEventListener('click', () => {
  $('#set-cards').insertAdjacentHTML('beforeend', cardRowHtml());
  bindCardRows();
  // Put the cursor in the row that was just created. Without this you have to
  // scroll down and tap it yourself every single time, which is the single
  // most annoying thing about writing a long set.
  const rows = $$('#set-cards .card-editor-row');
  const last = rows[rows.length - 1];
  if (last) { last.scrollIntoView({ block: 'center', behavior: 'smooth' }); last.querySelector('.cr-front').focus(); }
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
    const courseId = $('#set-course') ? $('#set-course').value || null : null;
    if (editingSetId) {
      await api('POST', '/api/sets/update', { id: editingSetId, cards, courseId });
    } else {
      const { set } = await api('POST', '/api/sets', { title, cards, courseId });
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
        Answer a few questions and this fills in. Keen starts building a
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
    <h2>What Keen knows about you</h2>
    <p class="muted u-fs-p92rem u-mb-1rem">
      Built from ${p.answered} answer${p.answered === 1 ? '' : 's'} across
      ${p.daysStudied} day${p.daysStudied === 1 ? '' : 's'}.
    </p>

    <div class="profile-grid">
      <div><span class="profile-num">${p.topicsTracked}</span><span class="profile-lbl">topics tracked</span></div>
      <div><span class="profile-num u-c-good">${p.topicsMastered}</span><span class="profile-lbl">mastered</span></div>
      <div><span class="profile-num">${acc}%</span><span class="profile-lbl">accuracy</span></div>
      <div><span class="profile-num">${p.dueNow}</span><span class="profile-lbl">queued for review</span></div>
    </div>

    <div class="label u-m-1p1rem-0-p45rem">Your specific weak spots</div>
    <div class="chip-row">${weak}</div>

    <p class="muted u-fs-p85rem u-mt-1p1rem">
      This profile is yours. It is not a list of popular topics, it is what
      <em>you</em> keep missing, and it gets sharper every session.
    </p>`;
}

// ------------------------------------------------------------------ settings
async function loadSettings() {
  if (!state.user) return;
  const u = state.user;
  renderSettingsSubscription();

  $('#account-kv').innerHTML = `
    <dt>Display name</dt><dd>${esc(u.displayName || '-')}</dd>
    <dt>Email</dt><dd>${esc(u.email || '-')}</dd>
    <dt>Plan</dt><dd>${esc(u.plan || 'free')}</dd>`;
  $('#set-display').value = u.displayName || '';

  $$('[data-theme-choice]').forEach((b) =>
    b.classList.toggle('active', b.dataset.themeChoice === storedTheme()));
  $$('[data-sound-choice]').forEach((b) =>
    b.classList.toggle('active', b.dataset.soundChoice === (soundEnabled() ? 'on' : 'off')));


  loadMyBugs();
}

$('#sound-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-sound-choice]');
  if (!btn) return;
  setSoundEnabled(btn.dataset.soundChoice === 'on');
  $$('[data-sound-choice]').forEach((b) =>
    b.classList.toggle('active', b.dataset.soundChoice === btn.dataset.soundChoice));
  if (btn.dataset.soundChoice === 'on') sfx.correct();   // confirm audibly
});

$('#theme-switch').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-theme-choice]');
  if (btn) setTheme(btn.dataset.themeChoice);
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

$('#settings-signout').addEventListener('click', signOut);

/* ---- subscription controls in Settings -------------------------------------
 *
 * These mirror the Plan screen rather than replacing it. Cancelling is the one
 * thing a paying customer must always be able to find, our Terms name Settings
 * as the place to do it, and on a phone the Plan screen is not even in the nav.
 * Duplicating one button is a smaller sin than a promise the app cannot keep.
 */
function renderSettingsSubscription() {
  if (!state.user) return;
  const free = state.user.plan === 'free';
  const demo = state.user.billingMode === 'demo';

  $('#settings-plan-line').textContent = free
    ? 'You are on the Free plan.'
    : `You are on ${state.user.planLabel || 'Premium'}.`;

  $('#settings-upgrade').classList.toggle('hidden', !free);
  $('#settings-cancel').classList.toggle('hidden', free);
  $('#settings-cancel').textContent = demo ? 'Cancel subscription' : 'Manage or cancel subscription';

  $('#settings-cancel-note').textContent = free
    ? ''
    : demo
      ? 'Demo mode: cancelling takes effect immediately and no money is involved.'
      : 'Opens Stripe, where you can cancel, change card, or view invoices. '
        + 'Cancelling keeps Premium until the end of the period you have paid for.';
}

$('#settings-upgrade').addEventListener('click', () => showView('plan'));

/* ---- account deletion ------------------------------------------------------
 * Two steps on purpose. A single button that wipes everything is too easy to
 * hit by accident, and a typed password is the only confirmation that proves
 * it is the account owner and not somebody who borrowed the laptop.
 */
$('#delete-account-open').addEventListener('click', () => {
  $('#delete-account-confirm').classList.remove('hidden');
  $('#delete-account-password').focus();
});
$('#delete-account-cancel').addEventListener('click', () => {
  $('#delete-account-confirm').classList.add('hidden');
  $('#delete-account-password').value = '';
  $('#delete-account-msg').textContent = '';
});
$('#delete-account-go').addEventListener('click', async () => {
  const btn = $('#delete-account-go');
  const pw = $('#delete-account-password').value;
  if (!pw) { $('#delete-account-msg').textContent = 'Enter your password to confirm.'; return; }
  btn.disabled = true;
  try {
    await api('POST', '/api/account/delete', { password: pw });
    // Everything is gone; there is no state left worth keeping in memory.
    state.user = null;
    state.myCourses = [];
    closeOverlays();
    renderChrome();
    showView('landing');
    toast('Your account and all its data have been deleted.');
  } catch (err) {
    $('#delete-account-msg').textContent = err.message;
  } finally { btn.disabled = false; }
});

$('#settings-cancel').addEventListener('click', async () => {
  const btn = $('#settings-cancel');
  btn.disabled = true;
  try {
    const d = await api('POST', '/api/billing/cancel', {});
    if (d.url) { closeOverlays(); window.location.href = d.url; return; }
    state.user = d.user;
    toast('Back on the Free plan.');
    renderSettingsSubscription();
    renderChrome(); renderModeLocks(); renderUpsellBanner();
  } catch (err) { toast(err.message, 'bad'); }
  finally { btn.disabled = false; }
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
      `<div class="label u-mb-p4rem">Your reports</div>` +
      bugs.map((b) => `<div class="bug-item">
        <span class="status-dot status-${esc(b.status)}"></span>
        <span class="u-flex-1">${esc(b.title)}</span>
        <span class="dim">${esc(b.status)}</span>
      </div>`).join('');
  } catch { /* signed out */ }
}

// ------------------------------------------------------------------ legal modal
/* Minimal Markdown renderer for the legal documents.
 *
 * These docs are ours, served from /legal, so the input is trusted -- but it is
 * still escaped FIRST and only then given structure. That ordering matters: a
 * stray "<script>" in a terms file renders as visible text instead of running.
 * Only the subset the legal files actually use is supported.
 *
 * Previously the modal did esc(markdown) inside a white-space:pre-wrap block,
 * so readers saw the raw "#", "**" and ">" characters. */
function renderMarkdown(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
    // Only http(s) links become anchors, so "javascript:" URLs stay inert text.
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  const out = [];
  let list = null, quote = false, para = [];
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeQuote = () => { if (quote) { out.push('</blockquote>'); quote = false; } };
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushAll = () => { flushPara(); closeList(); closeQuote(); };

  for (const raw of String(src).replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); closeList(); closeQuote(); continue; }
    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { flushAll(); out.push('<hr>'); continue; }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushAll();
      const level = Math.min(heading[1].length + 1, 6); // h1 in a doc becomes h2
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      // Only flush on ENTRY to the quote. Flushing per line would emit one
      // paragraph per source line, breaking **bold** that wraps across lines.
      if (!quote) { flushPara(); closeList(); out.push('<blockquote>'); quote = true; }
      if (bq[1].trim()) para.push(bq[1]); else flushPara();
      continue;
    }
    if (quote) { flushPara(); closeQuote(); }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara();
      const want = bullet ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    para.push(line.trim());
  }
  flushAll();
  return out.join('\n');
}

async function showLegal(doc) {
  try {
    const data = await api('GET', `/api/legal?doc=${doc}`);
    const title = doc === 'privacy' ? 'Privacy Policy' : 'Terms of Service';
    $('#modal-host').innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop">
        <div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <div class="modal-head">
            <h2 class="u-m-0">${esc(title)}</h2>
            <button class="btn btn-sm btn-ghost" id="modal-close">Close</button>
          </div>
          <div class="modal-doc">${renderMarkdown(data.markdown)}</div>
        </div>
      </div>`;
    const host = $('#modal-host');
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const close = () => {
      host.innerHTML = '';
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('modal-open');
    };
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', onKey);
    $('#modal-close').addEventListener('click', close);
    $('#modal-close').focus();
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
  watchForDynamicStyles();

  try {
    const { user, premiumModes, progression, avatars } = await api('GET', '/api/me');
    // Server is the source of truth for which avatars exist.
    if (Array.isArray(avatars) && avatars.length) AVATARS = avatars;
    state.user = user;
    state.progression = progression;
    state.premiumModes = premiumModes || [];
  } catch { state.user = null; }

  if (await handleTokenRoutes()) { renderChrome(); return; }

  renderChrome();
  setOffline(!navigator.onLine);
  // Wire the landing-page counters once the DOM is settled. Safe to call even
  // for a signed-in user: the observer simply never fires on a hidden section.
  initCountUps();

  if (!state.user) showView('landing');
  else if (!state.user.onboarded) startOnboarding();
  else {
    // Land back where you were, but only on a safe view: dropping straight
    // into a half-finished quiz or exam would be worse than going home.
    const SAFE = ['home', 'courses', 'progress', 'plan', 'settings', 'group'];
    const back = lastView();
    showView(SAFE.includes(back) ? back : 'home');
  }
})();
