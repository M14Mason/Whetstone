#!/bin/bash
#
# One-shot Fly.io setup for Keen.
#
# Everything that can be automated is automated. Run this once, after you have
# added a payment method to Fly. It is safe to run again if it fails part way
# through: every step checks whether it has already been done.
#
#   bash scripts/fly-setup.sh
#
# It does NOT touch Stripe. Payment keys are yours to paste, and they should go
# straight from the Stripe dashboard into your terminal without passing through
# anything else. scripts/stripe-setup.sh handles that separately.

set -u   # not -e; we want to handle failures with our own messages

export PATH="$HOME/.fly/bin:$PATH"

# Candidate names, tried in order. Fly app names are globally unique across all
# of Fly's customers, so the first few are likely taken by strangers.
CANDIDATES=(keen-study keen-app keen-hq getkeen keen-learn keen-revise keen-io-app)
REGION="sjc"          # San Jose, nearest to California
VOLUME="keen_data"    # MUST match [[mounts]] source in fly.toml
SIZE_GB=1

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31mSTOPPED\033[0m %s\n\n' "$*"; exit 1; }

cd "$(dirname "$0")/.." || die "could not find the project folder"

# ---------------------------------------------------------------- 0. checks
say "Checking Fly"

command -v fly >/dev/null 2>&1 || die "The Fly CLI is not installed. Run:
  curl -L https://fly.io/install.sh | sh
then open a NEW terminal and run this script again."

WHO=$(fly auth whoami 2>&1)
case "$WHO" in
  *@*) ok "signed in as $WHO" ;;
  *)   die "You are not signed in to Fly. Run:  fly auth login" ;;
esac

# ------------------------------------------------------- 1. find or make app
say "Finding or creating the app"

APP=""
# Reuse an app from a previous run rather than creating a second one.
EXISTING=$(fly apps list 2>/dev/null | awk 'NR>1 {print $1}')
for c in "${CANDIDATES[@]}"; do
  if printf '%s\n' $EXISTING | grep -qx "$c"; then APP="$c"; ok "reusing existing app $APP"; break; fi
done

if [ -z "$APP" ]; then
  for c in "${CANDIDATES[@]}"; do
    OUT=$(fly apps create "$c" --org personal 2>&1)
    if printf '%s' "$OUT" | grep -qi "payment information"; then
      die "Fly needs a payment method before it will create anything.

  Add a card here:
    https://fly.io/dashboard/masonngo70-gmail-com/billing

  This should be Tom Ngo's card, for the same reason the Stripe account has to
  be his. Expect about \$3/month.

  Then run this script again. Nothing else is needed from you."
    fi
    if printf '%s' "$OUT" | grep -qi "already been taken\|not available"; then
      warn "$c is taken, trying the next name"
      continue
    fi
    APP="$c"; ok "created $APP"; break
  done
fi

[ -n "$APP" ] || die "Every candidate name was taken. Open scripts/fly-setup.sh and add more names to CANDIDATES."

# ------------------------------------------------- 2. write the name into fly.toml
say "Pointing fly.toml at $APP"

# If this line is wrong, every later deploy targets the wrong app or fails.
if grep -q "^app = \"$APP\"$" fly.toml; then
  ok "fly.toml already says $APP"
else
  # BSD sed (macOS) needs the empty string after -i.
  sed -i '' "s/^app = .*/app = \"$APP\"/" fly.toml
  ok "fly.toml updated"
fi

# ------------------------------------------------------------ 3. the volume
say "Creating the persistent volume"

# This is the step that fixes vanishing accounts. Without it the database lives
# in the container filesystem and is destroyed on every single deploy.
if fly volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  ok "volume $VOLUME already exists"
else
  if fly volumes create "$VOLUME" --size "$SIZE_GB" --region "$REGION" --app "$APP" --yes >/dev/null 2>&1; then
    ok "created $VOLUME (${SIZE_GB}GB, $REGION)"
  else
    die "Could not create the volume. Run this to see why:
  fly volumes create $VOLUME --size $SIZE_GB --region $REGION --app $APP"
  fi
fi

# ----------------------------------------------------------- 4. the secrets
say "Setting secrets"

CURRENT=$(fly secrets list --app "$APP" 2>/dev/null)

if printf '%s' "$CURRENT" | grep -q "SESSION_SECRET"; then
  ok "SESSION_SECRET already set"
else
  # Generated and consumed in one pipeline. The value is never printed, never
  # written to a file, and never enters your shell history.
  if fly secrets set \
      SESSION_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("hex"))')" \
      --app "$APP" --stage >/dev/null 2>&1; then
    ok "SESSION_SECRET generated and set"
  else
    die "Could not set SESSION_SECRET."
  fi
fi

if fly secrets set PUBLIC_URL="https://$APP.fly.dev" --app "$APP" --stage >/dev/null 2>&1; then
  ok "PUBLIC_URL set to https://$APP.fly.dev"
fi

# ------------------------------------------------------------- 5. deploy
say "Deploying (3 to 6 minutes the first time)"
echo "  The question bank is baked into the image at build time, which is why"
echo "  this is slow once and fast afterwards."
echo

if fly deploy --app "$APP"; then
  ok "deployed"
else
  die "Deploy failed. Look at the last 30 lines of:
  fly logs --app $APP"
fi

# -------------------------------------------------------------- 6. verify
say "Checking it is actually up"

sleep 8
HEALTH=$(curl -s -m 20 "https://$APP.fly.dev/api/health")
if printf '%s' "$HEALTH" | grep -q '"status":"ok"'; then
  ok "health check passed"
  printf '  %s\n' "$HEALTH"
else
  warn "health check did not return ok. It may still be starting."
  warn "check with:  fly logs --app $APP"
fi

# ---------------------------------------------------------------- 7. done
cat <<EOF

────────────────────────────────────────────────────────────
  Keen is live at  https://$APP.fly.dev
────────────────────────────────────────────────────────────

Two things left, in this order.

1. PROVE THE DATABASE SURVIVES.  This is the whole reason for the move.

     Open the site, make an account, add a class. Then:

       fly apps restart $APP

     Wait 30 seconds and reload. You should still be signed in with your
     class still there. If you are signed out, stop and tell me.

2. EMAIL.  Password resets currently only print to the server log, so anyone
   who forgets their password is locked out for good.

     Sign up at resend.com, verify a domain you own, create an API key, then:

       fly secrets set RESEND_API_KEY=re_your_key --app $APP
       fly secrets set MAIL_FROM="Keen <noreply@yourdomain.com>" --app $APP

Stripe is separate and deliberately not automated:

     bash scripts/stripe-setup.sh $APP

Everyday commands:

     fly logs --app $APP        what is happening right now
     fly status --app $APP      is it up
     fly deploy --app $APP      ship your latest commit

EOF
