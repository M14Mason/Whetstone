# Whetstone Launch Instructions

Do these in order. Each step says exactly what to click or type, and how to
tell it worked.

**Run this at any point to see where you stand:**

```bash
node scripts/launch-check.js
```

It prints `[STOP]` for anything that will lose data, leak, or take money
incorrectly, and `[warn]` for things you can live with. It exits 1 while any
blocker remains. Right now it reports **4 blockers**, and this document is how
you clear them.

I am not a lawyer and none of this is legal advice.

---

## STEP 1 — An adult becomes the operator

**Why this is first:** in most US states a minor cannot form a binding
contract. That affects your Terms, your ability to take payments, and any
business entity. Stripe requires the account holder to be 18+. Every later step
depends on this one.

1. Ask a parent or guardian to be the legal operator. Explain that they are
   named in the Terms and that the Stripe account and bank account will be in
   their name.
2. Open `legal/TERMS.md` and `legal/PRIVACY.md`.
3. Find and replace every `PARENT_OR_GUARDIAN_LEGAL_NAME` with their full legal
   name, exactly as it appears on their ID.

```bash
# From the repo root. Replace the name, keep the quotes.
grep -rl PARENT_OR_GUARDIAN_LEGAL_NAME legal/ | \
  xargs sed -i '' 's/PARENT_OR_GUARDIAN_LEGAL_NAME/Jane A. Ngo/g'

grep -rn PARENT_OR_GUARDIAN legal/    # must print nothing
```

**Verify:** `node scripts/launch-check.js` no longer lists the two legal
blockers.

### 1b. Get the Terms actually read

`legal/TERMS.md` is a template and says so. It contains an arbitration clause,
a class-action waiver and a liability cap. **California limits or voids several
of those**, and California is your governing state.

- Have a lawyer read both documents.
- Once genuinely reviewed, delete the "Read this before you launch" callout at
  the top of `TERMS.md`.

### 1c. Decide the under-13 rule

Signup asks for birth year and gates at 13, but it is a self-declared
checkbox. If a child under 13 gets through, **COPPA applies** and requires
verifiable parental consent, with per-violation penalties.

Simplest compliant answer: block under-13 outright, server-side, on birth year.
Ask me and I will add it with a test.

---

## STEP 2 — Stop the database erasing itself

**This is the single most important technical step.** Nothing else matters if
accounts vanish.

`render.yaml` points `DATABASE_PATH` at `/tmp`. Render's free plan has no
persistent disk, so `/tmp` is wiped on **every deploy and every wake from
sleep**. This is why your own login "broke" — Render deleted your account.

### Option A — Render with a disk (fewest changes)

1. Go to https://dashboard.render.com and open the **whetstone** service.
2. **Settings → Instance Type →** change from Free to a paid instance. Free
   instances cannot have disks.
3. **Disks → Add Disk.**
   - Name: `whetstone-data`
   - Mount path: `/data`
   - Size: 1 GB
4. **Environment →** set:
   - `DATABASE_PATH` = `/data/whetstone.db`
   - `BACKUP_DIR` = `/data/backups`
5. **Manual Deploy → Deploy latest commit.**

### Option B — Fly.io (`fly.toml` is already in the repo)

```bash
fly volumes create whetstone_data --size 1 --region sjc
fly secrets set DATABASE_PATH=/data/whetstone.db BACKUP_DIR=/data/backups
fly deploy
```

### Verify it for real — do not skip this

```bash
# 1. Create an account on the live site.
# 2. Force a redeploy (Render: Manual Deploy. Fly: fly deploy).
# 3. Log in again with the same account.
```

If you can log in after a redeploy, the disk is real. If you cannot, the mount
is wrong and everything else is pointless.

---

## STEP 3 — Secrets

### 3a. SESSION_SECRET

Currently the built-in default, which means anyone who reads the source can
forge a login cookie for any account.

```bash
openssl rand -base64 48
```

Render: **Environment → Add Environment Variable** → `SESSION_SECRET` = that
value. (`render.yaml` already has `generateValue: true`, but confirm the
dashboard shows a real value, not the default.)

Fly: `fly secrets set SESSION_SECRET="paste-it-here"`

**Changing this logs everyone out once.** Do it before you have users.

### 3b. PUBLIC_URL

Must be `https://`, or session cookies are not marked Secure.

- Render: `PUBLIC_URL` = `https://whetstone.onrender.com` (or your domain)
- Fly: `fly secrets set PUBLIC_URL="https://your-domain"`

### 3c. TRUST_PROXY

Set `TRUST_PROXY=1`. Behind Render or Fly, rate limiting otherwise sees the
proxy's IP, so one abusive user rate-limits everybody.

Only set this behind a proxy you control. On a host you do not control, a
client can forge `X-Forwarded-For` and evade limits entirely.

---

## STEP 4 — Email, or nobody can reset a password

Without this the app runs in console mode: reset and verification emails only
print to the server log. A user who forgets their password is locked out
permanently.

1. Sign up at https://resend.com (free tier is enough to start).
2. **Domains → Add Domain.** If you do not have one yet, you can start with
   Resend's shared sending domain and move later.
3. **API Keys → Create API Key.** Copy it once; it is not shown again.
4. Set on your host:
   - `RESEND_API_KEY` = the key
   - `MAIL_FROM` = `Whetstone <hello@yourdomain.com>`

**Verify:** use "Forgot your password?" on the live site with a real address
and confirm the email arrives.

---

## STEP 5 — Payments (only when you are ready to charge)

You can launch **free** without this. Billing currently runs in demo mode:
"Upgrade" grants Premium and charges nothing. That is fine for a free launch
and dishonest the moment you display a price, so do not advertise $4.99 until
this is done.

1. The adult from Step 1 creates the Stripe account at https://stripe.com
   (Stripe requires 18+ and will verify identity).
2. Complete identity verification and connect a bank account.
3. **Products → Add Product:**
   - `Whetstone Premium Monthly` — $4.99 / month recurring
   - `Whetstone Premium Annual` — $29.99 / year recurring
   - `Whetstone Study Group` — $3.99 / month recurring, per seat
   Copy each **Price ID** (starts `price_`).
4. **Developers → Webhooks → Add endpoint:**
   - URL: `https://your-domain/api/billing/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the **Signing secret** (starts `whsec_`).
5. Set on your host:
   - `STRIPE_SECRET_KEY` = `sk_live_...`
   - `STRIPE_PUBLISHABLE_KEY` = `pk_live_...`
   - `STRIPE_PRICE_PREMIUM` = `price_...`
   - `STRIPE_WEBHOOK_SECRET` = `whsec_...`

**Without `STRIPE_WEBHOOK_SECRET`, payments succeed and subscriptions never
activate.** The launch check treats a missing one as a blocker.

**Test with Stripe test keys first:** card `4242 4242 4242 4242`, any future
expiry, any CVC. Then test a *declined* card: `4000 0000 0000 0002`.

Sales tax on digital subscriptions applies in some states. Stripe Tax handles
it for a fee. Ask the accountant.

---

## STEP 6 — Final checks before you share the link

```bash
node scripts/launch-check.js     # must say READY TO LAUNCH
npm test                         # 142 unit, 37 e2e, 19 DOM smoke
```

Then, on the live site, on your phone, on cellular rather than wifi:

- [ ] Sign up as a brand-new user
- [ ] Complete onboarding end to end
- [ ] Answer 3 questions and hit the Learn wall — the paywall should appear
- [ ] Confirm Review still works after Learn is exhausted (separate allowance)
- [ ] Open Terms and Privacy from the signup screen — they must render, not 404
- [ ] Tap Match — it should show the Premium paywall, not fail silently
- [ ] Check the streak appears and survives one question
- [ ] Force a redeploy, then log back in with the same account

---

## STEP 7 — Go

1. `git push` and let the host deploy.
2. Confirm `https://your-domain/api/health` returns `"status":"ok"`.
3. Share the link.

**Watch for the first hour:** `/api/health` reports `errorRate` and
`topErrorRoutes`. If `errorRate` climbs above a percent or two, something is
wrong and the route name is in that payload.

Bug reports from users land in your database. Export them with:

```bash
npm run bugs
```

---

## Useful commands

```bash
node scripts/launch-check.js            # readiness, exits 1 on blockers
npm test                                # full suite
node scripts/purge-test-accounts.js     # dry run: list test accounts
node scripts/purge-test-accounts.js --confirm   # delete them
npm run backup                          # snapshot the database
npm run bugs                            # export user bug reports
```

---

## What changed for launch

- **`TESTING_MODE` no longer exists.** It disabled every premium gate and
  exposed a route that let any signed-in account grant itself Premium — and it
  shipped enabled, so none of the paywall existed on the live site while it was
  on. Removed rather than merely defaulted off.
- **`/api/dev/plan` deleted**, along with the in-app plan switcher.
- **51 test accounts purged** from the local database (0 real accounts existed;
  backup at `data/whetstone.db.prelaunch-*`).
- If you want generous limits for a demo, set `FREE_LEARN_LIMIT` and
  `FREE_REVIEW_LIMIT`. Those change how much is free. They never disable a gate
  or grant a plan.

## Current free tier

| | Free | Premium |
|---|---|---|
| Learn | 3/day | unlimited |
| Review Mistakes | 5/day | unlimited |
| Flashcards | unlimited | unlimited |
| Match, Practice Test, AP Exam | locked | unlimited |

Premium $4.99/mo or $29.99/yr. Study Group $3.99/seat/mo, minimum 3.
