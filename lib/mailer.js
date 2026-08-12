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

function isLive() {
  return Boolean(process.env.RESEND_API_KEY);
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
      from: process.env.MAIL_FROM || 'Whetstone <onboarding@resend.dev>',
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
    subject: 'Reset your Whetstone password',
    text: [
      'Someone asked to reset the password for this Whetstone account.',
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
    subject: 'Confirm your Whetstone email',
    text: [
      'Welcome to Whetstone.',
      '',
      'Confirm this email address by opening the link below:',
      link,
      '',
      'The link expires in 24 hours.',
    ].join('\n'),
  };
}

module.exports = {
  send,
  isLive,
  outbox,
  passwordResetEmail,
  verificationEmail,
};
