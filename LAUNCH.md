# Launching Keen

Follow this top to bottom, in order. Every step says what to type, what you
should see, and what to do when it goes wrong.

**Every command assumes you are in the project folder first:**

```
cd ~/Desktop/whetstone-real
```

If you get `command not found` or `Cannot find module`, you are almost certainly
in the wrong folder. Run the line above and try again.

---

## What you are actually doing

You are moving Keen off **Render**, where the database is wiped on every
restart, onto **Fly.io**, where it lives on a **persistent volume** that
survives deploys.

**This is why accounts kept vanishing.** It was never a bug in the sign-in code.
Render's free tier gave the app a `/tmp` directory, `/tmp` is cleared whenever
the container restarts, and the entire database lived there.

**The accounts on the current site do not come with you.** There is no
migration, because there is nothing durable to migrate. Do this before real
students sign up, not after.

Cost when you are done: about **$3 a month**.

---

## Step 1 — Install the Fly CLI

```
curl -L https://fly.io/install.sh | sh
```

Close your terminal, open a new one, then check:

```
fly version
```

You should see a version number. If you get `command not found`, the installer
printed a line to add to your PATH. Follow it, then open another new terminal.

---

## Step 2 — Make a Fly account

```
fly auth signup
```

This opens your browser. Sign up and **add a card** — Fly requires one even at
small usage. You will be charged around $3/month for the machine size in
`fly.toml`, not more.

Already have an account: `fly auth login`

---

## Step 3 — Create the app

```
fly launch --no-deploy
```

Answer like this:

| Prompt | Answer |
|---|---|
| Copy existing configuration? | **Yes** (it found `fly.toml`) |
| App name | `keen` is taken. Try `keen-study`, `keen-app`, `getkeen`. |
| Region | The one nearest you |
| Postgres / Redis / any database | **No** to all. Keen uses SQLite on a volume. |
| Deploy now? | **No** |

**Then open `fly.toml` and put the name you chose on the `app = ` line.** Skip
this and later deploys go to the wrong app.

From here on, replace `keen-study` with your real name in every command.

---

## Step 4 — Create the persistent volume

This is the step that fixes the vanishing accounts. Use the same region you
picked above.

```
fly volumes create keen_data --size 1 --region iad --app keen-study
```

Type `y` at the single-volume warning.

Check it:

```
fly volumes list --app keen-study
```

You should see `keen_data`, 1GB. That holds hundreds of thousands of accounts;
the question bank is baked into the image, not the volume.

> The name `keen_data` must match `source` under `[[mounts]]` in `fly.toml`. If
> they differ the app boots with no volume attached, and you are silently back
> to losing data on every deploy.

---

## Step 5 — Set your secrets

These are the two launch blockers.

### 5a. Session secret

Signs login cookies. The default is published in the source, so anyone reading
GitHub could forge a login as anybody.

```
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

Copy the long string, then:

```
fly secrets set SESSION_SECRET=paste_the_long_string_here --app keen-study
```

### 5b. Email

Without this, password reset emails only print to the server log, so anyone who
forgets their password is locked out permanently.

1. Sign up at https://resend.com (free tier is enough to start).
2. **Domains → Add Domain.** Real email needs a domain you own.
3. **API Keys → Create API Key.** Name it `keen-production`. Copy it, it is
   shown once.

```
fly secrets set RESEND_API_KEY=re_your_key_here --app keen-study
fly secrets set MAIL_FROM="Keen <noreply@yourdomain.com>" --app keen-study
```

### 5c. Public URL

```
fly secrets set PUBLIC_URL=https://keen-study.fly.dev --app keen-study
```

Must be `https://` or session cookies are not marked `Secure`.

---

## Step 6 — Deploy

```
fly deploy --app keen-study
```

Three to six minutes the first time, mostly building the question bank into the
image. It should end with `1 desired, 1 placed, 1 healthy`.

```
curl https://keen-study.fly.dev/api/health
```

You want `"status":"ok"` and roughly 25,000 questions.

**If it fails:**

```
fly logs --app keen-study
```

Read the last 20 lines. The two usual causes are a volume name that does not
match `fly.toml`, and the volume being in a different region from the machine.

---

## Step 7 — Prove the database actually persists

Do not skip this. It is the whole reason for the move.

1. Open your site, create an account, add a class.
2. `fly apps restart keen-study`
3. Wait 30 seconds and reload.

**You should still be signed in with your class still there.** If you have been
signed out and the account is gone, the volume is not mounted. Check
`fly volumes list` against `[[mounts]] source` in `fly.toml`.

---

## Step 8 — Stripe, so you can charge the $4.99

**Do not advertise a price until this step is finished and you have put a real
card through it.** Billing is in demo mode right now: Upgrade grants Premium
without taking money.

**Tom Ngo has to own this.** The Stripe account needs his name, his details, his
bank account. In most US states a minor cannot form a binding contract, which
makes an account in your name a problem for you and for Stripe. Not optional.

1. Tom registers at https://dashboard.stripe.com/register and completes
   verification. Expect a day or two.
2. **Products → Add product**, three times:

| Product | Price | Billing |
|---|---|---|
| Keen Premium Monthly | $4.99 | Recurring, monthly |
| Keen Premium Annual | $29.99 | Recurring, yearly |
| Keen Study Group Seat | $3.99 | Recurring, monthly |

3. Copy each **price ID**. It starts with `price_`. It is *not* the product ID,
   which starts with `prod_`. Using the product ID is the most common mistake
   here and gives you a checkout page that will not load.

```
fly secrets set \
  STRIPE_SECRET_KEY=sk_live_xxx \
  STRIPE_PRICE_PREMIUM_MONTHLY=price_xxx \
  STRIPE_PRICE_PREMIUM_ANNUAL=price_xxx \
  STRIPE_PRICE_GROUP_SEAT_MONTHLY=price_xxx \
  --app keen-study
```

4. **Developers → Webhooks → Add endpoint.**
   - URL: `https://keen-study.fly.dev/api/webhooks/stripe`
   - Events: `checkout.session.completed`, `customer.subscription.updated`,
     `customer.subscription.deleted`
   - Copy the signing secret (starts with `whsec_`):

```
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx --app keen-study
fly deploy --app keen-study
```

5. Confirm: `curl https://keen-study.fly.dev/api/health` must show
   `billingMode` as `live`, not `demo`.

6. **Put a real card through it.** Buy Premium yourself, confirm the charge in
   Stripe, confirm the app unlocks, then refund yourself from the dashboard.
   Test mode does not prove the webhook works in production.

---

## Step 9 — Your own domain (optional)

```
fly certs create keen.app --app keen-study
```

Fly prints DNS records to add at your registrar. Once they resolve:

```
fly secrets set PUBLIC_URL=https://keen.app --app keen-study
fly deploy --app keen-study
```

---

## Step 10 — Final check

```
node scripts/launch-check.js
```

This reads your local `.env`, so it still warns about things set as Fly secrets.
The real checklist:

- [ ] `/api/health` returns `status: ok`
- [ ] You made an account, restarted the app, and were still signed in
- [ ] Terms and Privacy load and name **Tom Ngo** as operator
- [ ] Terms prices match what you charge ($4.99 / $29.99 / $3.99)
- [ ] A password reset email actually arrives
- [ ] `billingMode` is `live` before you advertise a price
- [ ] One real card has been through checkout and refunded

---

## Turning Render off

Leave it running a few days in case you need to look at something. Then:
Render dashboard → your service → **Settings → Delete Service**.

You are not losing data. Render was already deleting it for you.

---

## Everyday commands

```
cd ~/Desktop/whetstone-real       # always first

fly logs --app keen-study         # what is happening right now
fly status --app keen-study       # is it up
fly deploy --app keen-study       # ship your latest commit
fly apps restart keen-study       # turn it off and on again
fly secrets list --app keen-study # which secrets are set (values hidden)
fly ssh console --app keen-study  # a shell inside the running machine
```

### Back up the database

A volume is durable, but durable is not backed up. It protects you from a
deploy. It does not protect you from your own code deleting the wrong rows.

```
fly ssh console --app keen-study -C "node scripts/backup.js"
```

Worth running before any deploy that touches `lib/db.js`.
