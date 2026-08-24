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

// TESTING_MODE=1 turns on the tester tools: an in-app plan switcher and a
// raised free-tier limit. It is off unless explicitly set, so a real launch
// cannot enable it by accident. Never leave it on once you take payments -
// it lets any signed-in account grant itself Premium.
const TESTING_MODE = process.env.TESTING_MODE === '1';

const config = {
  testingMode: TESTING_MODE,
  port: Number(process.env.PORT || 3000),
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',
  publicUrl: process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`,

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    pricePremiumMonthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || '',
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
  premiumModes: TESTING_MODE ? [] : ['match', 'test', 'apexam'],

  // Free daily allowances, per mode. A single global counter meant one Learn
  // session consumed the entire day, including modes the student had not
  // touched yet.
  freeDailyLimits: {
    learn: TESTING_MODE ? 200 : 3,
    review: TESTING_MODE ? 200 : 5,
  },

  plans: {
    free: {
      id: 'free',
      label: 'Free',
      // 5/day is the real product limit. During a friend test that is hit in
      // about thirty seconds, leaving testers nothing to give feedback on.
      dailyQuestionLimit: TESTING_MODE ? 200 : 5,
      maxSubjects: TESTING_MODE ? 8 : 1,
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
