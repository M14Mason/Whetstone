'use strict';

/**
 * The launch dashboard, rendered on the server.
 *
 * No client-side JavaScript and no charting library: every number here is
 * printed into the HTML. A dashboard that needs a script to run is a dashboard
 * that shows nothing on a locked-down school network, and this page's whole
 * job is to be readable on a phone in a hallway five minutes before class.
 */

const { escapeHtml } = require('./seo');
const courses = require('./courses');

function pct(value) {
  if (value === null || value === undefined) return '--';
  return `${Math.round(value * 100)}%`;
}

function num(value) {
  if (value === null || value === undefined) return '--';
  return Number(value).toLocaleString('en-US');
}

function oneDecimal(value) {
  if (value === null || value === undefined) return '--';
  return Number(value).toFixed(1);
}

/** A plain bar, drawn with a div width. Readable, and impossible to break. */
function bar(share) {
  const w = Math.max(0, Math.min(100, Math.round((share || 0) * 100)));
  return `<div class="adm-bar"><div class="adm-bar-fill" style="width:${w}%"></div></div>`;
}

function funnelRows(funnel) {
  const top = funnel[0] ? funnel[0].count : 0;
  return funnel.map((step, i) => {
    const share = top ? step.count / top : 0;
    const prev = i > 0 ? funnel[i - 1].count : null;
    const lost = prev === null ? null : prev - step.count;
    return `
      <tr>
        <th>${escapeHtml(step.step)}</th>
        <td class="num">${num(step.count)}</td>
        <td class="num">${pct(share)}</td>
        <td class="bar-cell">${bar(share)}</td>
        <td class="num dim">${lost === null ? '' : (lost > 0 ? `-${num(lost)}` : '')}</td>
      </tr>`;
  }).join('');
}

function sparkline(series) {
  const max = Math.max(1, ...series.map((d) => d.signups));
  return series.map((d) => `
    <div class="adm-spark-col" title="${escapeHtml(d.day)}: ${d.signups} signups">
      <div class="adm-spark-bar" style="height:${Math.round((d.signups / max) * 100)}%"></div>
      <span>${escapeHtml(d.day.slice(5))}</span>
    </div>`).join('');
}

function adminPageHtml(data) {
  const { retest, topicImprovement: ti, usage, signups } = data;

  const courseRows = data.topCourses.map((c) => {
    const course = courses.getCourse(c.courseId);
    return `<tr>
      <th>${escapeHtml(course ? course.name : c.courseId)}</th>
      <td class="num">${num(c.students)}</td>
      <td class="num">${num(c.attempts)}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="3" class="dim">Nobody has answered anything yet.</td></tr>';

  const reportRows = data.reportedQuestions.map((r) => `
    <tr>
      <th class="mono">${escapeHtml(r.questionId)}</th>
      <td class="num">${num(r.reports)}</td>
      <td class="num">${num(r.open)}</td>
      <td class="dim">${escapeHtml(String(r.lastReportedAt || '').slice(0, 16).replace('T', ' '))}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="dim">No question has been reported.</td></tr>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>Keen launch metrics</title>
<link rel="stylesheet" href="/styles.css">
<style>
  .adm-wrap { max-width: 900px; margin: 0 auto; padding: 1.25rem 1rem 4rem; }
  .adm-grid { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); }
  .adm-stat { border: 1px solid var(--border); border-radius: 14px; padding: .85rem 1rem; background: var(--surface, transparent); }
  .adm-stat .k { font-size: .78rem; color: var(--text-muted); display: block; }
  .adm-stat .v { font-size: 1.7rem; font-weight: 700; line-height: 1.2; }
  .adm-stat .s { font-size: .78rem; color: var(--text-secondary); }
  .adm-card { border: 1px solid var(--border); border-radius: 16px; padding: 1rem 1.1rem; margin-top: 1.1rem; }
  .adm-card h2 { margin: 0 0 .2rem; font-size: 1.05rem; }
  .adm-card p.why { margin: 0 0 .9rem; color: var(--text-secondary); font-size: .87rem; }
  table.adm { width: 100%; border-collapse: collapse; font-size: .9rem; }
  table.adm th, table.adm td { text-align: left; padding: .45rem .4rem; border-bottom: 1px solid var(--border); }
  table.adm th { font-weight: 600; }
  table.adm .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  table.adm .bar-cell { width: 34%; }
  .adm-bar { height: 8px; border-radius: 99px; background: var(--track); overflow: hidden; }
  .adm-bar-fill { height: 100%; background: var(--accent); }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem; word-break: break-all; }
  .adm-spark { display: flex; gap: 3px; align-items: flex-end; height: 120px; }
  .adm-spark-col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; }
  .adm-spark-bar { width: 100%; background: var(--accent); border-radius: 4px 4px 0 0; min-height: 2px; }
  .adm-spark-col span { font-size: .6rem; color: var(--text-muted); margin-top: .25rem; }
  .adm-note { font-size: .82rem; color: var(--text-secondary); margin-top: .6rem; }
  @media (max-width: 520px) { table.adm .bar-cell { display: none; } }
</style>
</head>
<body>
<div class="adm-wrap">
  <p><a href="/">&larr; Back to Keen</a></p>
  <h1 class="u-m-0">Launch metrics</h1>
  <p class="dim">Live from this app's own database. ${escapeHtml(String(data.generatedAt).slice(0, 16).replace('T', ' '))} UTC. Aggregates only, no student is identified.</p>

  <div class="adm-grid u-mt-1rem">
    <div class="adm-stat"><span class="k">Accounts</span><span class="v">${num(signups.total)}</span><span class="s">${num(usage.activeThisWeek)} studied this week</span></div>
    <div class="adm-stat"><span class="k">Questions answered</span><span class="v">${num(usage.attempts)}</span><span class="s">${pct(usage.accuracy)} correct</span></div>
    <div class="adm-stat"><span class="k">Retest recovery</span><span class="v">${pct(retest.recoveryRate)}</span><span class="s">of ${num(retest.missed)} missed questions</span></div>
    <div class="adm-stat"><span class="k">Open reports</span><span class="v">${num(data.openBugs + data.reportedQuestions.reduce((a, r) => a + r.open, 0))}</span><span class="s">${num(data.openBugs)} bugs, ${num(data.reportedQuestions.length)} questions</span></div>
  </div>

  <div class="adm-card">
    <h2>The retest metric</h2>
    <p class="why">Of the concepts a student got wrong, how many did they later get right? This is the only number that tests what Keen claims to do. It is measured per concept, not per question: the bank is built in pairs that ask one concept two ways, and the engine deliberately serves the pair you have not seen. Matching on the exact question would measure something the app is built never to do.</p>
    <table class="adm">
      <tr><th>Concepts missed on the first try</th><td class="num">${num(retest.missed)}</td><td class="num"></td><td class="bar-cell"></td></tr>
      <tr><th>Brought back for a second try</th><td class="num">${num(retest.retried)}</td><td class="num">${pct(retest.retryRate)}</td><td class="bar-cell">${bar(retest.retryRate)}</td></tr>
      <tr><th>Later answered correctly</th><td class="num">${num(retest.recovered)}</td><td class="num">${pct(retest.recoveryRate)}</td><td class="bar-cell">${bar(retest.recoveryRate)}</td></tr>
      <tr><th>Stuck, of the ones retried</th><td class="num">${num(retest.recovered)}</td><td class="num">${pct(retest.recoveryRateOfRetried)}</td><td class="bar-cell">${bar(retest.recoveryRateOfRetried)}</td></tr>
    </table>
    <p class="adm-note">Read it this way: if the second row is low, the app is not bringing missed concepts back often enough, which is a scheduling problem. If the second row is high and the last row is low, it brings them back and they do not stick, which means the explanations are not teaching.</p>
    <p class="adm-note">Cross-check, matching the exact question id instead of the concept: ${num(retest.exactQuestion.recovered)} of ${num(retest.exactQuestion.missed)}. This is expected to be near zero and is not a finding: the engine filters out questions you have already seen, so the same question id rarely comes back at all.</p>
  </div>

  <div class="adm-card">
    <h2>Do they get better at the topic?</h2>
    <p class="why">Memorising one question is not learning. For every student and topic with at least six answers, this compares their first three attempts with their most recent three.</p>
    <table class="adm">
      <tr><th>Student-topic pairs measured</th><td class="num">${num(ti.topicsMeasured)}</td></tr>
      <tr><th>Accuracy, first three attempts</th><td class="num">${pct(ti.accuracyFirstThree)}</td></tr>
      <tr><th>Accuracy, most recent three</th><td class="num">${pct(ti.accuracyLastThree)}</td></tr>
      <tr><th>Pairs that improved</th><td class="num">${pct(ti.improvedRate)}</td></tr>
    </table>
  </div>

  <div class="adm-card">
    <h2>Where people drop out</h2>
    <p class="why">Every row is the same measure at a higher threshold, so each one is genuinely a subset of the row above and the "lost" column is a real number of people. The biggest drop is the thing worth fixing next.</p>
    <table class="adm">
      <thead><tr><th>Step</th><th class="num">People</th><th class="num">Of signups</th><th class="bar-cell"></th><th class="num">Lost</th></tr></thead>
      <tbody>${funnelRows(data.funnel)}</tbody>
    </table>
  </div>

  <div class="adm-card">
    <h2>Milestones</h2>
    <p class="why">These happen in any order, or not at all. Confirming an email is not required in order to study, so none of these is a stage of anything and they are not subtracted from each other.</p>
    <table class="adm">
      <thead><tr><th>Milestone</th><th class="num">People</th><th class="num">Of signups</th><th class="bar-cell"></th></tr></thead>
      <tbody>${(data.milestones || []).map((m) => `
        <tr><th>${escapeHtml(m.label)}</th><td class="num">${num(m.count)}</td><td class="num">${pct(m.share)}</td><td class="bar-cell">${bar(m.share)}</td></tr>`).join('')}</tbody>
    </table>
  </div>

  <div class="adm-card">
    <h2>Signups, last 14 days</h2>
    <p class="why">The day a teacher announces it should be visible here. If it is not, the announcement did not land.</p>
    <div class="adm-spark">${sparkline(signups.series)}</div>
  </div>

  <div class="adm-card">
    <h2>Questions students flagged</h2>
    <p class="why">A question reported more than once is actively teaching people the wrong answer. Fix these first.</p>
    <table class="adm">
      <thead><tr><th>Question</th><th class="num">Reports</th><th class="num">Open</th><th>Last</th></tr></thead>
      <tbody>${reportRows}</tbody>
    </table>
  </div>

  <div class="adm-card">
    <h2>Most-studied classes</h2>
    <table class="adm">
      <thead><tr><th>Class</th><th class="num">Students</th><th class="num">Answers</th></tr></thead>
      <tbody>${courseRows}</tbody>
    </table>
  </div>

  <p class="adm-note">Sample sizes matter more than percentages here. A 100% recovery rate over four questions means nothing; the same number over four hundred means the product works.</p>
</div>
</body>
</html>`;
}

module.exports = { adminPageHtml };
