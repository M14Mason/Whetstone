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

const TMP_DB = path.join(require('node:os').tmpdir(), `whetstone-dom-${process.pid}.db`);
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
const IGNORABLE = /scrollTo|fonts\.googleapis|Could not load link|Not implemented/i;

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
  console.log(`\nWhetstone DOM smoke test  (${base})\n`);

  // ---- static cross-check: every id app.js queries must exist in the markup
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8');
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const referenced = [...new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  // These are created at runtime inside innerHTML, so they are not in the file.
  const RUNTIME_IDS = new Set(['clear-scope', 'send-verify', 'modal-close', 'modal-backdrop']);
  const missing = referenced.filter((id) => !ids.has(id) && !RUNTIME_IDS.has(id));
  check('every element app.js queries exists in index.html', missing.length === 0,
    missing.length ? `missing: ${missing.join(', ')}` : '');

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
  check('onboarding renders grade choices',
    freshDoc.querySelectorAll('#grade-choices .choice').length >= 8);
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
  check('all five study modes render',
    homeDoc.querySelectorAll('.mode-card').length === 5);
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
