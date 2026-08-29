# Whetstone Launch Instructions

Everything is done except the parts that need your credentials or your card.
Follow these in order.

**Every command below assumes you are in the repo. Start with:**

```bash
cd ~/Desktop/whetstone-real
```

Running `node scripts/launch-check.js` from your home folder is what caused
`Cannot find module`. It is not installed globally; it lives in this project.

**Check where you stand at any time:**

```bash
cd ~/Desktop/whetstone-real
node scripts/launch-check.js
```

`[STOP]` means it will lose data, leak, or take money wrongly. `[warn]` means
you can live with it. It exits 1 while any blocker stands.

I am not a lawyer and none of this is legal advice.

---

## Already done for you

- **Operator is Tom Ngo** in both `legal/TERMS.md` and `legal/PRIVACY.md`.
- **One account per email** — already enforced three ways, now covered by two
  tests: a `UNIQUE` constraint in the schema, an explicit duplicate check at
  signup, and `.trim().toLowerCase()` on both signup and login so
  `Tom@X.com`, `tom@x.com` and `  tom@x.com  ` are all the same account.
- **Annual billing is wired.** The landing page advertised $29.99/year but
  `billing.js` only ever supported the monthly price id, so annual was
  unsellable. There is now a real annual checkout path and an annual/monthly
  toggle on the paywall, with annual preselected.
- **`TRUST_PROXY=1`** added to `render.yaml`.
- **The persistent-disk config is written and commented out** in `render.yaml`,
  ready for Step 2.

Two blockers remain, and both need something only you can get.

---

## STEP 1 — Tom signs off on the Terms

His name is in the documents. He should read what he is agreeing to before
anyone signs up.

`legal/TERMS.md` contains an arbitration clause, a class-action waiver and a
liability cap. **California limits or voids several of those**, and California
is your governing state. A lawyer should read both documents. Once genuinely
reviewed, delete the "Read this before you launch" callout at the top of
`TERMS.md`.

**Also decide the under-13 rule.** Signup gates at 13 with a self-declared
checkbox. If a child under 13 gets through, COPPA applies and requires
verifiable parental consent, with per-violation penalties. The cheap correct
answer is to block under-13 server-side on birth year. Ask me and I will add it
with a test.

---

## STEP 2 — Stop the database erasing itself

**Nothing else matters until this is done.** Render's free plan has no disk, so
`/tmp` is wiped on every deploy and every wake from sleep. Every account
disappears. This is why your own login broke.

**This step starts billing you, which is why I did not do it for you.**

1. Open `render.yaml`. Change `plan: free` to `plan: starter`.
2. Uncomment the four `disk:` lines directly below it.
3. Change the two env values further down:
   - `DATABASE_PATH` from `/tmp/whetstone.db` to `/data/whetstone.db`
   - `BACKUP_DIR` from `/tmp/backups` to `/data/backups`
4. Commit and push:

```bash
cd ~/Desktop/whetstone-real
git add render.yaml
git commit -m "Move the database onto a persistent disk"
git push
```

5. In the Render dashboard the blueprint sync may need approving. Open
   https://dashboard.render.com, select **whetstone**, and if a "Blueprint
   changes detected" banner appears, approve it. Otherwise use
   **Manual Deploy → Deploy latest commit**.

### Verify it — do not skip

1. Create an account on the live site.
2. Force a redeploy (**Manual Deploy → Deploy latest commit**).
3. Log in again with that account.

If you can log in, the disk is real. If you cannot, the mount path is wrong
and everything after this is pointless.

Then turn on backups:

```bash
npm run backup      # writes into BACKUP_DIR
```

---

## STEP 3 — Secrets

### 3a. SESSION_SECRET (blocker)

Right now it is the built-in default, which means anyone who reads your public
source can forge a login cookie for any account.

Here is one generated for you. Use it, or make your own with
`openssl rand -base64 48`:

```
W2giPGKduLQ0qSM5Z+T/ewcKoDU5hx2xjtY9X1kQyznMTZTDGUYoshwdM1AvucvK
```

Render: **whetstone → Environment → Add Environment Variable**
- Key: `SESSION_SECRET`
- Value: the string above

Do NOT put it in the repo. It is a secret and your repo is public.

Changing this logs everyone out once, so do it before you have users.

### 3b. PUBLIC_URL

Render: **Environment →** `PUBLIC_URL` = `https://whetstone.onrender.com`
(or your own domain once you have one). Without https, session cookies are not
marked Secure.

---

## STEP 4 — Email, or nobody can reset a password (blocker)

Without this, reset and verification emails only print to the server log. A
user who forgets their password is locked out permanently.

1. Sign up at https://resend.com — the free tier is 3,000 emails a month,
   which is far more than you need to start.
2. **API Keys → Create API Key.** Name it `whetstone-production`. Copy it
   immediately; it is shown once.
3. Render: **Environment →** add:
   - `RESEND_API_KEY` = the key you copied
   - `MAIL_FROM` = `Whetstone <onboarding@resend.dev>`

`onboarding@resend.dev` is Resend's shared sending domain and works with no DNS
setup. When you have your own domain, add it under **Domains**, verify the DNS
records, then change `MAIL_FROM` to use it. Your own domain is far less likely
to land in spam.

**Verify:** on the live site use "Forgot your password?" with a real address
and confirm the email arrives.

---

## STEP 5 — Stripe

You can launch **free** without this. Billing is in demo mode: "Upgrade" grants
Premium and charges nothing. That is fine for a free launch, but **do not
advertise $4.99 until this is finished** — the price is on your landing page,
so either complete this step or take the pricing section down.

### 5a. Create the account

**Tom creates it.** Stripe requires the account holder to be 18+ and verifies
identity against government ID.

1. https://stripe.com → Sign up.
2. Complete identity verification and connect a bank account.
3. Stay in **Test mode** (toggle, top right) until Step 5e.

### 5b. Create three products

**Products → Add product** for each. Copy each **Price ID** (starts `price_`).

| Product name | Price | Billing |
|---|---|---|
| Whetstone Premium Monthly | $4.99 | Recurring, monthly |
| Whetstone Premium Annual | $29.99 | Recurring, yearly |
| Whetstone Study Group | $3.99 | Recurring, monthly |

### 5c. Create the webhook

**Developers → Webhooks → Add endpoint.**

- Endpoint URL: `https://whetstone.onrender.com/api/webhooks/stripe`
- Events to send:
  - `checkout.session.completed`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`

Copy the **Signing secret** (starts `whsec_`).

> The path is `/api/webhooks/stripe`. I gave you `/api/billing/webhook` in an
> earlier version of this document and that was wrong — it does not exist.

### 5d. Set the environment variables

Render: **Environment →** add all five:

```
STRIPE_SECRET_KEY               sk_test_...   (sk_live_... at 5e)
STRIPE_WEBHOOK_SECRET           whsec_...
STRIPE_PRICE_PREMIUM_MONTHLY    price_...
STRIPE_PRICE_PREMIUM_ANNUAL     price_...
STRIPE_PRICE_GROUP_SEAT_MONTHLY price_...
```

**Without `STRIPE_WEBHOOK_SECRET`, payments succeed and subscriptions never
activate.** The launch check treats a missing one as a blocker.

### 5e. Test, then go live

With test keys, on the live site:

- [ ] Upgrade with card `4242 4242 4242 4242`, any future expiry, any CVC
- [ ] Confirm Match and AP Exam unlock
- [ ] Try a declined card: `4000 0000 0000 0002` — you should stay on Free
- [ ] Cancel, and confirm the premium modes lock again
- [ ] Repeat for the annual option using the toggle on the paywall

Then flip Stripe out of Test mode, swap `sk_test_` for `sk_live_`, recreate
the webhook against live mode, and update `STRIPE_WEBHOOK_SECRET`.

Sales tax on digital subscriptions applies in some states. Stripe Tax handles
it for a fee. Ask an accountant.

---

## STEP 6 — Final checks

```bash
cd ~/Desktop/whetstone-real
node scripts/launch-check.js     # must say READY TO LAUNCH
npm test                          # 144 unit, 37 e2e, 19 DOM smoke
```

Then on the live site, on your phone, on cellular rather than wifi:

- [ ] Sign up as a brand-new user
- [ ] Try signing up again with the SAME email — it must be refused
- [ ] Complete onboarding
- [ ] Answer 3 questions, hit the Learn wall, see the paywall
- [ ] Confirm Review still works after Learn is exhausted
- [ ] Open Terms and Privacy from signup — they must render, not 404
- [ ] Tap Match — Premium paywall, not a silent failure
- [ ] Answer one question tomorrow and confirm the streak went to 2
- [ ] Redeploy, then log back in with the same account

---

## STEP 7 — Go

1. Confirm `https://whetstone.onrender.com/api/health` returns `"status":"ok"`.
2. Share the link.

**Watch the first hour.** `/api/health` reports `errorRate` and
`topErrorRoutes`. If `errorRate` climbs past a percent or two, the failing
route name is right there in the payload.

User bug reports land in your database:

```bash
npm run bugs
```

---

## Commands

```bash
cd ~/Desktop/whetstone-real            # everything below needs this first

npm run launch-check                   # readiness, exits 1 on blockers
npm test                               # full suite
npm run backup                         # snapshot the database
npm run bugs                           # export user bug reports
npm run purge-test-accounts            # dry run: list test accounts
npm run purge-test-accounts -- --confirm   # actually delete them
```

## Free tier as shipped

| | Free | Premium |
|---|---|---|
| Learn | 3/day | unlimited |
| Review Mistakes | 5/day | unlimited |
| Flashcards | unlimited | unlimited |
| Match, Practice Test, AP Exam | locked | unlimited |

Premium $4.99/month or $29.99/year. Study Group $3.99/seat/month, minimum 3.

To raise the free limits for a demo, set `FREE_LEARN_LIMIT` and
`FREE_REVIEW_LIMIT`. They change how much is free; they never disable a gate
or grant a plan.
