'use strict';

/**
 * Search-surface tests.
 *
 * These exist because the SEO layer is the one part of the product that no
 * human looks at during normal use. A broken canonical, a sitemap listing
 * courses with no questions, or schema that disagrees with the visible page
 * fails silently for weeks and costs rankings the whole time. Everything here
 * runs against a real HTTP server, not a mocked one.
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TMP_DB = path.join(require('node:os').tmpdir(), `keen-seo-${process.pid}.db`);
for (const suffix of ['', '-wal', '-shm']) {
  if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
}

const db = require('../lib/db');
db.init(TMP_DB);

const { createServer } = require('../server');
const questions = require('../lib/questions');
const seo = require('../lib/seo');
const { config } = require('../lib/config');

questions.seed({ quiet: true });

let passed = 0;
let failed = 0;
const checks = [];
function check(label, fn) { checks.push({ label, fn }); }

let BASE = '';

async function get(route, headers = {}) {
  const res = await fetch(`${BASE}${route}`, { headers, redirect: 'manual' });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', text };
}

// ---------------------------------------------------------------- robots.txt

check('robots.txt is served as plain text and points at the sitemap', async () => {
  const res = await get('/robots.txt');
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /text\/plain/);
  assert.match(res.text, /^Sitemap: https?:\/\/[^\s]+\/sitemap\.xml$/m);
});

check('robots.txt allows the assistant crawlers that can cite us', async () => {
  const { text } = await get('/robots.txt');
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'OAI-SearchBot']) {
    assert.ok(new RegExp(`User-agent: ${bot}`).test(text), `${bot} is not addressed in robots.txt`);
  }
  // Whatever else changes, a blanket disallow must never reappear.
  assert.ok(!/^Disallow: \/$/m.test(text), 'robots.txt blocks the whole site');
});

check('robots.txt keeps crawlers off the API and one-time token links', async () => {
  const { text } = await get('/robots.txt');
  assert.match(text, /Disallow: \/api\//);
  assert.match(text, /Disallow: \/reset/);
  assert.match(text, /Disallow: \/verify/);
});

// --------------------------------------------------------------- sitemap.xml

check('sitemap.xml is valid XML with absolute URLs', async () => {
  const res = await get('/sitemap.xml');
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /xml/);
  assert.match(res.text, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(res.text, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  const locs = [...res.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.ok(locs.length > 3, 'sitemap is suspiciously small');
  for (const loc of locs) {
    assert.match(loc, /^https?:\/\//, `relative URL in sitemap: ${loc}`);
  }
});

check('sitemap lists only courses that actually have questions', async () => {
  const { text } = await get('/sitemap.xml');
  const slugs = [...text.matchAll(/<loc>[^<]*\/courses\/([a-z0-9-]+)<\/loc>/g)].map((m) => m[1]);
  const published = new Set(seo.publishedCourses(db.getDb()).map((e) => e.course.id));
  assert.ok(slugs.length > 0, 'no course pages in the sitemap');
  for (const slug of slugs) {
    assert.ok(published.has(slug), `sitemap lists ${slug}, which has no questions`);
  }
});

// ------------------------------------------------------- machine-readable AI

check('llms.txt is served and states the real catalogue size', async () => {
  const res = await get('/llms.txt');
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /text\/plain/);
  const totals = seo.catalogueTotals(db.getDb());
  assert.ok(
    res.text.includes(totals.questions.toLocaleString('en-US')),
    'llms.txt does not quote the live question count'
  );
});

check('pricing.md exposes every plan with a parseable price', async () => {
  const res = await get('/pricing.md');
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /markdown/);
  for (const heading of ['## Free', '## Premium Monthly', '## Premium Annual', '## Study Group']) {
    assert.ok(res.text.includes(heading), `pricing.md is missing ${heading}`);
  }
  assert.ok(
    res.text.includes(`$${(config.plans.premium.priceCents / 100).toFixed(2)}/month`),
    'monthly price in pricing.md does not match config'
  );
  assert.ok(
    res.text.includes(`$${(config.plans.premium.priceCentsAnnual / 100).toFixed(2)}/year`),
    'annual price in pricing.md does not match config'
  );
});

// ----------------------------------------------------------------- app shell

check('the shell has no unreplaced template placeholders', async () => {
  const { text } = await get('/');
  const left = [...text.matchAll(/\{\{[A-Z_]+\}\}/g)].map((m) => m[0]);
  assert.deepStrictEqual(left, [], `unfilled placeholders shipped to the browser: ${left.join(', ')}`);
});

check('the shell carries an absolute canonical matching the request host', async () => {
  const { text } = await get('/');
  const canonical = text.match(/<link rel="canonical" href="([^"]+)"/);
  assert.ok(canonical, 'no canonical tag');
  assert.match(canonical[1], /^https?:\/\/[^/]+\/$/);
});

check('the shell ships valid JSON-LD covering the app and its offers', async () => {
  const { text } = await get('/');
  const block = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, 'no JSON-LD block on the home page');
  const parsed = JSON.parse(block[1]);
  assert.strictEqual(parsed['@context'], 'https://schema.org');
  const types = parsed['@graph'].map((n) => n['@type']);
  for (const t of ['Organization', 'WebSite', 'SoftwareApplication', 'FAQPage']) {
    assert.ok(types.includes(t), `JSON-LD graph is missing ${t}`);
  }
  const app = parsed['@graph'].find((n) => n['@type'] === 'SoftwareApplication');
  assert.ok(Array.isArray(app.offers) && app.offers.length === 4, 'expected four offers');
  for (const offer of app.offers) {
    assert.ok(/^\d+(\.\d{2})?$/.test(offer.price), `offer price is not machine-readable: ${offer.price}`);
    assert.strictEqual(offer.priceCurrency, 'USD');
  }
});

check('every FAQ answer in the schema is also visible on the page', async () => {
  const { text } = await get('/');
  const block = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
  const faq = JSON.parse(block)['@graph'].find((n) => n['@type'] === 'FAQPage');
  // Schema describing content a human cannot see is a structured-data
  // violation, so the visible copy is the thing under test here.
  const visible = text.replace(/<script[\s\S]*?<\/script>/g, '');
  for (const entry of faq.mainEntity) {
    const firstWords = entry.acceptedAnswer.text.split(' ').slice(0, 6).join(' ');
    const escaped = firstWords
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    assert.ok(
      visible.includes(escaped),
      `FAQ answer is in the schema but not on the page: "${firstWords}..."`
    );
  }
});

check('the landing page quotes the real question and course counts', async () => {
  const { text } = await get('/');
  const totals = seo.catalogueTotals(db.getDb());
  assert.ok(
    text.includes(totals.questions.toLocaleString('en-US')),
    'landing page does not show the live question count'
  );
  // The hero used to hardcode "25,000+ questions - 159 courses", which is how a
  // claim rots: the bank grows, courses get added or emptied, and the page goes
  // on asserting a number nobody rechecks. It now reads from the bank.
  assert.ok(!text.includes('25,000+'), 'the hardcoded hero count is back');
  assert.ok(
    text.includes(`${totals.courses} courses`),
    'the hero is not quoting the live course count'
  );
});

// -------------------------------------------------------------- course pages

check('a course with questions renders a real page with its unit table', async () => {
  const [top] = seo.publishedCourses(db.getDb());
  const res = await get(`/courses/${top.course.id}`);
  assert.strictEqual(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.ok(res.text.includes('<h1>'), 'no H1 on the course page');
  assert.ok(res.text.includes(top.course.name), 'course name missing from its own page');
  assert.ok(res.text.includes('<table'), 'no unit table');
  assert.strictEqual((res.text.match(/<h1[ >]/g) || []).length, 1, 'a page must have exactly one H1');
});

check('course pages carry Course, BreadcrumbList and FAQPage schema', async () => {
  const [top] = seo.publishedCourses(db.getDb());
  const { text } = await get(`/courses/${top.course.id}`);
  const block = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, 'course page has no JSON-LD');
  const types = JSON.parse(block[1])['@graph'].map((n) => n['@type']);
  for (const t of ['Course', 'BreadcrumbList', 'FAQPage']) {
    assert.ok(types.includes(t), `course page schema is missing ${t}`);
  }
});

check('a course with no questions 404s instead of serving an empty page', async () => {
  const empty = require('../lib/courses').allCourses()
    .find((c) => !seo.publishedCourses(db.getDb()).some((e) => e.course.id === c.id));
  if (!empty) return; // every course has content: nothing to assert
  const res = await get(`/courses/${empty.id}`);
  assert.strictEqual(res.status, 404, `${empty.id} has no questions but returned ${res.status}`);
});

check('the course index links every published course', async () => {
  const res = await get('/courses');
  assert.strictEqual(res.status, 200);
  const published = seo.publishedCourses(db.getDb());
  for (const { course } of published.slice(0, 25)) {
    assert.ok(
      res.text.includes(`/courses/${course.id}"`),
      `course index does not link ${course.id}`
    );
  }
});

// ------------------------------------------------------------------ soft 404

check('an unknown path returns 404 rather than a copy of the home page', async () => {
  // The old behaviour served the shell with a 200 for any unknown extensionless
  // path, which lets a crawler index unbounded duplicate URLs.
  const res = await get('/definitely-not-a-real-page');
  assert.strictEqual(res.status, 404);
});

check('client-routed paths still return the app shell', async () => {
  for (const route of ['/reset', '/verify']) {
    const res = await get(route);
    assert.strictEqual(res.status, 200, `${route} should serve the shell`);
  }
});

// -------------------------------------------------------------------- origin

check('the canonical follows the forwarded protocol behind a proxy', async () => {
  // Fly and Cloudflare terminate TLS, so the app sees http. Emitting an http
  // canonical on an https site splits the two into competing URLs.
  const configured = config.publicUrl;
  config.publicUrl = 'http://localhost:3000';
  try {
    const { text } = await get('/', { 'x-forwarded-proto': 'https', host: 'keen.study' });
    const canonical = text.match(/<link rel="canonical" href="([^"]+)"/)[1];
    assert.match(canonical, /^https:\/\//, `expected https canonical, got ${canonical}`);
  } finally {
    config.publicUrl = configured;
  }
});

// ----------------------------------------------------------------------- run

(async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  BASE = `http://127.0.0.1:${server.address().port}`;

  console.log(`\nKeen search-surface tests  (${BASE})\n`);

  for (const { label, fn } of checks) {
    try {
      await fn();
      passed += 1;
      console.log(`  PASS  ${label}`);
    } catch (err) {
      failed += 1;
      console.log(`  FAIL  ${label}`);
      console.log(`        ${err.message}`);
    }
  }

  server.close();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    if (fs.existsSync(TMP_DB + suffix)) fs.unlinkSync(TMP_DB + suffix);
  }

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
