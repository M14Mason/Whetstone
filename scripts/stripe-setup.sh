#!/bin/bash
#
# Connect Stripe to Keen, without hunting for price IDs in the dashboard.
#
#   bash scripts/stripe-setup.sh
#
# You paste ONE thing: your Stripe secret key. Everything else is read from
# your Stripe account over the API:
#
#   - finds the three prices by amount and interval, or offers to create them
#   - creates the webhook endpoint and captures its signing secret
#   - pushes all five values to Fly
#
# Nothing is echoed to the screen, written to a file, or left in your shell
# history. A live secret key is enough to issue refunds and read customer
# details, so it is treated like a bank password.

set -u
export PATH="$HOME/.fly/bin:$PATH"

cd "$(dirname "$0")/.." || exit 1

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mno\033[0m   %s\n' "$*"; }
info() { printf '       %s\n' "$*"; }
die()  { printf '\n\033[31mSTOPPED\033[0m %s\n\n' "$*"; exit 1; }

# What we are looking for. Amounts are in cents and must match lib/config.js.
WANT_MONTHLY_AMOUNT=499
WANT_ANNUAL_AMOUNT=2999
WANT_SEAT_AMOUNT=399

# ------------------------------------------------------------------ app name
APP="${1:-}"
if [ -z "$APP" ] && [ -f fly.toml ]; then
  APP=$(grep -m1 '^app = ' fly.toml | sed 's/app = "\(.*\)"/\1/')
fi
[ -n "$APP" ] || die "Could not work out your Fly app name.
  Run:  fly apps list
  Then: bash scripts/stripe-setup.sh <that-name>"

command -v fly >/dev/null 2>&1 || die "The Fly CLI is not installed."
fly status --app "$APP" >/dev/null 2>&1 \
  || die "Fly does not know about an app called \"$APP\".
  Run 'fly apps list' and pass the right one, or run scripts/fly-setup.sh first."

ok "Fly app: $APP"

# ------------------------------------------------------------------- the key
cat <<'INTRO'

────────────────────────────────────────────────────────────
  Connecting Stripe
────────────────────────────────────────────────────────────

You need one thing: your Stripe SECRET KEY.

Where to find it, exactly:

  1. Go to  https://dashboard.stripe.com/apikeys
  2. Make sure the "Test mode" toggle at the TOP RIGHT is OFF
  3. Find the row called "Secret key"
  4. Click "Reveal live key" and copy it

It starts with sk_live_ and is long. Nothing you paste will appear on screen.

INTRO

printf '  Paste your Stripe secret key: '
read -r -s SK
echo

[ -n "$SK" ] || die "Nothing pasted."
case "$SK" in
  sk_live_*) ok "live key" ;;
  sk_test_*) ok "TEST key. Fine for a rehearsal, but real cards will not work." ;;
  pk_*) die "That is a PUBLISHABLE key (pk_). You want the SECRET key (sk_)." ;;
  rk_*) die "That is a restricted key (rk_). Use the full secret key (sk_)." ;;
  *) die "That does not look like a Stripe secret key. It should start with sk_" ;;
esac

# One small helper so every API call is identical. --fail-with-body keeps the
# error JSON so we can show Stripe's own message rather than a bare exit code.
api() {
  local method="$1" path="$2"; shift 2
  curl -s -X "$method" "https://api.stripe.com/v1/$path" -u "$SK:" "$@"
}

say "Checking the key works"
ACCT=$(api GET account)
if printf '%s' "$ACCT" | grep -q '"error"'; then
  bad "Stripe rejected the key:"
  printf '%s' "$ACCT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log('       '+JSON.parse(d).error.message)}catch{console.log(d)}})"
  exit 1
fi
BIZ=$(printf '%s' "$ACCT" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const a=JSON.parse(d);console.log(a.business_profile&&a.business_profile.name||a.settings&&a.settings.dashboard&&a.settings.dashboard.display_name||a.id)})")
ok "connected to Stripe account: $BIZ"

# --------------------------------------------------------------- find prices
say "Looking for your prices"

PRICES=$(api GET "prices?limit=100&active=true&expand[]=data.product")

# Match on amount + interval, which is what actually identifies the product.
# Matching on the product NAME would break the moment you rename anything.
match() {
  printf '%s' "$PRICES" | node -e "
    let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      const amount=Number(process.argv[1]), interval=process.argv[2];
      let list=[];
      try { list=(JSON.parse(d).data)||[]; } catch { }
      const hit=list.find(p =>
        p.unit_amount===amount &&
        p.recurring && p.recurring.interval===interval &&
        p.currency==='usd');
      process.stdout.write(hit ? hit.id : '');
    });
  " "$1" "$2"
}

PM=$(match "$WANT_MONTHLY_AMOUNT" month)
PA=$(match "$WANT_ANNUAL_AMOUNT" year)
PG=$(match "$WANT_SEAT_AMOUNT" month)

# The monthly premium and the seat price are both $-something per month, so if
# only one of them exists the matcher could pick the wrong one. Guard against
# them resolving to the same price.
if [ -n "$PM" ] && [ "$PM" = "$PG" ]; then PG=""; fi

report() { if [ -n "$2" ]; then ok "$1 -> $2"; else bad "$1 -> not found"; fi; }
report "Premium monthly  \$4.99/mo " "$PM"
report "Premium annual   \$29.99/yr" "$PA"
report "Group seat       \$3.99/mo " "$PG"

# ------------------------------------------------------------- create missing
if [ -z "$PM" ] || [ -z "$PA" ] || [ -z "$PG" ]; then
  say "Some prices do not exist yet"
  info "I can create the missing ones in your Stripe account now, with the"
  info "exact amounts your app and your Terms already advertise."
  echo
  printf '  Create them? [y/N] '
  read -r MAKE
  case "$MAKE" in
    [yY]*) ;;
    *) die "Nothing changed. Create them yourself at
  https://dashboard.stripe.com/products
then run this script again." ;;
  esac

  # Creates a product and its recurring price, returns the price id.
  mkprice() {
    local name="$1" amount="$2" interval="$3"
    local prod
    prod=$(api POST products -d "name=$name" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.id||'')})")
    [ -n "$prod" ] || return 1
    api POST prices \
      -d "product=$prod" \
      -d "unit_amount=$amount" \
      -d "currency=usd" \
      -d "recurring[interval]=$interval" \
      | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);process.stdout.write(j.id||'')})"
  }

  if [ -z "$PM" ]; then
    PM=$(mkprice "Keen Premium Monthly" "$WANT_MONTHLY_AMOUNT" month)
    [ -n "$PM" ] && ok "created Premium monthly -> $PM" || die "Could not create the monthly price."
  fi
  if [ -z "$PA" ]; then
    PA=$(mkprice "Keen Premium Annual" "$WANT_ANNUAL_AMOUNT" year)
    [ -n "$PA" ] && ok "created Premium annual -> $PA" || die "Could not create the annual price."
  fi
  if [ -z "$PG" ]; then
    PG=$(mkprice "Keen Study Group Seat" "$WANT_SEAT_AMOUNT" month)
    [ -n "$PG" ] && ok "created Group seat -> $PG" || die "Could not create the seat price."
  fi
fi

# ----------------------------------------------------------------- webhook
say "Setting up the webhook"
info "This is the part that turns a payment into an unlocked account."
info "Without it Stripe takes the money and never tells your server."

HOOK_URL="https://$APP.fly.dev/api/webhooks/stripe"

# Reuse an existing endpoint for this URL rather than stacking duplicates.
# Stripe only returns a signing secret at creation time, so if one already
# exists we have to replace it to learn its secret.
EXISTING=$(api GET "webhook_endpoints?limit=100" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{
      let l=[];try{l=JSON.parse(d).data||[]}catch{}
      const hit=l.find(w=>w.url===process.argv[1]);
      process.stdout.write(hit?hit.id:'');
    })" "$HOOK_URL")

if [ -n "$EXISTING" ]; then
  info "an endpoint for this URL already exists; replacing it so we can read"
  info "its signing secret (Stripe only reveals that once, at creation)"
  api POST "webhook_endpoints/$EXISTING" -d "disabled=true" >/dev/null
  api DELETE "webhook_endpoints/$EXISTING" >/dev/null
fi

HOOK=$(api POST webhook_endpoints \
  -d "url=$HOOK_URL" \
  -d "enabled_events[]=checkout.session.completed" \
  -d "enabled_events[]=customer.subscription.updated" \
  -d "enabled_events[]=customer.subscription.deleted" \
  -d "description=Keen production")

WH=$(printf '%s' "$HOOK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{process.stdout.write(JSON.parse(d).secret||'')}catch{}})")

if [ -z "$WH" ]; then
  bad "Could not create the webhook. Stripe said:"
  printf '%s' "$HOOK" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log('       '+JSON.parse(d).error.message)}catch{console.log(d)}})"
  exit 1
fi
ok "webhook created at $HOOK_URL"

# -------------------------------------------------------------------- apply
say "Sending everything to Fly"

if fly secrets set \
    STRIPE_SECRET_KEY="$SK" \
    STRIPE_PRICE_PREMIUM_MONTHLY="$PM" \
    STRIPE_PRICE_PREMIUM_ANNUAL="$PA" \
    STRIPE_PRICE_GROUP_SEAT_MONTHLY="$PG" \
    STRIPE_WEBHOOK_SECRET="$WH" \
    --app "$APP" >/dev/null 2>&1; then
  ok "all five secrets set"
else
  bad "Could not set the secrets on Fly."
  exit 1
fi

unset SK PM PA PG WH

say "Waiting for the redeploy"
info "setting secrets restarts the app automatically"
sleep 45

HEALTH=$(curl -s -m 25 "https://$APP.fly.dev/api/health")
say "Result"
if printf '%s' "$HEALTH" | grep -q '"billingMode":"live"'; then
  ok "billing is LIVE"
else
  bad "still reporting demo mode. Give it another minute, then:"
  info "curl https://$APP.fly.dev/api/health"
fi

cat <<EOF

────────────────────────────────────────────────────────────
  One thing left before you advertise the price
────────────────────────────────────────────────────────────

Put ONE REAL CARD through it. Not a test card.

  1. Open https://$APP.fly.dev and upgrade to Premium with a real card
  2. Check the charge appears at https://dashboard.stripe.com/payments
  3. Check the app actually unlocks Match, Test and AP exam practice
  4. Refund yourself at that same payments page

Step 3 is the one that matters. Test mode does not exercise the production
webhook, and the webhook is what converts a payment into an unlocked account.
If the charge lands but the app stays locked, stop selling and tell me.

EOF
