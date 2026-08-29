'use strict';

/**
 * Billing.
 *
 * Two modes:
 *   LIVE  - STRIPE_SECRET_KEY is set. Real Stripe Checkout Sessions are created
 *           and subscriptions are confirmed by webhook.
 *   DEMO  - No Stripe key. Upgrades are simulated locally so the whole app is
 *           usable end to end without any payment account. Nothing here charges
 *           a card in demo mode.
 *
 * Stripe is called over its REST API with fetch, so there is no SDK dependency.
 */

const crypto = require('node:crypto');
const { getDb } = require('./db');
const { config, isBillingLive } = require('./config');
const groups = require('./groups');

const STRIPE_API = 'https://api.stripe.com/v1';

class BillingError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'BillingError';
    this.statusCode = statusCode;
  }
}

function toFormBody(obj, prefix = '') {
  const parts = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    const field = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      parts.push(toFormBody(value, field));
    } else if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (typeof item === 'object') parts.push(toFormBody(item, `${field}[${i}]`));
        else parts.push(`${encodeURIComponent(`${field}[${i}]`)}=${encodeURIComponent(item)}`);
      });
    } else {
      parts.push(`${encodeURIComponent(field)}=${encodeURIComponent(value)}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

async function stripeRequest(endpoint, payload) {
  const res = await fetch(`${STRIPE_API}${endpoint}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.stripe.secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: toFormBody(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data && data.error ? data.error.message : 'Stripe request failed.';
    throw new BillingError(`Stripe: ${message}`, 502);
  }
  return data;
}

function setUserPlan(userId, plan) {
  getDb().prepare('UPDATE users SET plan = ? WHERE id = ?').run(plan, userId);
}

/**
 * Start a Premium subscription: $4.99/month or $29.99/year.
 *
 * Annual exists because the landing page advertises it. Selling a plan the
 * code cannot actually create is worse than not offering one, and for a while
 * that is exactly what this did -- only the monthly price id was ever wired up.
 */
async function startPremiumCheckout(user, interval = 'monthly') {
  const annual = String(interval).toLowerCase() === 'annual';

  if (!isBillingLive()) {
    setUserPlan(user.id, 'premium');
    return {
      mode: 'demo', url: null, interval: annual ? 'annual' : 'monthly',
      message: 'Demo mode: Premium unlocked locally. No payment was taken.',
    };
  }

  const priceId = annual ? config.stripe.pricePremiumAnnual : config.stripe.pricePremiumMonthly;
  if (!priceId) {
    throw new BillingError(
      annual
        ? 'STRIPE_PRICE_PREMIUM_ANNUAL is not configured.'
        : 'STRIPE_PRICE_PREMIUM_MONTHLY is not configured.',
      500);
  }

  const session = await stripeRequest('/checkout/sessions', {
    mode: 'subscription',
    success_url: `${config.publicUrl}/?billing=success`,
    cancel_url: `${config.publicUrl}/?billing=cancelled`,
    customer_email: user.email,
    client_reference_id: String(user.id),
    line_items: [{ price: priceId, quantity: 1 }],
    metadata: { user_id: String(user.id), kind: 'premium', interval: annual ? 'annual' : 'monthly' },
  });

  return { mode: 'live', url: session.url, interval: annual ? 'annual' : 'monthly' };
}

/**
 * Start a Study Group subscription ($6/seat/mo, minimum 3 seats).
 * The seat minimum is enforced server-side before any checkout is created.
 */
async function startGroupCheckout(user, groupId, seats) {
  const group = groups.getGroup(groupId);
  if (!group) throw new BillingError('Group not found.', 404);
  if (group.ownerId !== user.id) throw new BillingError('Only the group owner can pay for seats.', 403);

  const memberCount = groups.assertCanActivate(groupId); // throws if under the 3-seat minimum
  const seatCount = Math.max(Number(seats) || memberCount, groups.MIN_SEATS);

  if (!isBillingLive()) {
    groups.activateGroup(groupId, seatCount);
    return {
      mode: 'demo',
      url: null,
      seats: seatCount,
      message: `Demo mode: Study Group activated for ${seatCount} seats. No payment was taken.`,
    };
  }
  if (!config.stripe.priceGroupSeatMonthly) {
    throw new BillingError('STRIPE_PRICE_GROUP_SEAT_MONTHLY is not configured.', 500);
  }

  const session = await stripeRequest('/checkout/sessions', {
    mode: 'subscription',
    success_url: `${config.publicUrl}/?billing=success`,
    cancel_url: `${config.publicUrl}/?billing=cancelled`,
    customer_email: user.email,
    client_reference_id: String(user.id),
    line_items: [{ price: config.stripe.priceGroupSeatMonthly, quantity: seatCount }],
    metadata: { user_id: String(user.id), group_id: String(groupId), seats: String(seatCount), kind: 'group' },
  });

  return { mode: 'live', url: session.url, seats: seatCount };
}

/**
 * Verify a Stripe webhook signature (t=timestamp,v1=signature).
 * Implemented directly so the project stays dependency-free.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => p.split('=').map((s) => s.trim()))
  );
  const timestamp = parts.t;
  const provided = parts.v1;
  if (!timestamp || !provided) return false;

  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Apply a Stripe event. Called by the webhook route after signature checks.
 */
function applyWebhookEvent(event) {
  const type = event && event.type;
  const object = event && event.data && event.data.object;
  if (!type || !object) return { handled: false };

  const metadata = object.metadata || {};
  const userId = Number(metadata.user_id || object.client_reference_id);

  if (type === 'checkout.session.completed') {
    if (metadata.kind === 'group' && metadata.group_id) {
      groups.activateGroup(Number(metadata.group_id), Number(metadata.seats));
      return { handled: true, action: 'group_activated' };
    }
    if (Number.isInteger(userId) && userId > 0) {
      setUserPlan(userId, 'premium');
      if (object.customer) {
        getDb().prepare('UPDATE users SET stripe_customer_id = ? WHERE id = ?')
          .run(object.customer, userId);
      }
      return { handled: true, action: 'premium_activated' };
    }
  }

  if (type === 'customer.subscription.deleted') {
    if (metadata.kind === 'group' && metadata.group_id) {
      groups.deactivateGroup(Number(metadata.group_id));
      return { handled: true, action: 'group_deactivated' };
    }
    if (Number.isInteger(userId) && userId > 0) {
      setUserPlan(userId, 'free');
      return { handled: true, action: 'downgraded' };
    }
    if (object.customer) {
      const user = getDb().prepare('SELECT id FROM users WHERE stripe_customer_id = ?').get(object.customer);
      if (user) {
        setUserPlan(user.id, 'free');
        return { handled: true, action: 'downgraded' };
      }
    }
  }

  return { handled: false };
}

/**
 * Demo-mode downgrade so cancellation is testable without Stripe.
 */
function cancelDemo(user) {
  if (isBillingLive()) {
    throw new BillingError('Manage your subscription through the Stripe customer portal.', 400);
  }
  setUserPlan(user.id, 'free');
  const group = groups.getGroupForUser(user.id);
  if (group && group.ownerId === user.id && group.active) {
    groups.deactivateGroup(group.id);
  }
  return { plan: 'free' };
}

module.exports = {
  startPremiumCheckout,
  startGroupCheckout,
  verifyWebhookSignature,
  applyWebhookEvent,
  cancelDemo,
  setUserPlan,
  isBillingLive,
  BillingError,
};
