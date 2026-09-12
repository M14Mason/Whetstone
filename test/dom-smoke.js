'use strict';

/**
 * Browser smoke test.
 *
 * Why this exists: a previous release shipped with a JavaScript crash on load.
 * The API tests all passed because they only ever spoke to the server with
 * fetch. Nothing had actually RENDERED the page, so a mismatch between the
 * markup and the script that drives it sailed straight through.
 *
 * This loads the real page in a real DOM, runs the real app.js against a live
 * server, and fails on any uncaught error. It also cross-checks that every
 * element app.js looks up by id actually exists in index.html.
 *
 * jsdom is a DEV-only dependency and the app still ships with zero runtime
 * dependencies. If jsdom is not installed this test skips loudly rather than
 * failing, so `npm test` works on a bare clone.
 */

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');

let JSDOM; let CookieJar;
try {
  ({ JSDOM, CookieJar } = require('jsdom'));
} catch {
  console.log('\nDOM smoke test SKIPPED (jsdom not installed).');
  console.log('  Install it to enable this check:  npm install --no-save jsdom\n');
  process.exit(0);
}

const TMP_DB = path.join(require('node:os').tmpdir(), `keen-dom-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) {
  if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s);
}

const db = require('../lib/db');
db.init(TMP_DB);
const { createServer } = require('../server');
require('../lib/questions').seed({ quiet: true });

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}`); if (detail) console.log(`        ${detail}`); }
}

// jsdom does not implement these; they are not real failures.
// Third-party resources are unreachable in a sandboxed test run, and an
// analytics tag that fails to load must never read as an application error:
// the app is built to work without it, and treating it as a failure here is
// what trains everyone to ignore a red suite.
const IGNORABLE = /scrollTo|fonts\.googleapis|cloud\.umami\.is|Could not load link|Could not load script|Not implemented/i;

async function loadPage(base, cookie) {
  const errors = [];
  const options = {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
  };
  if (cookie) {
    const jar = new CookieJar();
    jar.setCookieSync(`${cookie}; Path=/`, base);
    options.cookieJar = jar;
  }

  /**
   * jsdom does not implement window.fetch at all. The app calls fetch for
   * everything and swallows failures (so a logged-in user degrades to the
   * landing page rather than a crash), which means without this injection the
   * signed-in assertions would quietly test a logged-out app and always
   * "pass" for the wrong reason.
   *
   * So: hand the page Node's fetch, resolve relative URLs against the server,
   * and attach the session cookie the way a browser would.
   */
  options.beforeParse = (window) => {
    window.fetch = (url, init = {}) => {
      const absolute = String(url).startsWith('http') ? String(url) : new URL(String(url), base).href;
      const headers = { ...(init.headers || {}) };
      if (cookie) headers.Cookie = cookie;
      return fetch(absolute, { ...init, headers });
    };
  };

  const dom = await JSDOM.fromURL(base, options);
  dom.virtualConsole.on('jsdomError', (e) => {
    if (IGNORABLE.test(e.message)) return;
    errors.push(e.message);
  });
  await new Promise((r) => setTimeout(r, 2500));
  return { dom, errors };
}

(async function main() {
  const server = createServer();
  await new Promise((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  console.log(`\nKeen DOM smoke test  (${base})\n`);

  // ---- static cross-check: every id app.js queries must exist in the markup
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  // Some elements are built by app.js itself and never appear in the file. The
  // list used to be maintained by hand, so every new injected element failed
  // this check until somebody remembered to add it here. Any id app.js writes
  // in an id="..." attribute counts as one it creates.
  const RUNTIME_IDS = new Set([
    ...[...js.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
    ...[...js.matchAll(/id='([A-Za-z0-9_-]+)'/g)].map((m) => m[1]),
  ]);
  const missing = referenced.filter((id) => !ids.has(id) && !RUNTIME_IDS.has(id));
  check('every element app.js queries exists in index.html', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');

  // ---- the boot path must never be able to hang
  //
  // The site once sat on a blank page indefinitely: boot() awaited /api/me
  // before painting anything, and fetch has no timeout, so a machine waking
  // from sleep produced a white screen with no error and no way out.
  check('every fetch has a timeout',
    /new AbortController\(\)/.test(js) && /controller\.abort\(\)/.test(js),
    'api() can hang forever without an AbortController timeout');

  check('first paint does not wait on the network',
    /if \(!returning\) showView\('landing'\);/.test(js),
    'boot() must paint before awaiting /api/me, or a slow server shows a blank page');

  // ---- form fields must follow the theme, not a hardcoded colour
  //
  // Every input was hardcoded to #0d0f1a, a blue-black from the old dark
  // theme. Once the light theme landed that was a near-black box containing
  // near-black text: invisible while typing, on the signup form. A theme
  // change must never be able to strand a field colour again.
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'styles.css'), 'utf8');
  check('no dead hardcoded field colour remains',
    !/background:\s*#0d0f1a/.test(css),
    'a field still hardcodes the old dark-theme colour');
  check('field and track colours are defined for both themes',
    (css.match(/--field:/g) || []).length >= 2 && (css.match(/--track:/g) || []).length >= 2,
    'both themes must define --field and --track');

  // ---- the page must stay scrollable -------------------------------------
  //
  // Five scroll-bug reports came from one line: `html, body { overflow-x:
  // hidden }`. Setting overflow on one axis forces the other axis from
  // `visible` to `auto`, so that rule quietly made <body> a scroll container
  // whose content exactly fits it. Nothing to scroll, ever. Paired with
  // `overscroll-behavior-y: none` on the same element, a wheel or trackpad
  // gesture over the page hit that dead container and was refused permission
  // to chain up to <html>, which is what actually scrolls. Dragging the
  // scrollbar still worked, because that drives <html> directly.
  //
  // Both halves are needed for the freeze, so both are asserted.
  const bodyRules = [...css.matchAll(/(^|\})\s*([^{}]+)\{([^}]*)\}/g)]
    .map((m) => ({ selector: m[2].replace(/\s+/g, ' ').trim(), body: m[3] }))
    .filter((r) => /(^|,\s*)body\s*$/.test(r.selector));

  check('body never clips an axis, which would make it a phantom scroll container',
    !bodyRules.some((r) => /overflow(-x|-y)?\s*:/.test(r.body)),
    'a bare `body` rule sets overflow: that forces the other axis to auto and freezes wheel scrolling');
  check('body never blocks scroll chaining to the page',
    !bodyRules.some((r) => /overscroll-behavior(-y)?\s*:\s*(none|contain)/.test(r.body)),
    'overscroll-behavior on body stops the wheel reaching <html>, so only the scrollbar works');
  check('sideways overflow is still clipped, on html',
    /html\s*\{[^}]*overflow-x:\s*hidden/.test(css),
    'nothing clips horizontal overflow any more');

  // The lock that replaced `body.modal-open { overflow: hidden }`, which never
  // worked: body is not the scrolling element, so the gesture went straight
  // past it. Measured at 1000px of movement with the lock supposedly on.
  const appJs = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  check('a dialog locks the page by taking body out of flow',
    /position\s*=\s*'fixed'/.test(appJs) && /syncScrollLock/.test(appJs),
    'the modal scroll lock is missing');
  check('the lock is driven by an observer, not by each call site',
    /MutationObserver\(syncScrollLock\)/.test(appJs),
    'eight call sites add and remove modal-open; any one of them can forget to unlock');

  // ---- nothing third-party may block the first paint
  //
  // This is the bug that made the site look dead: a render-blocking stylesheet
  // on fonts.googleapis.com. The browser paints nothing until it resolves, and
  // on a network that drops the packets rather than refusing them it never
  // resolves. The app must render on its own CSS alone.
  // <noscript> content is inert in a scripting browser, so a fallback
  // stylesheet in there blocks nothing. Strip those before scanning.
  const head = html.slice(0, html.indexOf('</head>'))
    .replace(/<noscript>[\s\S]*?<\/noscript>/g, '');
  const blockingThirdParty = [...head.matchAll(/<link\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((tag) => /rel=["']stylesheet["']/.test(tag))
    .filter((tag) => /https?:\/\//.test(tag))
    .filter((tag) => !/media=["']print["']/.test(tag));
  check('no third-party stylesheet blocks the first paint',
    blockingThirdParty.length === 0,
    blockingThirdParty.join(' | '));

  check('third-party scripts cannot delay DOMContentLoaded',
    !/<script[^>]+src=["']https?:\/\/[^"']+["'][^>]*>/.test(head),
    'a third-party <script> tag in <head> holds up DOMContentLoaded when blocked');

  // ---- onboarding must end in the product, not in a menu
  check('finishing onboarding starts a question',
    /await completeOnboarding\(\);\s*\n\s*\/\/[\s\S]{0,600}?startMode\('learn'\);/.test(js),
    'onboarding should drop into practice, not showView(\'home\')');

  // ---- signed-out landing page
  const anon = await loadPage(base);
  check('landing page loads with no JavaScript errors', anon.errors.length === 0,
    anon.errors.join(' | '));
  check('landing page renders the hero', Boolean(anon.dom.window.document.querySelector('#view-landing h1')));
  check('signup form is present', Boolean(anon.dom.window.document.querySelector('#signup-form')));
  anon.dom.window.close();

  // ---- signed-in, not yet onboarded
  const res = await fetch(`${base}api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Dom Test', email: 'domtest@example.com',
      password: 'a-good-long-password', birthYear: 2009, acceptTerms: true,
    }),
  });
  assert.strictEqual(res.status, 201, 'signup should succeed');
  const cookie = res.headers.get('set-cookie').split(';')[0];

  const fresh = await loadPage(base, cookie);
  check('signed-in page loads with no JavaScript errors', fresh.errors.length === 0,
    fresh.errors.join(' | '));
  const freshDoc = fresh.dom.window.document;
  check('a new user is sent into onboarding',
    !freshDoc.querySelector('#view-onboarding').classList.contains('hidden'));
  // High school only: 9th through 12th. College grades were removed on purpose.
  check('onboarding renders grade choices',
    freshDoc.querySelectorAll('#grade-choices .choice').length === 4);
  check('onboarding offers no college grades',
    ![...freshDoc.querySelectorAll('#grade-choices .choice')]
      .some((b) => /college/i.test(b.textContent)));
  fresh.dom.window.close();

  // ---- signed-in and onboarded
  await fetch(`${base}api/onboarding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ gradeLevel: 10, courseIds: ['hs-biology'], goal: 'grades' }),
  });

  const home = await loadPage(base, cookie);
  check('home page loads with no JavaScript errors', home.errors.length === 0,
    home.errors.join(' | '));
  const homeDoc = home.dom.window.document;
  check('home view is visible after onboarding',
    !homeDoc.querySelector('#view-home').classList.contains('hidden'));
  check('all six study modes render',
    homeDoc.querySelectorAll('.mode-card').length === 6);
  check('navigation is visible when signed in',
    !homeDoc.querySelector('#nav').classList.contains('hidden'));
  home.dom.window.close();

  // ---- the stylesheet must actually apply
  //
  // A previous build loaded webfonts with @import INSIDE styles.css, which
  // makes the browser withhold the entire stylesheet until Google Fonts
  // answers. On a network that blocks it, the app rendered completely
  // unstyled. These checks fail if the theme is not actually in effect.
  const cssText = await (await fetch(`${base}styles.css`)).text();
  check('styles.css is served and substantial', cssText.length > 5000,
    `got ${cssText.length} bytes`);
  check('the stylesheet does not @import webfonts',
    !/@import[^;]*fonts\.googleapis/.test(cssText),
    'an @import here blocks the whole stylesheet on a third-party request');
  check('index.html loads webfonts via its own link tag',
    /<link[^>]+fonts\.googleapis\.com/.test(html));
  check('theme custom properties are defined', /--bg:\s*#/.test(cssText));

  const styled = await loadPage(base);
  const win = styled.dom.window;
  const bodyBg = win.getComputedStyle(win.document.body).backgroundColor;
  // jsdom resolves var() only when the custom property parsed correctly, so a
  // non-empty value here proves :root actually applied.
  check('the dark theme is applied to the page body',
    bodyBg !== '' && bodyBg !== 'transparent',
    `computed body background: "${bodyBg}"`);
  styled.dom.window.close();

  // ---- caching: assets must revalidate, never be served stale
  const assetRes = await fetch(`${base}app.js`);
  const cacheControl = assetRes.headers.get('cache-control');
  check('app.js is served with a revalidating cache policy',
    cacheControl === 'no-cache',
    `got: ${cacheControl} (a long max-age lets a stale script run against new markup)`);
  check('app.js sends an ETag so revalidation is cheap',
    Boolean(assetRes.headers.get('etag')));

  console.log(`\n${'-'.repeat(52)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('-'.repeat(52) + '\n');

  server.close();
  db.close();
  for (const s of ['', '-wal', '-shm']) {
    if (fs.existsSync(TMP_DB + s)) fs.unlinkSync(TMP_DB + s);
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  console.error('DOM smoke harness failed:', err);
  process.exit(1);
});
