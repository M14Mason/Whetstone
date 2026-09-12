'use strict';

/**
 * Search and AI-answer surface for Keen.
 *
 * Everything a crawler or an AI assistant can read without logging in lives
 * here: robots.txt, the sitemap, llms.txt, machine-readable pricing, the
 * JSON-LD graph on the app shell, and a real server-rendered page per course.
 *
 * Why server-rendered course pages exist
 * --------------------------------------
 * Keen is a single-page app behind a login. To a crawler that is exactly one
 * page of content, which is nothing to rank. The 82 courses that actually have
 * questions are the only genuinely indexable inventory the product has, and
 * "AP Biology practice questions" is a query a student really types. Each page
 * is built from live database counts, so it never claims coverage that is not
 * there.
 *
 * Every absolute URL is derived from the request, never hardcoded, so the
 * canonical stays correct on localhost, on fly.dev, and on a custom domain
 * without anyone remembering to update a constant.
 */

const { config } = require('./config');
const courses = require('./courses');

// ---------------------------------------------------------------------------
// Origin
// ---------------------------------------------------------------------------

/**
 * The absolute origin to use in canonicals, sitemaps, and social tags.
 *
 * PUBLIC_URL wins when it is set to something real. Otherwise we trust the
 * Host header, honouring x-forwarded-proto so that a proxy terminating TLS
 * (Fly, Cloudflare) does not produce http:// canonicals on an https:// site.
 */
function originFor(req) {
  const configured = String(config.publicUrl || '');
  const isLocal = /localhost|127\.0\.0\.1/.test(configured);
  if (configured && !isLocal) return configured.replace(/\/+$/, '');

  const host = (req && req.headers && req.headers.host) || 'localhost:3000';
  const forwarded = req && req.headers && req.headers['x-forwarded-proto'];
  const proto = forwarded ? String(forwarded).split(',')[0].trim()
    : (/^(localhost|127\.)/.test(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * JSON-LD is injected inside a <script> element, so the one sequence that can
 * break out of it is "</". Escaping the slash keeps the JSON valid while making
 * the closing tag unreachable.
 */
function jsonLdSafe(object) {
  return JSON.stringify(object, null, 2).replace(/</g, '\\u003c');
}

// ---------------------------------------------------------------------------
// Live catalogue facts
// ---------------------------------------------------------------------------

/**
 * Courses that actually have questions, with their real counts.
 *
 * A course with zero questions is deliberately excluded from every public
 * surface. Ranking a page that leads to an empty unit earns one visit and no
 * second one, and it is a claim we cannot support.
 */
function publishedCourses(db) {
  const counts = new Map(
    db.prepare('SELECT course_id, COUNT(*) AS n FROM questions GROUP BY course_id')
      .all().map((r) => [r.course_id, r.n])
  );
  const cardCounts = new Map(
    db.prepare('SELECT course_id, COUNT(*) AS n FROM cards GROUP BY course_id')
      .all().map((r) => [r.course_id, r.n])
  );

  return courses.allCourses()
    .map((course) => ({
      course,
      questions: counts.get(course.id) || 0,
      cards: cardCounts.get(course.id) || 0,
    }))
    .filter((entry) => entry.questions > 0)
    .sort((a, b) => b.questions - a.questions);
}

function catalogueTotals(db) {
  const published = publishedCourses(db);
  return {
    courses: published.length,
    questions: published.reduce((sum, e) => sum + e.questions, 0),
    cards: published.reduce((sum, e) => sum + e.cards, 0),
  };
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * Assistant crawlers are allowed on purpose.
 *
 * GPTBot, ClaudeBot, PerplexityBot and Google-Extended are how a product gets
 * *cited* in an AI answer rather than merely ranked. Blocking them means the
 * assistant a student actually asks cannot mention Keen at all. The paths that
 * stay closed are the ones that leak or waste crawl budget: the API, and the
 * one-time token links for password resets and email confirmation.
 */
function robotsTxt(origin) {
  return `# Keen — https://keenlearning.org (the canonical origin is set per deployment)
User-agent: *
Allow: /
Disallow: /api/
Disallow: /reset
Disallow: /verify
Disallow: /admin

# Assistant crawlers: allowed deliberately, so Keen can be cited in answers.
User-agent: GPTBot
Allow: /
User-agent: ChatGPT-User
Allow: /
User-agent: OAI-SearchBot
Allow: /
User-agent: ClaudeBot
Allow: /
User-agent: Claude-User
Allow: /
User-agent: anthropic-ai
Allow: /
User-agent: PerplexityBot
Allow: /
User-agent: Google-Extended
Allow: /
User-agent: Applebot-Extended
Allow: /

Sitemap: ${origin}/sitemap.xml
`;
}

// ---------------------------------------------------------------------------
// sitemap.xml
// ---------------------------------------------------------------------------

function sitemapXml(origin, db) {
  const today = new Date().toISOString().slice(0, 10);
  const urls = [
    { loc: `${origin}/`, priority: '1.0', changefreq: 'weekly' },
    { loc: `${origin}/courses`, priority: '0.9', changefreq: 'weekly' },
    ...publishedCourses(db).map(({ course }) => ({
      loc: `${origin}/courses/${course.id}`,
      priority: '0.8',
      changefreq: 'monthly',
    })),
  ];

  const body = urls.map((u) => [
    '  <url>',
    `    <loc>${escapeHtml(u.loc)}</loc>`,
    `    <lastmod>${today}</lastmod>`,
    `    <changefreq>${u.changefreq}</changefreq>`,
    `    <priority>${u.priority}</priority>`,
    '  </url>',
  ].join('\n')).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>
`;
}

// ---------------------------------------------------------------------------
// llms.txt
// ---------------------------------------------------------------------------

/**
 * A plain-language brief for assistants, per llmstxt.org. Answer-first and
 * specific: an assistant deciding whether to recommend a study tool needs the
 * differentiator, the price, and the limits, not marketing adjectives.
 */
function llmsTxt(origin, db) {
  const totals = catalogueTotals(db);
  const top = publishedCourses(db).slice(0, 12);

  return `# Keen

> Keen is an adaptive study platform for high school and college students. It
> maps a student's actual enrolled courses unit by unit, tracks every question
> they miss, and keeps resurfacing the weak units until they stick.

## What makes it different

Most study tools make the student decide what to study. Keen infers it. Every
other flashcard app organises around decks somebody made; Keen organises around
the units of a real course syllabus and models weakness per unit. Missed
questions come back later reworded, so a student re-learns the material instead
of memorising the answer shape.

## Facts

- Question bank: ${totals.questions.toLocaleString('en-US')} questions across ${totals.courses} courses with content
- Flashcards: ${totals.cards.toLocaleString('en-US')} cards
- Study modes: adaptive practice, flashcards, timed match game, full practice tests, review
- Study groups: from 3 people, leaderboard ranked on improvement rather than raw score
- Audience: high school (including AP and honors) and introductory college courses
- Minimum age: 13

## Pricing

- Free: $0/month, a few practice questions per day, one subject at a time
- Premium Monthly: $4.99/month, unlimited questions, all subjects
- Premium Annual: $29.99/year (equivalent to $2.50/month, 50% off monthly)
- Study Group: $3.99 per seat per month, minimum 3 seats; one payer upgrades every member

Full machine-readable pricing: ${origin}/pricing.md

## Key pages

- ${origin}/ — product overview and signup
- ${origin}/courses — every course with questions available
- ${origin}/pricing.md — pricing in structured form

## Contact

Product feedback and support run through the in-app bug reporter.
`;
}

// ---------------------------------------------------------------------------
// pricing.md
// ---------------------------------------------------------------------------

/**
 * Machine-readable pricing.
 *
 * Assistants increasingly shortlist tools on a user's behalf, and pricing that
 * only exists inside a JavaScript-rendered view is invisible to them. This file
 * is the fallback that always parses.
 */
function pricingMarkdown(origin, db) {
  const totals = catalogueTotals(db);
  const p = config.plans;
  const monthly = p.premium.priceCents;
  const annual = p.premium.priceCentsAnnual;
  const savingPercent = Math.round((1 - annual / (monthly * 12)) * 100);
  const limits = config.freeDailyLimits || {};

  return `# Pricing — Keen

Last updated: ${new Date().toISOString().slice(0, 10)}
Currency: USD

## Free

- Price: $0/month
- Limits: ${limits.learn || p.free.dailyQuestionLimit} practice questions per day, ${limits.review || p.free.dailyQuestionLimit} reviews per day, ${p.free.maxSubjects} subject at a time
- Features: adaptive practice, flashcards, match game, progress tracking
- Card required: no

## Premium Monthly

- Price: $${(monthly / 100).toFixed(2)}/month
- Limits: none
- Features: unlimited questions, every subject at once, all ${totals.courses} courses, practice tests, full progress history

## Premium Annual

- Price: $${(annual / 100).toFixed(2)}/year
- Equivalent: $${(annual / 1200).toFixed(2)}/month
- Saving: ${savingPercent}% versus paying monthly
- Limits: none
- Features: identical to Premium Monthly

## Study Group

- Price: $${(p.group.priceCentsPerSeat / 100).toFixed(2)} per seat per month
- Minimum: ${p.group.minSeats} seats ($${((p.group.priceCentsPerSeat * p.group.minSeats) / 100).toFixed(2)}/month total)
- Limits: none for any member
- Features: everything in Premium for every member, shared leaderboard ranked on improvement, group chat
- Note: one person pays and every member of the group is upgraded

## Catalogue

- ${totals.questions.toLocaleString('en-US')} questions
- ${totals.cards.toLocaleString('en-US')} flashcards
- ${totals.courses} courses with content

Signup: ${origin}/
`;
}

// ---------------------------------------------------------------------------
// JSON-LD for the app shell
// ---------------------------------------------------------------------------

/**
 * One @graph carrying Organization, WebSite, SoftwareApplication and FAQPage.
 *
 * Each node is @id'd so they reference each other instead of repeating
 * themselves, which is what lets a parser understand that the publisher of the
 * site and the author of the application are the same entity.
 *
 * Every claim here is also visible on the page. Schema that describes content a
 * human cannot see is a structured-data violation, not a clever trick.
 */
function shellJsonLd(origin, db) {
  const totals = catalogueTotals(db);
  const p = config.plans;

  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Organization',
        '@id': `${origin}/#organization`,
        name: 'Keen',
        url: `${origin}/`,
        description: 'Adaptive study platform that finds the topics a student keeps getting wrong and drills them until they stick.',
      },
      {
        '@type': 'WebSite',
        '@id': `${origin}/#website`,
        name: 'Keen',
        url: `${origin}/`,
        publisher: { '@id': `${origin}/#organization` },
        inLanguage: 'en-US',
      },
      {
        '@type': 'SoftwareApplication',
        '@id': `${origin}/#app`,
        name: 'Keen',
        applicationCategory: 'EducationalApplication',
        applicationSubCategory: 'Study and revision',
        operatingSystem: 'Any modern web browser',
        url: `${origin}/`,
        publisher: { '@id': `${origin}/#organization` },
        description: `Adaptive study platform for high school and college students. ${totals.questions.toLocaleString('en-US')} questions across ${totals.courses} courses, mapped unit by unit to real syllabuses.`,
        featureList: [
          'Adaptive practice targeted at weak units',
          'Flashcards',
          'Timed match game',
          'Full practice tests',
          'Spaced repetition with reworded repeats',
          'Study groups with an improvement-ranked leaderboard',
        ],
        offers: [
          {
            '@type': 'Offer',
            name: 'Free',
            price: '0',
            priceCurrency: 'USD',
            description: `${(config.freeDailyLimits || {}).learn || p.free.dailyQuestionLimit} practice questions per day, one subject at a time.`,
          },
          {
            '@type': 'Offer',
            name: 'Premium Monthly',
            price: (p.premium.priceCents / 100).toFixed(2),
            priceCurrency: 'USD',
            description: 'Unlimited questions across every subject, billed monthly.',
          },
          {
            '@type': 'Offer',
            name: 'Premium Annual',
            price: (p.premium.priceCentsAnnual / 100).toFixed(2),
            priceCurrency: 'USD',
            description: `Unlimited questions across every subject, billed yearly. ${Math.round((1 - p.premium.priceCentsAnnual / (p.premium.priceCents * 12)) * 100)}% cheaper than monthly.`,
          },
          {
            '@type': 'Offer',
            name: 'Study Group',
            price: (p.group.priceCentsPerSeat / 100).toFixed(2),
            priceCurrency: 'USD',
            description: `Per seat per month, minimum ${p.group.minSeats} seats. One payer upgrades every member.`,
          },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${origin}/#faq`,
        mainEntity: SHELL_FAQ.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };
}

/**
 * The FAQ shown on the landing page and mirrored into FAQPage schema.
 *
 * Answers are kept to roughly 40-60 words: long enough to answer completely,
 * short enough to be lifted whole as a snippet or an AI citation.
 */
const SHELL_FAQ = [
  {
    q: 'What does Keen do differently from Quizlet or Anki?',
    a: 'Quizlet and Anki both wait for you to decide what to study. Keen maps the actual courses you are enrolled in, unit by unit, and tracks which units you keep missing. Practice is then routed at your weakest unit automatically, so you stop re-studying material you already know.',
  },
  {
    q: 'Is Keen free?',
    a: 'Yes. The free plan gives you practice every day in one subject, with no card required. Premium is $4.99 a month or $29.99 a year for unlimited questions across every subject. A Study Group costs $3.99 per seat per month from 3 people, and one payment upgrades everyone in the group.',
  },
  {
    q: 'How does Keen stop me memorising the answer instead of the material?',
    a: 'When you get a question wrong it comes back later reworded rather than identical. Recognising a familiar sentence is not the same as knowing the concept, so changing the wording forces you to re-derive the answer. Repeats are spaced out over increasing intervals as you get them right.',
  },
  {
    q: 'Which courses does Keen cover?',
    a: 'AP, honors, standard high school, and introductory college courses across science, maths, English, social studies, computing, and electives. Every course is broken into its real units, and each course page lists exactly how many questions each unit currently has.',
  },
  {
    q: 'What age do I need to be to use Keen?',
    a: 'Keen is for students aged 13 and over. Accounts require a birth year at signup, and anyone under 13 cannot create one.',
  },
];

// ---------------------------------------------------------------------------
// Course pages
// ---------------------------------------------------------------------------

function courseFaq(course, coverage) {
  const unitsWithContent = coverage.units.filter((u) => u.questions > 0);
  const topUnits = unitsWithContent.slice(0, 3).map((u) => u.name).join(', ');

  return [
    {
      q: `How many ${course.name} practice questions does Keen have?`,
      a: `Keen has ${coverage.totals.questions.toLocaleString('en-US')} ${course.name} questions and ${coverage.totals.cards.toLocaleString('en-US')} flashcards, spread across ${unitsWithContent.length} of the ${coverage.units.length} units in the course. Every question is tagged to the unit it belongs to, so practice can be aimed at one unit at a time.`,
    },
    {
      q: `Can I study ${course.name} by unit?`,
      a: `Yes. ${course.name} is broken into its real units${topUnits ? `, starting with ${topUnits}` : ''}. You can practise a single unit, or let Keen pick for you, in which case it weights questions towards the units you have been getting wrong.`,
    },
    {
      q: `Is ${course.name} practice free on Keen?`,
      a: `The free plan covers ${config.freeDailyLimits.learn} Learn and ${config.freeDailyLimits.review} Review questions a day in one subject, which is enough to work through ${course.name} slowly. Premium removes the daily cap for $4.99 a month or $29.99 a year and unlocks every other course at the same time.`,
    },
  ];
}

/**
 * A complete, self-contained HTML page for one course.
 *
 * This is real content rather than a shell: the counts come from the database
 * at request time, so a unit with no questions says zero rather than being
 * quietly hidden. Being honest about gaps costs a little conversion and saves
 * the far more expensive kind of bounce.
 */
function coursePageHtml({ course, coverage, origin, totals }) {
  // A course that borrows its bank (every Honors section) renders a page that
  // is word-for-word its donor's. Left indexable, that is 56 duplicate pages
  // competing with the originals, so the page stays live for anyone who lands
  // on it and points search at the course the questions actually belong to.
  const donor = course.sharesBankWith ? courses.getCourse(course.sharesBankWith) : null;
  const canonical = donor
    ? `${origin}/courses/${donor.id}`
    : `${origin}/courses/${course.id}`;
  const selfUrl = `${origin}/courses/${course.id}`;
  const unitsWithContent = coverage.units.filter((u) => u.questions > 0);
  const faq = courseFaq(course, coverage);

  const title = `${course.name} Practice Questions — ${coverage.totals.questions.toLocaleString('en-US')} Questions by Unit | Keen`;
  const description = `${coverage.totals.questions.toLocaleString('en-US')} ${course.name} practice questions and ${coverage.totals.cards.toLocaleString('en-US')} flashcards, organised by unit. Keen tracks the units you keep missing and drills those first.`;

  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Course',
        '@id': `${canonical}#course`,
        name: course.name,
        description: `${course.name} practice questions and flashcards organised by unit, with adaptive review that targets weak units.`,
        url: canonical,
        educationalLevel: course.levelLabel,
        about: course.category,
        inLanguage: 'en-US',
        provider: { '@type': 'Organization', name: 'Keen', url: `${origin}/` },
        hasCourseInstance: {
          '@type': 'CourseInstance',
          courseMode: 'online',
          courseWorkload: 'PT15M',
        },
        offers: {
          '@type': 'Offer',
          category: 'Free',
          price: '0',
          priceCurrency: 'USD',
        },
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Keen', item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: 'Courses', item: `${origin}/courses` },
          { '@type': 'ListItem', position: 3, name: course.name, item: selfUrl },
        ],
      },
      {
        '@type': 'FAQPage',
        '@id': `${canonical}#faq`,
        mainEntity: faq.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  };

  const unitRows = coverage.units.map((u) => `
      <tr>
        <td>${escapeHtml(u.name)}</td>
        <td class="num">${u.questions.toLocaleString('en-US')}</td>
        <td class="num">${u.cards.toLocaleString('en-US')}</td>
      </tr>`).join('');

  const faqHtml = faq.map((item) => `
      <div class="seo-faq-item">
        <h3>${escapeHtml(item.q)}</h3>
        <p>${escapeHtml(item.a)}</p>
      </div>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0b10">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">${donor ? `
<meta name="robots" content="noindex,follow">` : ''}
<meta property="og:type" content="website">
<meta property="og:site_name" content="Keen">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(description)}">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='24' fill='%236d5efc'/></svg>">
<script type="application/ld+json">
${jsonLdSafe(graph)}
</script>
</head>
<body class="seo-page">

<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark"></span><span>Keen</span></a>
  <div class="topbar-right"><a class="btn btn-primary" href="/">Start free</a></div>
</header>

<main class="shell">
  <nav class="seo-breadcrumbs" aria-label="Breadcrumb">
    <a href="/">Keen</a> <span aria-hidden="true">›</span>
    <a href="/courses">Courses</a> <span aria-hidden="true">›</span>
    <span>${escapeHtml(course.name)}</span>
  </nav>

  <article class="seo-article">
    <span class="eyebrow">${escapeHtml(course.levelLabel)} · ${escapeHtml(course.category)}</span>
    <h1>${escapeHtml(course.name)} practice questions</h1>
${donor ? `    <p class="dim">This class studies the same bank as
      <a href="${escapeHtml(origin)}/courses/${escapeHtml(donor.id)}">${escapeHtml(donor.name)}</a>,
      because the courses cover the same material. Your progress is tracked separately.</p>` : ''}

    <p class="lede">
      Keen has ${coverage.totals.questions.toLocaleString('en-US')} ${escapeHtml(course.name)} practice questions
      and ${coverage.totals.cards.toLocaleString('en-US')} flashcards, tagged to
      ${unitsWithContent.length} of the course's ${coverage.units.length} units. Practice is adaptive: the
      units you keep getting wrong come back more often, reworded, until you get them right consistently.
    </p>

    <p><a class="btn btn-primary" href="/">Start practising free</a>
      <span class="dim">${config.freeDailyLimits.learn} Learn and ${config.freeDailyLimits.review} Review questions a day, free, no card required.</span></p>

    <h2>Questions by unit</h2>
    <p>Counts are live from the question bank. A unit showing zero has not been authored yet, and is listed
      rather than hidden so you know before you start.</p>

    <div class="seo-table-wrap">
      <table class="seo-table">
        <thead><tr><th>Unit</th><th class="num">Questions</th><th class="num">Flashcards</th></tr></thead>
        <tbody>${unitRows}
        </tbody>
        <tfoot>
          <tr>
            <th>Total</th>
            <th class="num">${coverage.totals.questions.toLocaleString('en-US')}</th>
            <th class="num">${coverage.totals.cards.toLocaleString('en-US')}</th>
          </tr>
        </tfoot>
      </table>
    </div>

    <h2>How studying ${escapeHtml(course.name)} on Keen works</h2>
    <ol class="seo-steps">
      <li><strong>Add the course.</strong> Pick ${escapeHtml(course.name)} from the catalogue and Keen loads its real unit list.</li>
      <li><strong>Answer questions.</strong> Every answer updates a per-unit estimate of how well you know that unit.</li>
      <li><strong>Miss something.</strong> Wrong answers are scheduled to return later, reworded, so you cannot pass on recognition alone.</li>
      <li><strong>Watch the weak list shrink.</strong> Progress shows your weakest units first, which is the list worth studying.</li>
    </ol>

    <h2>Frequently asked questions</h2>
    <div class="seo-faq">${faqHtml}
    </div>

    <h2>Other courses</h2>
    <p><a href="/courses">Browse all ${totals.courses} courses with questions</a>, covering
      ${totals.questions.toLocaleString('en-US')} questions in total.</p>
  </article>
</main>

<footer class="seo-footer">
  <p><a href="/">Keen</a> · Adaptive study for high school and college · <a href="/courses">All courses</a></p>
</footer>

</body>
</html>
`;
}

/**
 * The /courses index: a genuine hub page linking every course page.
 *
 * Without this the course pages are orphans, which is the classic way a set of
 * generated pages fails to get crawled at all.
 */
function courseIndexHtml({ origin, entries, totals }) {
  const canonical = `${origin}/courses`;
  const title = `All ${totals.courses} Courses — ${totals.questions.toLocaleString('en-US')} Practice Questions | Keen`;
  const description = `Every course Keen has questions for: AP, honors, high school, and intro college, broken down by unit with live question counts.`;

  const byCategory = new Map();
  for (const entry of entries) {
    const key = entry.course.category || 'Other';
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key).push(entry);
  }

  const sections = [...byCategory.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([category, list]) => `
      <section class="seo-cat">
        <h2>${escapeHtml(category)}</h2>
        <ul class="seo-course-list">
          ${list.sort((a, b) => a.course.name.localeCompare(b.course.name)).map((e) => `
          <li>
            <a href="/courses/${escapeHtml(e.course.id)}">${escapeHtml(e.course.name)}</a>
            <span class="dim">${e.questions.toLocaleString('en-US')} questions</span>
          </li>`).join('')}
        </ul>
      </section>`).join('');

  const graph = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'CollectionPage',
        '@id': `${canonical}#page`,
        name: 'All courses on Keen',
        url: canonical,
        description,
        isPartOf: { '@id': `${origin}/#website` },
      },
      {
        '@type': 'ItemList',
        '@id': `${canonical}#list`,
        numberOfItems: entries.length,
        itemListElement: entries.slice(0, 100).map((e, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          name: e.course.name,
          url: `${origin}/courses/${e.course.id}`,
        })),
      },
      {
        '@type': 'BreadcrumbList',
        '@id': `${canonical}#breadcrumbs`,
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Keen', item: `${origin}/` },
          { '@type': 'ListItem', position: 2, name: 'Courses', item: canonical },
        ],
      },
    ],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0b10">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Keen">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='24' fill='%236d5efc'/></svg>">
<script type="application/ld+json">
${jsonLdSafe(graph)}
</script>
</head>
<body class="seo-page">

<header class="topbar">
  <a class="brand" href="/"><span class="brand-mark"></span><span>Keen</span></a>
  <div class="topbar-right"><a class="btn btn-primary" href="/">Start free</a></div>
</header>

<main class="shell">
  <nav class="seo-breadcrumbs" aria-label="Breadcrumb">
    <a href="/">Keen</a> <span aria-hidden="true">›</span> <span>Courses</span>
  </nav>

  <article class="seo-article">
    <h1>Every course with questions on Keen</h1>
    <p class="lede">
      ${totals.questions.toLocaleString('en-US')} questions and ${totals.cards.toLocaleString('en-US')} flashcards
      across ${totals.courses} courses, each broken into its real units. Courses still being authored are not
      listed here.
    </p>
    <p><a class="btn btn-primary" href="/">Start practising free</a></p>
    ${sections}
  </article>
</main>

<footer class="seo-footer">
  <p><a href="/">Keen</a> · Adaptive study for high school and college</p>
</footer>

</body>
</html>
`;
}

/**
 * The landing-page FAQ as HTML, built from the same SHELL_FAQ array that feeds
 * the FAQPage schema. One source, two renderings: they cannot disagree.
 */
function shellFaqHtml() {
  return SHELL_FAQ.map((item) => `
        <div class="seo-faq-item">
          <h3>${escapeHtml(item.q)}</h3>
          <p>${escapeHtml(item.a)}</p>
        </div>`).join('');
}

module.exports = {
  shellFaqHtml,
  originFor,
  robotsTxt,
  sitemapXml,
  llmsTxt,
  pricingMarkdown,
  shellJsonLd,
  coursePageHtml,
  courseIndexHtml,
  publishedCourses,
  catalogueTotals,
  escapeHtml,
  jsonLdSafe,
  SHELL_FAQ,
};
