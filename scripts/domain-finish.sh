#!/bin/bash
#
# Finish the custom domain switch once the DNS records are in.
#
#   bash scripts/domain-finish.sh
#
# Waits for keenlearning.org to point at Fly, waits for the TLS certificate to
# be issued, then repoints the app at the new address and redeploys. Safe to run
# repeatedly: every step checks whether it is already done.

set -u
export PATH="$HOME/.fly/bin:$PATH"
cd "$(dirname "$0")/.." || exit 1

APP="${APP:-keen-study}"
DOMAIN="${1:-keenlearning.org}"
EXPECT_V4="66.241.125.160"

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m   %s\n' "$*"; }
bad()  { printf '  \033[31mno\033[0m   %s\n' "$*"; }
info() { printf '       %s\n' "$*"; }

say "Checking DNS for $DOMAIN"
info "DNS changes usually take 5 to 30 minutes. Hostinger can take longer."

# Query a public resolver rather than the local one, which may still be serving
# a cached answer from before the records were added.
for i in $(seq 1 60); do
  GOT=$(dig +short @1.1.1.1 "$DOMAIN" A | head -1)
  if [ "$GOT" = "$EXPECT_V4" ]; then
    ok "$DOMAIN resolves to $GOT"
    break
  fi
  if [ -z "$GOT" ]; then
    printf '\r       attempt %s/60: no A record yet' "$i"
  else
    printf '\r       attempt %s/60: currently %s, waiting for %s' "$i" "$GOT" "$EXPECT_V4"
  fi
  sleep 20
done
echo

GOT=$(dig +short @1.1.1.1 "$DOMAIN" A | head -1)
if [ "$GOT" != "$EXPECT_V4" ]; then
  bad "DNS still is not pointing at Fly after 20 minutes."
  info "Check the records at Hostinger, then run this again."
  info "In particular make sure you DELETED any A record Hostinger added itself."
  exit 1
fi

say "Waiting for the TLS certificate"
info "Fly issues this automatically once it can see the DNS. Usually under a minute."
for i in $(seq 1 30); do
  if fly certs check "$DOMAIN" --app "$APP" 2>&1 | grep -qi "issued\|Certificate.*is valid\|ready"; then
    ok "certificate issued for $DOMAIN"
    break
  fi
  printf '\r       attempt %s/30' "$i"
  sleep 15
done
echo

say "Pointing the app at https://$DOMAIN"
# PUBLIC_URL decides the Secure flag on session cookies, the URLs in reset
# emails, and the return URLs Stripe sends people back to. All three break
# quietly if this still says fly.dev after the domain goes live.
if fly secrets set PUBLIC_URL="https://$DOMAIN" --app "$APP" >/dev/null 2>&1; then
  ok "PUBLIC_URL set"
else
  bad "could not set PUBLIC_URL"; exit 1
fi

say "Waiting for the restart"
sleep 40

say "Checking the site on the new domain"
HEALTH=$(curl -s -m 25 "https://$DOMAIN/api/health")
if printf '%s' "$HEALTH" | grep -q '"status":"ok"'; then
  ok "https://$DOMAIN is live"
  printf '  %s\n' "$HEALTH"
else
  bad "not responding yet on the new domain"
  info "$HEALTH"
  info "Give it another minute, then: curl https://$DOMAIN/api/health"
fi

cat <<EOF

────────────────────────────────────────────────────────────
  Two things to update now that the domain has changed
────────────────────────────────────────────────────────────

1. STRIPE WEBHOOK. It still points at the fly.dev address. That address keeps
   working, so payments will not break today, but move it so everything lives
   in one place:

   https://dashboard.stripe.com/webhooks
   Edit the endpoint URL to:
     https://$DOMAIN/api/webhooks/stripe

   The signing secret does not change when you edit the URL, so there is
   nothing to re-copy.

2. EMAIL. You now own a domain, which is the thing that was blocking password
   resets. At https://resend.com:

   Domains -> Add Domain -> $DOMAIN

   Resend gives you three or four DNS records (DKIM, SPF, and usually a DMARC).
   Add them at Hostinger the same way you added these, then:

     fly secrets set RESEND_API_KEY=re_your_key --app $APP
     fly secrets set MAIL_FROM="Keen <noreply@$DOMAIN>" --app $APP

   Check it worked:
     curl https://$DOMAIN/api/health     # mailMode should read "live"

EOF
