#!/bin/bash
#
# Connect Stripe to Keen.
#
#   bash scripts/stripe-setup.sh <your-fly-app-name>
#
# This prompts you for each value and pipes it straight to Fly. Nothing is
# echoed to the screen, nothing is written to a file, and nothing lands in your
# shell history, which is what would happen if you typed the keys onto a
# command line instead.
#
# A live Stripe secret key is enough for someone to issue refunds and read your
# customers' details. Treat it like a bank password.

set -u
export PATH="$HOME/.fly/bin:$PATH"

APP="${1:-}"
if [ -z "$APP" ]; then
  echo "Usage: bash scripts/stripe-setup.sh <your-fly-app-name>"
  echo "Find it with:  fly apps list"
  exit 1
fi

cd "$(dirname "$0")/.." || exit 1

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mno\033[0m   %s\n' "$*"; }

cat <<'INTRO'

────────────────────────────────────────────────────────────
  Connecting Stripe
────────────────────────────────────────────────────────────

Before you start, have the Stripe dashboard open with three products created:

    Keen Premium Monthly      $4.99   recurring, monthly
    Keen Premium Annual      $29.99   recurring, yearly
    Keen Study Group Seat     $3.99   recurring, monthly

You need the PRICE id from each, not the product id.

    price_xxxx   correct
    prod_xxxx    wrong, and gives you a checkout page that will not load

Click a product, scroll to Pricing, and copy the id under the amount.

Nothing you type below will be shown on screen.

INTRO

read -r -p "Ready? [y/N] " GO
case "$GO" in [yY]*) ;; *) echo "Nothing changed."; exit 0 ;; esac

# ------------------------------------------------------------------ collect
# -s hides the input. Each value is validated for its expected prefix, because
# pasting a product id where a price id belongs is the most common mistake here
# and it fails silently at checkout rather than at setup.
ask() {
  local var="$1" label="$2" prefix="$3" value=""
  while true; do
    printf '\n  %s\n  ' "$label"
    read -r -s value
    echo
    if [ -z "$value" ]; then bad "empty, try again"; continue; fi
    case "$value" in
      "$prefix"*) ok "looks right (starts with $prefix)"; break ;;
      prod_*) bad "that is a PRODUCT id. You want the PRICE id, starting with $prefix" ;;
      *) bad "expected it to start with $prefix" ;;
    esac
  done
  printf -v "$var" '%s' "$value"
}

say "Step 1 of 5: the secret key"
echo "  Stripe: Developers -> API keys -> Secret key -> Reveal"
ask SK "Paste your LIVE secret key:" "sk_live_"

say "Step 2 of 5: monthly price"
ask PM "Paste the price id for Premium Monthly (\$4.99):" "price_"

say "Step 3 of 5: annual price"
ask PA "Paste the price id for Premium Annual (\$29.99):" "price_"

say "Step 4 of 5: group seat price"
ask PG "Paste the price id for Study Group Seat (\$3.99):" "price_"

cat <<EOF

  Step 5 of 5: the webhook

  In Stripe: Developers -> Webhooks -> Add endpoint

    Endpoint URL:
      https://$APP.fly.dev/api/webhooks/stripe

    Events to send:
      checkout.session.completed
      customer.subscription.updated
      customer.subscription.deleted

  Then click "Reveal" under Signing secret.

  This one matters more than it looks. Without it Stripe takes the payment and
  never tells your server, so the student is charged and stays on the free plan.

EOF

ask WH "Paste the webhook signing secret:" "whsec_"

# ------------------------------------------------------------------- apply
say "Sending to Fly"

if fly secrets set \
    STRIPE_SECRET_KEY="$SK" \
    STRIPE_PRICE_PREMIUM_MONTHLY="$PM" \
    STRIPE_PRICE_PREMIUM_ANNUAL="$PA" \
    STRIPE_PRICE_GROUP_SEAT_MONTHLY="$PG" \
    STRIPE_WEBHOOK_SECRET="$WH" \
    --app "$APP" >/dev/null 2>&1; then
  ok "all five secrets set"
else
  bad "could not set secrets. Is the app name right?  fly apps list"
  exit 1
fi

# Clear them from this shell immediately.
unset SK PM PA PG WH

say "Waiting for the redeploy"
echo "  Setting secrets restarts the app automatically."
sleep 40

HEALTH=$(curl -s -m 25 "https://$APP.fly.dev/api/health")
say "Result"
if printf '%s' "$HEALTH" | grep -q '"billingMode":"live"'; then
  ok "billing is LIVE"
else
  bad "billing still reports demo mode"
  printf '  %s\n' "$HEALTH"
  echo "  Wait another minute and check again:"
  echo "    curl https://$APP.fly.dev/api/health"
fi

cat <<EOF

────────────────────────────────────────────────────────────
  Before you tell anyone the price
────────────────────────────────────────────────────────────

Put ONE REAL CARD through it. Not a test card.

  1. Open https://$APP.fly.dev and upgrade to Premium with a real card.
  2. Confirm the charge appears in the Stripe dashboard.
  3. Confirm the app actually unlocks Match, Test and AP exam practice.
  4. Refund yourself in Stripe.

Test mode does not prove the webhook works in production, and the webhook is
the part that turns a payment into an unlocked account. If step 3 fails, the
webhook is misconfigured and every customer will be charged for nothing.

EOF
