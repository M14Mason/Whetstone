# Keen Privacy Policy

**Last updated: 2026-08-12**
**Operated by: Tom Ngo**
**Contact: masonngo70@gmail.com**

---

## The short version

We collect your email, display name, birth year, and your answers to practice
questions. We use them to run the app and personalise your practice. We do not
sell your data or show you ads. You can ask us to delete everything at any time.

---

## 1. What we collect

**When you create an account:**

| Data | Why |
|---|---|
| Email address | To sign you in, and to send password resets |
| Display name | Shown to you and to your study group |
| Password | Stored only as a **scrypt hash**, never in readable form |
| Birth year | To confirm you are 13 or older |
| Time zone offset | So your daily free questions reset at your local midnight |

**As you use the app:**

| Data | Why |
|---|---|
| Which questions you answered and whether you were right | To find your weak topics |
| Which answer choice you picked | To spot questions many students misread |
| Per-topic skill ratings and review schedule | To decide what to show you next |
| Study group membership | To show the shared leaderboard |

**Automatically:**

- Your IP address, used transiently for rate limiting to prevent abuse. It is
  not stored in the database.
- Basic error logs when something breaks.

**We do not collect** your real name, address, phone number, school, or
location.

## 2. Payment information

Payments are handled by **Stripe**. We never receive or store your card number.
We keep only a Stripe customer identifier so we know which subscription belongs
to which account. Stripe's own privacy policy governs the data they hold:
<https://stripe.com/privacy>

## 3. Who we share with

We do not sell your data. We share it only with services required to run
Keen:

| Service | What it receives | Purpose |
|---|---|---|
| Stripe | Email, subscription details | Processing payments |
| Resend | Email address | Sending password resets |
| Fly.io | All app data, stored on their servers | Hosting |
| [Sentry, if enabled] | Error details, which may include a user id | Diagnosing crashes |

We may disclose data if legally required to do so.

## 4. Users under 18

Keen is for ages **13 and up**. We do not knowingly collect personal
information from children under 13. If you believe a child under 13 has created
an account, contact masonngo70@gmail.com and we will delete it promptly.

If you are between 13 and 18, please get a parent or guardian's permission
before signing up, and have them handle any payment.

Note for schools: if a school or district wants to use Keen with students,
additional obligations (such as FERPA) may apply. Contact us before doing so.

## 5. How long we keep data

- **Account data:** until you delete your account.
- **Answer history:** until you delete your account. It is what makes the
  adaptive engine work.
- **Sessions:** expire after 30 days and are then purged automatically.
- **Password reset tokens:** expire within 1 hour, verification tokens within
  24 hours, then purged.
- **Backups:** may retain data for up to 14 days after deletion before being
  rotated out.

## 6. Your rights

You can:

- **See your data.** Ask and we will send you a copy.
- **Correct it.** Change your display name in the app; email us for anything
  else.
- **Delete it.** Email masonngo70@gmail.com and we will delete your account and its
  data, except anything we must keep for tax or legal reasons (payment records
  are typically kept 7 years).
- **Withdraw consent.** Stop using the service and ask us to delete your data.

Depending on where you live (for example the EU under GDPR, or California under
CCPA) you may have additional rights. Contact us and we will honour them.

## 7. Security

- Passwords are hashed with **scrypt** and a unique random salt.
- Sessions use random 256-bit tokens in HttpOnly cookies.
- Password reset tokens are stored **hashed**, so a database leak does not hand
  anyone a working reset link.
- Traffic is served over HTTPS in production.
- Login and signup are rate limited to slow down attacks.

No system is perfectly secure. If we discover a breach affecting your personal
data, we will notify affected users promptly.

## 8. Cookies

We use exactly one cookie: a session cookie that keeps you signed in. There are
no advertising or analytics cookies and no third-party trackers.

## 9. Changes

If we make a material change to this policy, we will notify account holders by
email. The "Last updated" date above always reflects the current version.

## 10. Contact

Questions, requests, or complaints: **masonngo70@gmail.com**
