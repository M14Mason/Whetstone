# Launching Keen to your school

Everything here is a command you paste into Terminal. Each one is safe to run
twice. If a step prints something that is not in the "you should see" line,
stop there rather than carrying on.

---

## 1. Ship the code that is sitting on your Mac

```
cd ~/Desktop/Whetstone
fly deploy
```

Takes 3-6 minutes. **You should see:** `1 desired, 1 placed, 1 healthy` at the
end. If it stops on `Error`, copy the last 20 lines and send them to me.

Then put the code on GitHub so it is backed up somewhere other than this
laptop:

```
git push origin main
```

---

## 2. Check the four settings that decide whether launch day works

```
fly secrets list
```

**You should see all four of these names** (values are hidden, that is normal):

| Name | Why it matters |
|---|---|
| `SESSION_SECRET` | Without it, anyone who reads the source can sign in as anyone. |
| `RESEND_API_KEY` | Without it, nobody can confirm their email or reset a password. |
| `PUBLIC_URL` | Must be `https://keenlearning.org`, or links in emails point at the wrong place. |
| `DATABASE_PATH` | Must be on the `/data` volume, or every deploy wipes all your users. |

If `PUBLIC_URL` or `DATABASE_PATH` is missing:

```
fly secrets set PUBLIC_URL="https://keenlearning.org" DATABASE_PATH="/data/keen.db"
```

If `SESSION_SECRET` is missing, generate one (this prints a fresh random value
and sets it in one go; nobody needs to see it, including me):

```
fly secrets set SESSION_SECRET="$(openssl rand -hex 32)"
```

Setting a secret restarts the app. That is expected.

---

## 3. Turn on your metrics page

The dashboard is at **https://keenlearning.org/admin** and only you can open
it. It is tied to the account whose email is `masonngo70@gmail.com`.

1. Sign up at keenlearning.org with `masonngo70@gmail.com` if you have not.
2. Open the confirmation email and click the link. **This step is required** -
   an unconfirmed account cannot open the dashboard, on purpose.
3. Go to https://keenlearning.org/admin

Anyone else who visits that address gets a plain 404. They cannot tell the
page exists.

### What is on it

- **Retest recovery** - of the questions students got wrong, how many they
  later got right. This is your project's headline number.
- **Where people drop out** - each row is a subset of the one above. The
  biggest gap between two rows is the thing to fix next.
- **Signups per day** - the day a teacher announces it should be a visible
  spike. If it is flat, the announcement did not land.
- **Questions students flagged** - anything reported twice is teaching people
  the wrong answer. Fix those first.

---

## 4. The decision to make before Tuesday: payments

Right now the app can take real money from 14-year-olds. For a survey project,
that is risk with no upside: one parent ringing the school about a $4.99
charge is a bigger problem than any revenue you would make.

**My recommendation: turn payments off for launch week.**

```
fly secrets unset STRIPE_SECRET_KEY
```

What that changes: the Upgrade button still works, but it grants Premium free
and charges nobody. Every student gets full access, which is better for your
data anyway - nobody hits a paywall halfway through and quits, so your retest
numbers measure learning instead of measuring the free limit.

To turn payments back on afterwards, set the key again. Ask your dad first,
since it is his Stripe account.

---

## 5. Test it yourself before anyone else does

On your phone, on cellular data, not the school wifi:

1. Sign up with an address you have not used.
2. Confirm the email. **Did it arrive within a minute?** If not, stop and tell
   me - this is the single most common launch failure.
3. Pick classes, answer 10 questions.
4. Deliberately get one wrong, then tap **Report this question** and send one.
5. Open /admin on your laptop. Your signup, your 10 answers and your report
   should all be there.

If all five work, the app is ready for other people.

---

## 6. What to say to teachers

Keep it to three sentences, because that is what a teacher will read:

> I built a study app for a school project and I need real students to try it
> so I have data to analyse. It is free, it takes five minutes, and it works
> on a phone: keenlearning.org. Could you share the link with your class?

Ask on **Monday**, not Tuesday morning. A teacher who is asked during first
period will forget by third.

---

## Known gaps, so nothing surprises you

- **18 classes still have no questions.** Mostly AP languages, AP art, AP
  English and AP Seminar. They are marked "Questions coming soon" in the
  picker and cannot be added, so nobody lands in an empty class.
- **Every question is multiple choice.** Other formats are not built yet.
- **About 220 questions have explanations too short to teach anything.** They
  are not wrong, just thin. `npm run verify` lists them.
- **Android is untested.** The layout is responsive and should be fine, but
  nobody has opened it on an Android phone.
