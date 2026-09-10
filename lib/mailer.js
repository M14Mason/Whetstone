'use strict';

/**
 * Email delivery.
 *
 * Two modes, chosen by whether RESEND_API_KEY is set:
 *   LIVE    - sends through Resend's HTTP API (free tier, no SDK needed).
 *   CONSOLE - prints the message and the link to the server log.
 *
 * Console mode is not a stub to be replaced later; it is how you develop and
 * test the reset flow without an email account, and it keeps the whole app
 * runnable out of the box. Sent messages are also recorded in memory so tests
 * can assert on them.
 */

const { config } = require('./config');

const outbox = [];
const MAX_OUTBOX = 50;

/**
 * A Resend key is `re_` followed by a long random string.
 *
 * Checking the SHAPE matters because a merely non-empty value flips the app
 * into live mode, and then every message is handed to a provider that rejects
 * it. Console mode at least puts the confirmation link in the log where it can
 * be used; a bogus key produces silence and a user waiting forever for an
 * email that was never going to arrive. This exact thing happened by pasting
 * the placeholder `re_...` from documentation straight into fly secrets.
 */
const RESEND_KEY_SHAPE = /^re_[A-Za-z0-9_-]{16,}$/;

function keyLooksValid() {
  return RESEND_KEY_SHAPE.test(String(process.env.RESEND_API_KEY || ''));
}

function isLive() {
  return keyLooksValid();
}

// Say so once, at boot, rather than failing quietly on the first signup.
if (process.env.RESEND_API_KEY && !keyLooksValid()) {
  console.warn(
    '\n  [mailer] RESEND_API_KEY is set but does not look like a Resend key.'
    + '\n           Falling back to console mode so confirmation links still work.'
    + '\n           A real key starts with re_ and is far longer than this one.\n'
  );
}

function record(message) {
  outbox.push({ ...message, sentAt: new Date().toISOString() });
  while (outbox.length > MAX_OUTBOX) outbox.shift();
}

async function sendViaResend({ to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.MAIL_FROM || 'Keen <onboarding@resend.dev>',
      to: [to],
      subject,
      text,
    }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.stringify(await res.json()); } catch { /* ignore */ }
    throw new Error(`Email provider rejected the message (${res.status}) ${detail}`);
  }
  return res.json();
}

async function send({ to, subject, text }) {
  record({ to, subject, text });

  if (!isLive()) {
    console.log('\n  ---- EMAIL (console mode, nothing was actually sent) ----');
    console.log(`  To:      ${to}`);
    console.log(`  Subject: ${subject}`);
    for (const line of text.split('\n')) console.log(`  ${line}`);
    console.log('  --------------------------------------------------------\n');
    return { mode: 'console' };
  }

  try {
    await sendViaResend({ to, subject, text });
    return { mode: 'live' };
  } catch (err) {
    // A failed email must not take down the request. The user gets a generic
    // response either way, and the error is logged for the operator.
    console.error('[mailer] send failed:', err.message);
    return { mode: 'failed', error: err.message };
  }
}

function passwordResetEmail(email, token) {
  const link = `${config.publicUrl}/reset?token=${token}`;
  return {
    to: email,
    subject: 'Reset your Keen password',
    text: [
      'Someone asked to reset the password for this Keen account.',
      '',
      'Open this link to choose a new password:',
      link,
      '',
      'The link expires in 1 hour and can only be used once.',
      'If you did not request this, you can ignore this email. Nothing has changed.',
    ].join('\n'),
  };
}

function verificationEmail(email, token) {
  const link = `${config.publicUrl}/verify?token=${token}`;
  return {
    to: email,
    subject: 'Confirm your Keen email',
    text: [
      'Welcome to Keen.',
      '',
      'Confirm this email address by opening the link below:',
      link,
      '',
      'The link expires in 24 hours.',
    ].join('\n'),
  };
}

module.exports = {
  keyLooksValid,
  send,
  isLive,
  outbox,
  passwordResetEmail,
  verificationEmail,
};
