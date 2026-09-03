'use strict';
/**
 * End-to-end check of the automatic-renewal consent gate against a running
 * server. Unit tests cover lib/consent.js in isolation; this proves the HTTP
 * layer actually refuses a charge, which is the part that would hurt.
 *
 *   node scripts/consent-smoke.js [baseUrl]
 */

const BASE = process.argv[2] || 'http://localhost:3799';
let cookie = '';

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, json };
}

let failures = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n          ${detail}` : ''}`);
  if (!ok) failures += 1;
}

(async () => {
  const email = `smoke${Date.now()}@test.dev`;
  const signup = await call('POST', '/api/auth/signup', {
    email, password: 'hunter2hunter2', displayName: 'Smoke',
    birthYear: 2008, acceptTerms: true,
  });
  if (signup.status !== 201) {
    console.error('Could not sign up:', signup.status, signup.json);
    process.exit(1);
  }

  const disc = (await call('GET', '/api/billing/disclosure?plan=premium&interval=annual')).json;
  const monthly = (await call('GET', '/api/billing/disclosure?plan=premium&interval=monthly')).json;

  console.log('\n──── what the student sees before paying ────\n');
  console.log(disc.text);
  console.log(`\n  [ ] ${disc.checkboxLabel}`);
  console.log(`  [ ] ${disc.payerLabel}`);

  console.log('\n──── the gate ────');

  const noBoxes = await call('POST', '/api/billing/premium', { interval: 'annual' });
  check('a charge with no boxes ticked is refused',
    noBoxes.status === 400, noBoxes.json && noBoxes.json.error);

  const renewalOnly = await call('POST', '/api/billing/premium', {
    interval: 'annual', agreedToRenewal: true, disclosureHash: disc.hash,
  });
  check('renewal box alone is not enough (payer attestation required)',
    renewalOnly.status === 400, renewalOnly.json && renewalOnly.json.error);

  const payerOnly = await call('POST', '/api/billing/premium', {
    interval: 'annual', payerAttested: true, disclosureHash: disc.hash,
  });
  check('payer attestation alone is not enough',
    payerOnly.status === 400, payerOnly.json && payerOnly.json.error);

  const forged = await call('POST', '/api/billing/premium', {
    interval: 'annual', agreedToRenewal: true, payerAttested: true, disclosureHash: 'deadbeef',
  });
  check('a client that showed different wording is refused',
    forged.status === 400, forged.json && forged.json.error);

  const stale = await call('POST', '/api/billing/premium', {
    interval: 'monthly', agreedToRenewal: true, payerAttested: true, disclosureHash: disc.hash,
  });
  check('consent to the annual price cannot buy the monthly plan',
    stale.status === 400, stale.json && stale.json.error);

  check('annual and monthly disclosures are different documents',
    disc.hash !== monthly.hash);

  const good = await call('POST', '/api/billing/premium', {
    interval: 'annual', agreedToRenewal: true, payerAttested: true, disclosureHash: disc.hash,
  });
  check('a fully consented checkout is allowed through',
    good.status === 200, good.json && (good.json.message || good.json.url || ''));

  console.log('\n──── stored proof ────');
  const { getDb } = require('../lib/db');
  const rows = getDb().prepare(
    'SELECT email, plan, interval, amount_cents, terms_version, payer_attested, consented_at FROM renewal_consents WHERE email = ?'
  ).all(email);
  console.log(JSON.stringify(rows, null, 1));
  check('exactly one consent stored, and only for the charge that succeeded',
    rows.length === 1 && rows[0].amount_cents === 2999,
    `${rows.length} row(s)`);

  console.log(failures ? `\n${failures} FAILED\n` : '\nAll consent checks passed.\n');
  process.exit(failures ? 1 : 0);
})();
