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
  // Study modes reserved for paid plans. Free keeps Learn and Flashcards, which
  // is enough to get real value and to understand what the paid modes do.
  // Kept here so the server gate and the UI lock cannot drift apart.
  premiumModes: TESTING_MODE ? [] : ['match', 'test', 'review'],

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
      priceCents: 899,
    },
    group: {
      id: 'group',
      label: 'Study Group',
      dailyQuestionLimit: Infinity,
      maxSubjects: Infinity,
      priceCentsPerSeat: 600,
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
