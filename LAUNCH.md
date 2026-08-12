# Whetstone launch runbook

Everything needed to go from this folder to a live product, in order.

---

## Part 0: how to view the app right now

```bash
cd whetstone
npm start
```

Open <http://localhost:3000>. Create an account with any email (nothing is sent),
any password of 8+ characters, and a birth year that makes you 13 or older.

If you see `disk I/O error`, the folder you unzipped into cannot host SQLite
(iCloud, Dropbox, OneDrive, and some network drives). Fix:

```bash
DATABASE_PATH=~/whetstone.db npm start
```

Try this to see the adaptive engine actually working:

1. Sign up, then go to **Plan** and click **Upgrade** (demo mode, no card).
2. Select all five subjects and save.
3. Answer 15-20 questions on **Practice**, deliberately getting one topic wrong
   every time.
4. Open **Progress**. That topic will be at the top of "Your weak spots," and
   you will notice it coming back far more often than the others.

Keyboard shortcuts: `1`-`6` to answer, `Enter` for the next question.

---

## Part 1: what I cannot do, and why

Four things need a human. This is not a limitation I can engineer around.

| Blocked on you | Why |
|---|---|
| Creating the GitHub repo and pushing | Requires signing in as you. Do not paste tokens into chat; see the note at the end. |
| Buying a domain | Registrars require an adult account holder and a real payment method. |
| Creating the hosting account | Same. Billing accounts need an adult. |
| Creating the Stripe account | Stripe requires the payout account holder to be 18+. **A parent or guardian must own this account.** |

Everything else — code, content, config, debugging, deploys once credentials
exist on your machine — I can do.

---

## Part 2: pre-launch checklist

Work top to bottom. Do not skip the free-tier steps to get to Stripe faster;
launching without payments is fine and reversible, launching with broken
payments is not.

### 2.1 Get it on GitHub

Follow [PUSH_TO_GITHUB.md](PUSH_TO_GITHUB.md). Two commands once the repo exists.

### 2.2 Pick a host

You need a host with a **persistent writable disk**, because the database is a
SQLite file. Default serverless functions on Vercel and Netlify wipe the disk
between requests, so the database would silently reset.

| Host | Free tier | Notes |
|---|---|---|
| **Fly.io** | Yes, with a small persistent volume | Best fit for this app. Recommended. |
| **Railway** | Trial credit, then paid | Simplest setup of the three. |
| **Render** | Yes, but free instances sleep | Sleeping is fine while you have no users. |
| A cheap VPS | No | Most control, most work, you patch the OS yourself. |

If you outgrow SQLite, the only file to rewrite is `lib/db.js`. Nothing else
touches the database directly.

### 2.3 Set your environment variables

```bash
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
```

Required in production:

```
SESSION_SECRET=<the value you just generated>
PUBLIC_URL=https://yourdomain.com
DATABASE_PATH=/data/whetstone.db     # point at your mounted volume
PORT=8080                            # whatever your host expects
TRUST_PROXY=1                        # only if behind your host's proxy
```

The server prints a `WARNING` on startup if `SESSION_SECRET` is still the
default. Do not ignore it: session tokens are the whole login system.

> `TRUST_PROXY=1` makes the app read `X-Forwarded-For` for rate limiting. Only
> set it when a proxy you control sits in front, otherwise clients can forge
> that header and bypass rate limits.

### 2.4 Verify before you point a domain at it

```bash
npm test                    # 62 unit + 23 end-to-end tests, all must pass
curl https://yourhost/api/health
```

Then manually: sign up, answer a question, check the dashboard, create a group.

### 2.5 Turn on payments (only when ready)

1. Parent creates the Stripe account and completes identity verification.
2. Create two recurring prices: **$8.99/month** and **$6.00/month**.
3. Set `STRIPE_SECRET_KEY`, `STRIPE_PRICE_PREMIUM_MONTHLY`,
   `STRIPE_PRICE_GROUP_SEAT_MONTHLY`.
4. Add a webhook endpoint at `https://yourdomain.com/api/webhooks/stripe`
   subscribed to `checkout.session.completed` and
   `customer.subscription.deleted`. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET`.
5. **Test in Stripe test mode first.** Use card `4242 4242 4242 4242`. Confirm a
   test subscription actually flips the account to Premium before touching live
   keys. If the webhook is misconfigured, customers pay and get nothing, which
   is the worst possible first impression.
6. Enable **Stripe Tax**. Several US states tax digital subscriptions, and
   collecting the wrong amount is your problem to fix later, not Stripe's.

Startup will read `Billing mode: LIVE (Stripe)` when the keys are picked up.

### 2.6 Legal pages

Before charging anyone you need a Terms of Service and a Privacy Policy. The
privacy policy must state what you collect (email, birth year, answer history),
why, and how to delete it. Whetstone is 13+ so COPPA's parental-consent
requirement does not apply, but you are still storing data about minors — say so
plainly. A generator is fine to start; have an adult read it.

---

## Part 3: known gaps

Honest list of what is not built yet. None of these block a soft launch to
friends; all of them matter before a public one.

| Gap | Impact | Priority |
|---|---|---|
| No email verification | Users can sign up with an address they do not own | Medium |
| No password reset | A forgotten password means a lost account | **High before public launch** |
| No account deletion UI | Privacy policies generally promise this | Medium |
| Rate limiting is per process | Multiple instances each get their own allowance | Low until you scale |
| No error monitoring | You will not know when something breaks | **High** — add Sentry, free tier |
| No database backups | A lost volume is a lost product | **High** — cron `cp` of the .db file |
| Question bank is 99 questions | Thin for a paid product; the plan targets ~1,000 | **High before charging** |

The last one is the real blocker on charging money. 99 questions is a convincing
demo and not yet a product someone should pay $8.99/month for. I can generate
more whenever you want; that is the single highest-value thing left.

---

## Part 4: what happens when you say the word

I cannot press a button and make this live, because of the four items in Part 1.
What I can do, immediately, on request:

- **Expand the question bank** toward 1,000, verified as I go.
- **Build password reset and email verification** (needs an email provider key,
  Resend and Postmark both have free tiers).
- **Add Sentry error monitoring** and a backup script.
- **Write the host-specific deploy config** (`fly.toml`, Dockerfile, or a
  Railway/Render config) once you have picked a host.
- **Draft the Terms and Privacy Policy** for an adult to review.
- **Walk you through the deploy live**, command by command, and debug whatever
  the host throws at you.

Realistic sequence from here: get it on GitHub today, deploy to a free host this
week with billing off, grow the question bank, then turn on payments once there
is enough content to justify the price.

---

## A note on that GitHub token

You pasted a personal access token into chat. Tokens with `repo` scope can read
and write every repository on the account, so treat any token that has ever been
in a chat log, a screenshot, or a commit as permanently burned. Revoke it at
<https://github.com/settings/tokens>.

Better habits going forward:

- Use `gh auth login`, which stores credentials in your OS keychain.
- If you must use a PAT, prefer a **fine-grained** token scoped to one
  repository with an expiry date.
- Never paste a secret anywhere it will be stored. That includes chats, issues,
  and commit messages.

This is not a hypothetical: leaked tokens get found and used, and GitHub
accounts get taken over this way regularly.
