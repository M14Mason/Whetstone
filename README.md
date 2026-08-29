# Keen

**Sharpen what you keep getting wrong.**

Keen is an adaptive study platform for high school and college students. It
tracks every question you miss, works out which topics are actually weak, and
keeps sending them back until they stick. Study groups start at 3 people, and the
leaderboard ranks improvement instead of who was already ahead.

Zero npm dependencies. Clone it, run it, it works.

---

## Quick start

```bash
git clone <your-repo-url>
cd keen
npm start
```

Then open <http://localhost:3000>.

There is nothing to install and no accounts to create. The app runs against a
local SQLite file and starts in **demo billing mode**, where upgrades are
simulated and no card is ever charged.

Requires **Node.js 22.5 or newer** (it uses the built-in `node:sqlite` module).

> **Getting `disk I/O error` on startup?** SQLite cannot run on some network
> shares, container mounts, and synced folders (Dropbox, OneDrive, iCloud). Point
> the database somewhere local instead:
>
> ```bash
> DATABASE_PATH=~/keen.db npm start
> ```

```bash
npm test          # 97 unit + 29 end-to-end + 13 DOM tests, plus bank verification
npm run test:dom  # loads the real page in a real DOM and fails on any JS error
npm run verify    # check every question and report thin topics
npm run generate  # regenerate the parametric question bank
npm run backup    # verified database snapshot
npm run reset     # wipe and reseed the question bank
```

New here? Read **[START_HERE.md](START_HERE.md)** first.
Putting it online? **[DEPLOY.md](DEPLOY.md)**. Business checklist? **[LAUNCH.md](LAUNCH.md)**.

---

## How the adaptive engine works

Two mechanisms do the real work. Both live in [`lib/adaptive.js`](lib/adaptive.js).

### 1. Per-topic ability ratings (Elo)

Every topic a student touches gets its own rating, starting at 1000. Questions
carry ratings too, derived from difficulty (easy 900, medium 1050, hard 1200).

After each answer the rating moves by how *surprising* the result was:

```
expected = 1 / (1 + 10^((questionRating - ability) / 400))
ability += K * (actual - expected)
```

Beating a hard question moves your rating more than beating an easy one. Missing
an easy question costs more than missing a hard one. This is the same math chess
ratings use.

### 2. Spaced repetition

Each topic carries a review schedule. Answer correctly and the next review is
pushed further out; miss it and the interval resets to zero so the topic comes
straight back.

```
intervals: now -> 10 min -> 1 hr -> 1 day -> 3 days -> 7 days -> 16 days
```

### Putting them together

Question selection scores every candidate topic:

```
priority = (0.15 + weakness + 0.35 * uncertainty) * dueness
```

- **weakness** — `1 - recentAccuracy`, so shaky topics rank higher
- **uncertainty** — decays as attempts accumulate, so the engine keeps sampling
  topics it does not have a confident read on yet
- **dueness** — full weight if the review is due, heavily reduced if not
- brand new topics get a flat exploration bonus so weak spots surface fast

A topic is then chosen by *weighted random* draw rather than always taking the
highest score, which keeps sessions from feeling repetitive. Within that topic,
the engine picks the question whose difficulty sits just above current ability
(target roughly 65-70% success — hard enough to be worth doing, not so hard it
is demoralizing).

---

## Project layout

```
keen/
├── server.js              HTTP server, routing, API endpoints
├── lib/
│   ├── adaptive.js        Elo ratings, spaced repetition, question selection
│   ├── auth.js            scrypt password hashing, sessions, 13+ age gate
│   ├── billing.js         Stripe Checkout + webhooks (demo mode without keys)
│   ├── config.js          all tunable settings and plan rules
│   ├── db.js              SQLite schema
│   ├── groups.js          study groups, invite codes, leaderboard
│   ├── plans.js           plan resolution and daily quota
│   └── questions.js       question loading and strict validation
├── data/questions.*.json  the question bank, one file per subject
├── public/                front end (vanilla JS, no build step)
├── scripts/seed.js        reseed the question bank
└── test/
    ├── run-tests.js       48 unit tests
    └── e2e.js             18 end-to-end tests against a live server
```

---

## Plans

| Plan | Price | What you get |
|---|---|---|
| Free | $0 | 5 questions/day, 1 subject at a time |
| Premium | $8.99/mo | Unlimited questions, every subject, full dashboard |
| Study Group | $6/seat/mo, **3 seat minimum** | Everything in Premium for every member, plus shared leaderboard |

The 3-seat minimum is deliberate. Getting two friends to join is a far smaller
ask than organising five people, and one person paying upgrades the whole group,
which turns the pricing page into a referral loop. The minimum is enforced
server-side in `lib/groups.js`, not just hidden in the UI.

---

## Question bank

**1,026 questions** across five subjects, balanced so no subject runs dry:

| Subject | Questions |
|---|---|
| Math | 319 |
| Science | 220 |
| English | 214 |
| Coding | 145 |
| Test Strategy | 128 |

Most are produced by **parametric generators** in `scripts/lib/templates-*.js`.
The generator computes each answer from the same parameters it used to build the
prompt, so a typo'd answer key is structurally impossible. Distractors are
modelled on real mistakes (dropping a negative, forgetting to divide, stopping
one step early) rather than random numbers, because a distractor nobody would
pick teaches nothing.

`npm run verify` then re-derives every computable answer using **separately
written parsing logic**. That matters: if a generator had a formula backwards it
would agree with itself, and only an independent check catches it. Roughly a
third of the bank is verified this way; the rest are conceptual questions with
no formula to recheck, and the verifier reports that coverage honestly rather
than implying everything was proven.

The verifier also flags **thin topics** (under 5 questions), because the adaptive
engine keeps returning to weak topics and a topic with two questions just gets
memorised.

Topics covered:

| Subject | Topics covered |
|---|---|
| Math | Linear equations, quadratics, systems, exponents, triangles, circles, functions, ratios, percentages, statistics |
| English | Subject-verb agreement, pronouns, commas, modifiers, parallel structure, apostrophes, word choice, transitions, semicolons, verb tense |
| Coding | Big-O, arrays and hashing, two pointers, recursion, strings, stacks and queues, binary search, sorting |
| Science | Cell biology, genetics, chemical bonding, stoichiometry, periodic trends, Newton's laws, energy, waves, states of matter |
| Test Strategy | Process of elimination, trap answers, time management, triage, backsolving, estimation, data interpretation |

Every question is original, written for this project. Problem *patterns* are not
copyrightable, but the specific wording of published questions is, so nothing
here is copied from LeetCode, College Board, or any other bank.

### Adding questions

Drop a new object into any `data/questions.*.json` file, or create a new
`questions.<subject>.json`:

```json
{
  "id": "math-lin-005",
  "subject": "Math",
  "topic": "Linear Equations",
  "difficulty": "medium",
  "prompt": "Solve for x:  4x - 9 = 11",
  "choices": ["5", "4", "6", "-5"],
  "answer": 0,
  "explanation": "Add 9 to both sides: 4x = 20. Divide by 4: x = 5."
}
```

Then run `npm run reset`. Validation is strict and will refuse to load the bank
if any id is duplicated, any answer index is out of range, or any choice is
blank. A question bank with a wrong answer key silently teaches students the
wrong thing, which is the worst failure this product could have.

---

## Going live with payments

The app runs fine forever in demo mode. To take real money:

1. Copy `.env.example` to `.env`.
2. Create a Stripe account and add `STRIPE_SECRET_KEY`.
3. Create two recurring prices in the Stripe dashboard ($8.99/mo and $6/mo) and
   put their price IDs in `STRIPE_PRICE_PREMIUM_MONTHLY` and
   `STRIPE_PRICE_GROUP_SEAT_MONTHLY`.
4. Add a webhook endpoint pointing at `https://yourdomain.com/api/webhooks/stripe`
   for `checkout.session.completed` and `customer.subscription.deleted`, then put
   the signing secret in `STRIPE_WEBHOOK_SECRET`.
5. Set `SESSION_SECRET` to a real random value and `PUBLIC_URL` to your domain.

Restart, and the startup banner will read `Billing mode: LIVE`.

> **If you are under 18:** Stripe requires an adult to own the account that
> receives payouts. A parent or guardian must be the account holder. Recurring
> subscription revenue also raises sales-tax questions in several US states, so
> configure Stripe Tax and talk to an actual tax preparer before going live.

---

## Security notes

- Passwords are hashed with **scrypt** and a per-user random salt, compared in
  constant time.
- Sessions are random 256-bit tokens in `HttpOnly`, `SameSite=Lax` cookies, and
  `Secure` is added automatically when `PUBLIC_URL` is https. Expired sessions
  are purged hourly.
- Answer keys never reach the browser. Grading happens server-side only, and an
  answer must match the question the server actually issued, so ability ratings
  cannot be farmed by replaying an easy question.
- **Rate limiting** on login (10 per 15 min per IP) and signup (5 per hour),
  plus a general write ceiling. Brute-forcing scrypt is expensive for the server
  too, so unlimited attempts would be a cheap denial of service.
- **CSRF**: `SameSite=Lax` cookies plus an explicit same-origin check on every
  state-changing request. The Stripe webhook is exempt and authenticated by
  signature instead.
- **Security headers** on every response: a strict CSP with no inline scripts
  and no external origins, `X-Frame-Options: DENY`, `nosniff`,
  `Referrer-Policy: same-origin`.
- Stripe webhook signatures are verified with HMAC-SHA256, including a timestamp
  tolerance to reject replayed events.
- Static file serving is guarded against path traversal.
- Accounts are **13+**, enforced at signup. Under COPPA, collecting personal
  information from children under 13 requires verifiable parental consent, so
  the age gate keeps that obligation out of scope.

Still missing before a public launch: email verification, password reset,
account deletion, error monitoring, and database backups. See
[LAUNCH.md](LAUNCH.md) for the full gap list with priorities.

---

## Deploying

Any host that runs Node 22.5+ with a persistent disk works. The SQLite file
lives at `data/keen.db`.

```bash
PORT=8080 SESSION_SECRET=$(openssl rand -hex 32) PUBLIC_URL=https://yourdomain.com npm start
```

Note that fully serverless platforms (default Vercel/Netlify functions) do not
keep a writable disk between requests, so SQLite will not persist there. Use a
host with a real volume (Fly.io, Railway, Render, a VPS), or swap `lib/db.js`
for Postgres.

---

## License

MIT. See [LICENSE](LICENSE).
