# Deploying Keen to Fly.io

Fly is the recommended host because Keen stores data in a SQLite file and
Fly gives you a persistent volume on the free-ish tier. Vercel and Netlify
functions do **not** keep a writable disk between requests, so the database
would silently reset on every deploy.

Total time: about 20 minutes. Cost: $0 to start.

---

## Before you begin

- A credit card. Fly requires one even on the free allowance. **This needs an
  adult**, same as Stripe.
- The app running locally at least once (see START_HERE.md).

---

## Step 1: install the Fly CLI

```bash
brew install flyctl        # macOS
fly version                # confirm it installed
```

No Homebrew? `curl -L https://fly.io/install.sh | sh`

## Step 2: sign up and log in

```bash
fly auth signup     # or: fly auth login
```

## Step 3: pick your app name

App names are globally unique, so `keen` is probably taken. Edit
`fly.toml` and change the first line:

```toml
app = "keen-yourname"
```

Also set `primary_region` to the code nearest your users (`fly platform regions`
lists them). `iad` is Virginia, `lax` is Los Angeles, `ord` is Chicago.

## Step 4: create the app and its volume

```bash
cd keen
fly apps create keen-yourname

# The volume holds the database. Without it, every deploy wipes all accounts.
fly volumes create keen_data --size 1 --region iad --yes
```

`--size 1` is 1GB, far more than enough. The volume name must match the
`source` in `fly.toml`.

## Step 5: set your secrets

```bash
fly secrets set SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
fly secrets set PUBLIC_URL="https://keen-yourname.fly.dev"
```

Secrets are encrypted and injected as environment variables at runtime. Never
put them in `fly.toml`, which is committed to git.

## Step 6: deploy

```bash
fly deploy
```

First build takes a few minutes. When it finishes:

```bash
fly open              # opens the live site
fly logs              # watch the server output
fly status            # machine health
```

You should see the startup banner in the logs with no `WARNING` lines. If
`SESSION_SECRET is still the default` appears, step 5 did not take effect.

## Step 7: verify the deployment

```bash
curl https://keen-yourname.fly.dev/api/health
```

Expect `"status":"ok"` and a question count over 1,000. Then in a browser:
create an account, answer a question, open the Progress tab.

Now redeploy once and confirm your test account still exists. **If the account
is gone, the volume is not mounted** and you will lose all user data on every
deploy. Check the `[[mounts]]` block in `fly.toml` and re-run step 4.

---

## Custom domain (optional, ~$12/year)

1. Buy a domain (Cloudflare and Namecheap are both fine).
2. `fly certs create keen.com`
3. Fly prints the DNS records to add at your registrar. Add them.
4. Wait for propagation, usually minutes.
5. Update the public URL so links in emails and Stripe redirects are correct:

```bash
fly secrets set PUBLIC_URL="https://keen.com"
```

---

## Backups

The volume is not backed up by default. Fly does take volume snapshots, but
relying only on those is thin. Take your own:

```bash
fly ssh console -C "node /app/scripts/backup.js"

# Copy one down to your machine
fly ssh sftp get /data/backups/keen-2026-08-10T12-00-00.db
```

Run this weekly at minimum. `scripts/backup.js` uses `VACUUM INTO`, which is
safe on a live database, and it verifies the snapshot opens before reporting
success.

To restore: stop the app, replace `/data/keen.db` with a backup file,
start it again.

---

## Turning on email (optional but recommended)

Without an email provider the app runs in console mode: reset links are printed
to `fly logs` instead of being delivered, which works but is not usable by real
students.

1. Sign up at resend.com (free tier: 3,000 emails/month).
2. Verify a domain, or use their test sender to start.
3. `fly secrets set RESEND_API_KEY="re_..."`
4. `fly secrets set MAIL_FROM="Keen <noreply@yourdomain.com>"`

## Turning on error monitoring (optional but recommended)

1. Create a free Sentry account and a Node project.
2. Copy the DSN.
3. `fly secrets set SENTRY_DSN="https://...@...ingest.sentry.io/..."`

Errors will then appear in Sentry instead of only in `fly logs`. `/api/health`
reports the current error count either way.

---

## Turning on payments

Do this last, and only after the question bank and the app have been tested by
real people. See LAUNCH.md section 2.5. In short:

```bash
fly secrets set STRIPE_SECRET_KEY="sk_live_..."
fly secrets set STRIPE_PRICE_PREMIUM_MONTHLY="price_..."
fly secrets set STRIPE_PRICE_GROUP_SEAT_MONTHLY="price_..."
fly secrets set STRIPE_WEBHOOK_SECRET="whsec_..."
```

Point the Stripe webhook at `https://yourdomain.com/api/webhooks/stripe`.
**Test with Stripe test keys first.** If the webhook is wrong, customers pay and
receive nothing.

---

## Costs

| Item | Cost |
|---|---|
| One shared-cpu-1x machine, 256MB | Within Fly's free allowance at low usage |
| 1GB volume | Within the free allowance |
| Domain | ~$12/year, optional |
| Resend email | Free to 3,000/month |
| Sentry | Free tier |

Scale up (not out) if you outgrow it: `fly scale memory 512`. Because the
database is a single file, running multiple machines would give each its own
copy. If you reach that point, migrate `lib/db.js` to Postgres.

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `disk I/O error` in logs | Volume not mounted. Check `[[mounts]]` and that the volume exists in the same region. |
| Accounts vanish after deploy | Same as above. Data is being written into the container instead of the volume. |
| `SESSION_SECRET is still the default` | Step 5 did not run, or ran before the app was created. |
| Health check failing | `fly logs` for the real error. Usually a missing secret or a bad `DATABASE_PATH`. |
| Reset emails never arrive | Expected without `RESEND_API_KEY`; the link is in `fly logs`. |
| Rate limits triggering for everyone | `TRUST_PROXY` unset, so every request looks like it comes from Fly's proxy IP. |
