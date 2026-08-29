# Pushing Keen to GitHub

The repository is already initialised with a full commit. It just needs a remote.

I could not create the GitHub repo myself: doing that requires signing in to your
GitHub account, and I have no access to your credentials. Below is everything
that is left, and it takes about two minutes.

---

## Option A — GitHub website (no tools to install)

1. Go to <https://github.com/new>
2. Repository name: `keen`
3. Leave **"Add a README"**, **"Add .gitignore"**, and **"Choose a license"**
   all UNCHECKED. The repo already has them, and checking them causes a conflict
   on first push.
4. Click **Create repository**.
5. Copy the URL GitHub shows you, then run this in the `keen` folder:

```bash
git remote add origin https://github.com/YOUR-USERNAME/keen.git
git branch -M main
git push -u origin main
```

GitHub will ask you to sign in. Use a **personal access token** as the password,
not your account password (GitHub stopped accepting passwords over HTTPS in
2021). Create one at <https://github.com/settings/tokens> with the `repo` scope.

---

## Option B — GitHub CLI (faster if you have it)

```bash
# one-time install: https://cli.github.com
gh auth login
cd keen
gh repo create keen --public --source=. --remote=origin --push
```

That creates the repo and pushes in a single command.

---

## Verifying it worked

```bash
git remote -v     # should show your origin URL
git log --oneline # should show the initial commit
```

Then refresh the GitHub page. You should see the README rendered on the
repository home page.

---

## Should it be public or private?

**Public** if you want it as a portfolio piece. Anyone can read the code, which
is the point of showing your work, and it costs nothing.

**Private** if you plan to actually sell subscriptions and would rather not hand
competitors the adaptive engine. You can flip a repo from private to public later
at any time; going the other direction is also possible but any forks made while
it was public stay public.

Either way: **never commit your `.env` file.** It is already in `.gitignore`, so
as long as you do not force-add it you are fine. If a Stripe secret key ever does
get committed, rotate it immediately in the Stripe dashboard. Anything pushed to
a public repo should be treated as permanently compromised, even after deletion,
because it lives in the git history and in GitHub's caches.
