'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader so the project stays dependency-free.
function loadEnvFile() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile();

/* TESTING_MODE has been REMOVED.
 *
 * It disabled every premium gate and exposed a route that let any signed-in
 * account grant itself Premium. It shipped enabled, which meant none of the
 * paywall existed on the live site while it was on. A flag that silently turns
 * off billing enforcement is not something to keep near code that handles
 * money, so it is gone rather than merely defaulted off.
 *
 * If you need generous limits for a demo, raise them explicitly and visibly
 * with FREE_LEARN_LIMIT / FREE_REVIEW_LIMIT below. Those change how much is
 * free; they never disable a gate or grant a plan. */
const intEnv = (name, fallback) => {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
};

const config = {
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    pricePremiumMonthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || '',
    pricePremiumAnnual: process.env.STRIPE_PRICE_PREMIUM_ANNUAL || '',
    priceGroupSeatMonthly: process.env.STRIPE_PRICE_GROUP_SEAT_MONTHLY || '',
  },

  // Product rules. Changing these changes the business model in one place.
  // Study modes reserved entirely for paid plans. Kept here so the server gate
  // and the UI lock cannot drift apart.
  //
  // 'review' is deliberately NOT in this list: Review Mistakes gets a small
  // free daily allowance instead of a hard lock. Seeing your own wrong answers
  // come back is the single clearest demonstration of what the product does,
  // so locking it entirely sells the product worse than metering it does.
  premiumModes: ['match', 'test', 'apexam'],

  // Free daily allowances, per mode. A single global counter meant one Learn
  // session consumed the entire day, including modes the student had not
  // touched yet.
  freeDailyLimits: {
    learn: intEnv('FREE_LEARN_LIMIT', 3),
    review: intEnv('FREE_REVIEW_LIMIT', 5),
  },

  plans: {
    free: {
      id: 'free',
      label: 'Free',
      // Legacy global counter. Per-mode allowances in freeDailyLimits are what
      // the app actually meters against; this remains for older call sites.
      dailyQuestionLimit: intEnv('FREE_LEARN_LIMIT', 3),
      maxSubjects: intEnv('FREE_MAX_SUBJECTS', 1),
      priceCents: 0,
    },
    premium: {
      id: 'premium',
      label: 'Premium',
      dailyQuestionLimit: Infinity,
      maxSubjects: Infinity,
      // $4.99/mo, or $29.99/yr which lands at $2.50/mo. Priced against a
      // category where the nearest comparable annual plan is around $20/yr:
      // the annual option has to be the obvious choice, and monthly exists
      // mainly to make it look like one.
      priceCents: 499,
      priceCentsAnnual: 2999,
    },
    group: {
      id: 'group',
      label: 'Study Group',
      dailyQuestionLimit: Infinity,
      maxSubjects: Infinity,
      // Cheaper per head than solo Premium, which is the entire argument for
      // a group tier. Three seats is $11.97/mo total.
      priceCentsPerSeat: 399,
      minSeats: 3, // Deliberate: a 3-person ask is far easier than a 5-person one.
    },
  },

  // Adaptive engine tuning. See lib/adaptive.js for how each is used.
  adaptive: {
    startingAbility: 1000,
    kFactor: 32,
    difficultyRatings: { easy: 900, medium: 1050, hard: 1200 },
    // Aim slightly above current ability so practice stays productive
    // without becoming demoralizing. ~65-70% expected success.
    targetChallengeOffset: 40,
    // Spaced repetition intervals in minutes, indexed by streak length.
    reviewIntervalsMinutes: [0, 10, 60, 60 * 24, 60 * 24 * 3, 60 * 24 * 7, 60 * 24 * 16],
    recentQuestionMemory: 8,
    masteryThreshold: 0.85,
  },
};

function isBillingLive() {
  return Boolean(config.stripe.secretKey);
}

module.exports = { config, isBillingLive };
