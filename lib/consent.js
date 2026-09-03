'use strict';

/**
 * Auto-renewal consent: the disclosure, the tick box, and the receipt.
 *
 * WHY THIS FILE EXISTS
 *
 * Keen charges a card and then charges it again next month without asking.
 * That is a "negative option" or "automatic renewal" offer, and it is the most
 * heavily regulated thing this app does. Two sets of rules apply:
 *
 *   - Federal: ROSCA. No negative option online unless the seller clearly and
 *     conspicuously discloses all material terms BEFORE taking billing
 *     information, and gets express informed consent BEFORE charging.
 *     The FTC's newer "click to cancel" rule was vacated by the Eighth Circuit
 *     in July 2025, so that specific rule is not law. ROSCA and Section 5 of
 *     the FTC Act were never vacated and are what the FTC actually enforces.
 *     Building only to the vacated rule would have been building to nothing.
 *
 *   - California: the Automatic Renewal Law as amended by AB 2863, in force
 *     since 1 July 2025. Stricter than ROSCA on three points that matter here:
 *     consent to the renewal terms must be separate from consent to anything
 *     else, cancellation must be available in the same medium the person
 *     signed up in, and the seller must retain proof of consent for three
 *     years or one year past termination, whichever is longer.
 *
 * Keen's customers are high school students, so California is not optional
 * trivia. It is the single largest state and the one whose Attorney General
 * actually brings these cases.
 *
 * HOW IT WORKS
 *
 * The disclosure text is generated here, on the server, and nowhere else. The
 * client fetches it, renders it verbatim, and echoes back a hash of what it
 * displayed. If the hash does not match what this file would have produced,
 * the checkout is refused.
 *
 * That echo is the entire point. Without it the stored "proof of consent"
 * would only prove that somebody ticked a box, not what the box said. A
 * future redesign could quietly soften the wording and the old records would
 * still look clean. With it, every stored row carries the exact sentence the
 * person read, and the hash proves the page was not showing something else.
 */

const crypto = require('node:crypto');
const { getDb } = require('./db');
const { config } = require('./config');

/** Money, written the way a person reads it, not the way a database stores it. */
function money(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * The terms of a given offer, as structured data.
 *
 * Everything the disclosure needs to say comes from config, so the sentence
 * and the amount charged cannot drift apart. A price change is a one-line
 * config edit and the disclosure, the stored consent and the tests all follow.
 */
function offerTerms(plan, interval, seats = 1) {
  if (plan === 'group') {
    const perSeat = config.plans.group.priceCentsPerSeat;
    const n = Math.max(config.plans.group.minSeats || 3, Number(seats) || 0);
    return {
      plan: 'group',
      interval: 'monthly',
      seats: n,
      amountCents: perSeat * n,
      period: 'month',
      label: `Study Group, ${n} seats`,
      unit: `${money(perSeat)} per seat per month`,
    };
  }

  const annual = interval === 'annual';
  return {
    plan: 'premium',
    interval: annual ? 'annual' : 'monthly',
    seats: 1,
    amountCents: annual ? config.plans.premium.priceCentsAnnual : config.plans.premium.priceCents,
    period: annual ? 'year' : 'month',
    label: annual ? 'Keen Premium, annual' : 'Keen Premium, monthly',
    unit: null,
  };
}

/**
 * The disclosure itself.
 *
 * Written to be read by a fifteen year old, because that is who reads it.
 * Every sentence here is a legal requirement wearing plain clothes:
 *
 *   1. that it renews automatically            (ROSCA + ARL: material term)
 *   2. how often, and how much each time       (ARL: recurring charge amount)
 *   3. when the first charge lands             (ARL: length of the term)
 *   4. that it continues until cancelled       (ARL: renewal is indefinite)
 *   5. exactly where to cancel, in one step    (ARL: same-medium cancellation)
 *   6. that cancelling keeps access paid for   (not required, but it is true,
 *                                               and it is the thing people are
 *                                               actually afraid of)
 *
 * No dark patterns. Nothing is pre-ticked, nothing is buried, and the price
 * appears in the sentence next to the word "again" rather than three screens
 * away in a table.
 */
function buildDisclosure(plan, interval, seats = 1) {
  const t = offerTerms(plan, interval, seats);
  const amount = money(t.amountCents);
  const seatNote = t.unit ? ` (${t.unit})` : '';

  const lines = [
    `This is a subscription that renews by itself.`,
    `You will be charged ${amount}${seatNote} today, and ${amount} every ${t.period} after that, automatically, until you cancel.`,
    `There is no end date. It keeps renewing every ${t.period} on its own.`,
    `You can cancel any time in Settings, under Plan and billing, in about two clicks. No email, no phone call, no asking us.`,
    `If you cancel, you keep everything you paid for until the ${t.period} you already paid for runs out. We do not cut you off early.`,
  ];

  return { terms: t, text: lines.join('\n') };
}

/** Stable fingerprint of a disclosure, used to prove what was on screen. */
function hashDisclosure(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Everything the client needs to render the consent block.
 *
 * The client is not trusted to compose any of this. It renders `text`, and if
 * it renders anything else the hash check downstream rejects the checkout.
 */
function disclosureFor(plan, interval, seats = 1) {
  const { terms, text } = buildDisclosure(plan, interval, seats);
  return {
    ...terms,
    amount: money(terms.amountCents),
    text,
    hash: hashDisclosure(text),
    // The wording next to the checkbox. Separate from the disclosure body so
    // the ARL's "separate from any other agreement" requirement is visibly
    // satisfied: this box agrees to the renewal and to nothing else.
    checkboxLabel: `I understand this renews automatically at ${money(terms.amountCents)} every ${terms.period} until I cancel.`,
    // A minor cannot be held to a contract they can walk away from, and every
    // Keen account holder is thirteen or older, which means a large share are
    // under eighteen. A minor's purchase is voidable in California and most
    // other states: they can disaffirm it and demand the money back, and a
    // parent who sees an unfamiliar charge will simply file a chargeback.
    // This attestation does not make a minor's contract enforceable, nothing
    // can. What it does is put an explicit, timestamped record on file that we
    // asked for adult authority before taking the money, which is the
    // difference between a refund and an accusation of billing kids.
    payerLabel: 'I am 18 or older, or I have permission from a parent or guardian to make this payment.',
  };
}

class ConsentError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

/**
 * Verify and record consent. Throws unless everything lines up.
 *
 * Called before the Stripe Checkout Session is created, never after, because
 * both ROSCA and the ARL require consent BEFORE billing information is taken,
 * and Stripe's page is where billing information is taken.
 */
function recordConsent(user, { plan, interval, seats, agreed, payerAttested, disclosureHash }) {
  if (agreed !== true) {
    throw new ConsentError('Please tick the box confirming you understand this subscription renews automatically.');
  }
  if (payerAttested !== true) {
    throw new ConsentError('Please confirm you are 18 or older, or have a parent or guardian\'s permission to pay.');
  }

  const expected = disclosureFor(plan, interval, seats);
  if (disclosureHash !== expected.hash) {
    // Either an old tab with stale pricing, or a client showing different
    // wording from the one we can prove. Both are reasons not to charge.
    throw new ConsentError('The plan details changed. Please reopen the upgrade screen and check the terms again.');
  }

  const db = getDb();
  const row = db.prepare(`
    INSERT INTO renewal_consents
      (user_id, email, plan, interval, amount_cents, disclosure, disclosure_hash,
       terms_version, payer_attested, consented_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    user.id,
    user.email,
    expected.plan,
    expected.interval,
    expected.amountCents,
    expected.text,
    expected.hash,
    config.tosVersion || 'unversioned',
    1,
    new Date().toISOString(),
  );

  return { id: Number(row.lastInsertRowid), hash: expected.hash };
}

/** Most recent consent on file for a user, for the receipt screen and support. */
function latestConsent(userId) {
  return getDb().prepare(
    'SELECT * FROM renewal_consents WHERE user_id = ? ORDER BY id DESC LIMIT 1'
  ).get(userId) || null;
}

/**
 * Consents old enough to drop.
 *
 * AB 2863 sets a floor of three years, not a ceiling, but keeping payment
 * records forever is its own liability. Nothing calls this on a timer yet;
 * it exists so the retention promise in the Privacy Policy is a function
 * somebody can run rather than a sentence nobody can act on.
 */
function purgeableBefore(now = new Date()) {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 3);
  return cutoff.toISOString();
}

module.exports = {
  offerTerms,
  buildDisclosure,
  hashDisclosure,
  disclosureFor,
  recordConsent,
  latestConsent,
  purgeableBefore,
  ConsentError,
  money,
};
