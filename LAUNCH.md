# Whetstone Launch Runbook

Everything that has to happen before Whetstone takes a single dollar, in the
order it has to happen. Written 23 Aug 2026.

**Read Phase 0 first.** Some of it is legal, not technical, and it gates
everything else. Nothing here is legal advice, and I am not a lawyer.

---

## Where things stand

| | Status |
|---|---|
| App | Live at https://whetstone.onrender.com |
| Catalogue | 159 courses: 62 regular, 56 honors, 38 AP, 3 test prep |
| Question bank | 25,348 questions, 12,165 flashcards |
| AP exam formats | 20 of 38 verified against College Board; 4 recorded as portfolio-only; **14 not yet researched** |
| Tests | 135 unit, 37 e2e, 19 DOM smoke |
| Payments | Demo mode. No card is ever charged. |
| Database | `/tmp` on Render free plan. **Wiped on every deploy and every sleep.** |

---

## Phase 0 - Before anything else (legal)

These block launch. They are not technical and you cannot code around them.

### 0.1 An adult owns the business

In most US states a minor cannot form a fully binding contract. That affects
your Terms of Service, your ability to accept payments, and any business
entity. Khan Academy requires its paying account holder to be 18+ for closely
related reasons.

- [ ] A parent or guardian agrees to be the legal operator
- [ ] Replace `PARENT_OR_GUARDIAN_LEGAL_NAME` in `legal/TERMS.md` and
      `legal/PRIVACY.md` with their full legal name.
      The server warns about this at startup until you do.
- [ ] Choose a business entity. A sole proprietorship in the adult's name is the
      cheapest start. An LLC gives liability separation. California LLCs carry
      an $800 minimum annual franchise tax - check current figures first.

### 0.2 A lawyer reads the terms

`legal/TERMS.md` is a template and says so in a callout at the top. It contains
an arbitration clause, a class-action waiver and a liability cap. **California
limits or voids several of those**, and you set California as governing state.

- [ ] An actual lawyer reviews both documents
- [ ] Confirm the arbitration and liability clauses are enforceable in CA
- [ ] Remove the "this is a template" callout once genuinely reviewed

### 0.3 COPPA and under-13 users

Signup asks birth year and gates at 13. That gate is a self-declared checkbox,
the weakest form there is. If a child under 13 gets through, **COPPA applies**
and requires verifiable parental consent. Penalties are per-violation.

- [ ] Decide: block under-13 outright (simplest), or build verifiable parental
      consent (expensive, slow)
- [ ] If blocking, enforce server-side on birth year, not just in the UI
- [ ] Have the lawyer confirm your approach

### 0.4 Under-18 users generally

Most users will be 13-17.

- [ ] Terms should require parent/guardian permission for under-18s (they
      currently do - verify the wording survives legal review)
- [ ] Consider requiring a parent's email for the payment relationship, the way
      Khan Academy does
- [ ] Ask the lawyer about California's Age-Appropriate Design Code

---

## Phase 1 - Stop losing user data

**The single most important technical item.** Nothing else matters if accounts
vanish.

`render.yaml` sets `DATABASE_PATH=/tmp/whetstone.db`. Render's free plan has no
persistent disk, so `/tmp` is wiped on every redeploy **and every wake from
sleep**. Accounts and progress do not survive. This is why your own login
"broke" - Render deleted your account.

Pick one:

### Option A - Render with a persistent disk (least change)
- [ ] Upgrade off the free plan (paid tiers start around $7/month; verify current pricing)
- [ ] Add a disk in `render.yaml`, mount at `/data`
- [ ] Set `DATABASE_PATH=/data/whetstone.db` and `BACKUP_DIR=/data/backups`
- [ ] Redeploy and confirm an account survives

### Option B - Fly.io (already configured)
`fly.toml` is in the repo and the Dockerfile already expects `/data`.
- [ ] `fly volumes create whetstone_data --size 1`
- [ ] Confirm the mount matches `DATABASE_PATH=/data/whetstone.db`
- [ ] `fly deploy`
- [ ] Confirm an account survives a redeploy

**Verify, do not assume.** Create an account, force a redeploy, log in again.
If you can log in, the disk is real.

- [ ] Schedule automated backups (`npm run backup` exists)
- [ ] Test restoring from a backup at least once

---

## Phase 2 - Security and configuration

### 2.1 Turn off testing mode
`render.yaml` sets `TESTING_MODE=1`. By its own comment it "lets any account
grant itself Premium". It also empties `premiumModes`, so **nothing is gated
right now** and the paywall never fires.

- [ ] Set `TESTING_MODE=0` (or remove it)
- [ ] Confirm `/api/modes/match` returns 402 for a free account
- [ ] Confirm the paywall appears when the Learn allowance runs out

### 2.2 Session secret
- [ ] Confirm `SESSION_SECRET` is platform-generated, not the default
      (Render's `generateValue: true` does this - verify it took)
- [ ] The server warns at startup if the default is still in use

### 2.3 HTTPS and cookies
- [ ] `PUBLIC_URL` must be `https://` in production or session cookies are not
      marked Secure. The server warns about this.

### 2.4 Rate limiting
- [ ] Set `TRUST_PROXY=1` behind Render/Fly so rate limiting sees real client
      IPs. Without it one abusive user can rate-limit everybody. With it set on
      a host you do NOT control, a client can forge `X-Forwarded-For` and evade
      limits entirely - so only set it behind a proxy you trust.

---

## Phase 3 - Payments

Currently `billingMode: demo`. No card is charged; "Upgrade" flips a database
field.

- [ ] The adult from Phase 0 creates the Stripe account (Stripe requires 18+)
- [ ] Complete Stripe identity verification, connect a bank account
- [ ] Set `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_PREMIUM`
- [ ] Set `STRIPE_WEBHOOK_SECRET` - **without it subscriptions never activate**,
      and the server warns at startup
- [ ] Test with Stripe test cards, including a failed payment
- [ ] Test cancellation end to end
- [ ] Sales tax: digital subscriptions are taxable in some states. Stripe Tax
      handles it for a fee. Ask the lawyer or an accountant.

**Do not skip:** verify a cancelled subscription actually re-locks premium
modes. There is an e2e test for this, but confirm against real webhooks too.

---

## Phase 4 - Before you tell anyone

- [ ] `npm test` passes (135 unit, 37 e2e, 19 DOM smoke, plus bank verifier)
- [ ] Sign up as a brand-new user on a phone, on cellular, not wifi
- [ ] Complete onboarding end to end
- [ ] Hit the free Learn limit and confirm the paywall fires
- [ ] Confirm Review still works after Learn is exhausted (separate allowance)
- [ ] Open Terms and Privacy from signup - they must render, not 404
- [ ] Upgrade, confirm unlock, cancel, confirm re-lock
- [ ] Check on a real iPhone and a real Android
- [ ] Confirm `/api/health` returns ok

---

## Phase 5 - Operations

- [ ] Decide where support email goes. `masonngo70@gmail.com` is currently in
      the legal documents and **is publicly visible in a public repo**.
      Consider a dedicated address.
- [ ] Set `RESEND_API_KEY` so password resets and verification actually send.
      Without it the app runs in console mode and emails only print to the
      server log, meaning **nobody can reset their password**.
- [ ] Set `MAIL_FROM` to a domain you control
- [ ] Watch `/api/health` for `errorRate` after launch
- [ ] Have a plan for the first bug report. The in-app reporter writes to your
      database; `npm run bugs` exports them.

---

## Phase 6 - Content gaps

Not launch blockers, but users will notice.

- [ ] **14 AP exam formats are still unresearched.** The app is honest about it,
      labelling them "Format not verified" and linking to College Board rather
      than inventing timings, but it is a visible gap. Remaining: Physics 2,
      Physics C (Mechanics), Physics C (E&M), Comparative Government, Art
      History, Music Theory, Latin, and the six world-language exams.
- [ ] FRQ practice covers 11 courses (18 questions). Other verified courses get
      MCQ practice and the format briefing only.
- [ ] AP 2-D Art, AP Drawing, AP Seminar and AP Research are correctly recorded
      as portfolio/performance courses with no written exam to practise.

---

## The honest summary

You cannot launch payments until an adult owns the entity and a lawyer has read
the terms. That is Phase 0 and it is not negotiable.

You should not run a real friend test until Phase 1 is done, because accounts
currently disappear and testers will assume the app is broken - which is
exactly what happened to you.

Everything after that is ordinary launch work.
