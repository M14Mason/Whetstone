# Start here

Read this first. It gets Keen running on your Mac in about two minutes,
then tells you exactly what to do next.

---

## Step 1: check you have the right Node version

```bash
node --version
```

You need **v22.5.0 or higher**. Keen uses Node's built-in SQLite, which
older versions do not have.

If the version is lower, or the command is not found, download the **LTS**
installer from <https://nodejs.org>, run it, then close and reopen Terminal and
check again.

## Step 2: run it

You are reading this file, so you already found and unzipped the project. Open
Terminal, then:

```bash
cd ~/Downloads/keen
npm start
```

Adjust the path if you unzipped somewhere else. Drag the `keen` folder onto
the Terminal window after typing `cd ` and it will fill in the path for you.

You should see:

```
  Keen running at http://localhost:3000
  Questions loaded: 1026
  Billing mode: DEMO (no payments taken)
```

Open <http://localhost:3000> in your browser.

### If you get `disk I/O error`

Your folder is in iCloud, Dropbox, or another synced location, and SQLite cannot
run there. Put the database somewhere local instead:

```bash
DATABASE_PATH=~/keen.db npm start
```

### If you get `command not found: npm`

Node is not installed. Go back to step 1.

### To stop the server

Press `Control` + `C` in the Terminal window.

---

## Step 3: try the thing that makes it worth building

Do this in order. It takes five minutes and shows you the adaptive engine
actually working, which is the whole product.

1. **Create an account.** Any email works, nothing is sent. Password needs 8+
   characters. Birth year must make you 13 or older.
2. Go to the **Plan** tab and click **Upgrade**. This is demo mode, so no card
   is involved and nothing is charged.
3. Select all five subjects and click **Save subjects**.
4. Go to **Practice** and answer about 20 questions. **Deliberately get every
   Geometry (or any one topic) question wrong.** Press `1`-`4` to answer and
   `Enter` for the next one.
5. Go to **Progress**.

That topic will be sitting at the top of "Your weak spots", and you will notice
it coming back far more often than everything else. That is the engine doing its
job: it found the gap and started drilling it.

Then try the group feature: **Group** tab, create a group, and note the invite
code. You will need two friends to unlock it, which is exactly the point.

---

## Step 4: what to do next, in order

Do not skip ahead. Each step is cheap and de-risks the next one.

| # | What | Who | Guide |
|---|---|---|---|
| 1 | **Revoke that GitHub token** you pasted in chat | You | Below |
| 2 | Push the code to GitHub | You | `PUSH_TO_GITHUB.md` |
| 3 | Deploy to Fly.io with payments OFF | You | `DEPLOY.md` |
| 4 | Get 5-10 friends actually using it | You | — |
| 5 | Fill in the legal templates | You + an adult | `legal/` |
| 6 | Turn on Stripe and charge money | Parent | `LAUNCH.md` §2.5 |

**Step 1 is not optional and takes 30 seconds.** Go to
<https://github.com/settings/tokens> and delete the token you pasted. A token
with `repo` scope can read and write every repository on your account, and it is
permanently in a chat log now. Then use `gh auth login` instead, which stores
credentials in your Mac's keychain where they cannot be copy-pasted by accident.

---

## What is in this folder

| File | What it is |
|---|---|
| `START_HERE.md` | This file |
| `README.md` | How the app works, how the adaptive engine works |
| `PUSH_TO_GITHUB.md` | Getting the code onto GitHub |
| `DEPLOY.md` | Putting it online at a real URL |
| `LAUNCH.md` | Business checklist, known gaps, payments |
| `legal/` | Terms of Service and Privacy Policy drafts |
| `lib/` | The actual application code |
| `data/` | 1,026 questions across five subjects |
| `scripts/` | Question generator, verifier, backups |
| `test/` | 106 automated tests |

---

## Useful commands

```bash
npm start          # run the app
npm test           # run all 106 tests plus question-bank verification
npm run verify     # check every question for errors and thin topics
npm run generate   # regenerate the parametric questions
npm run backup     # take a verified database snapshot
npm run reset      # wipe and reload the question bank
```

---

## Honest status

**What works:** accounts, the adaptive engine, study groups, subscription
plans, password reset, email verification, 1,026 verified questions. All 106
tests pass.

**What is simulated until you configure it:** payments run in demo mode with no
Stripe key, and emails print to the terminal with no email provider key. Both
are one environment variable away from being real.

**What does not exist yet:** account deletion in the UI, and a way for you to
see how people are using the app beyond the health endpoint.

**The real blocker on charging money is not the code.** It is that nobody has
used this yet. Get it in front of ten people and fix what they complain about
before you ask anyone for $8.99.
