#!/usr/bin/env bash
# One-time Supabase setup for the NYX workspace: database changes, the Claude connector (mcp)
# and the Discord shift bot (discord-reminders).
#
# Run from the repo root by someone with access to the Supabase project:
#   brew install supabase/tap/supabase   # once
#   supabase login                       # once, opens a browser
#   bash tools/setup_supabase.sh
#
# Safe to re-run: schema.sql is idempotent, deploys overwrite, the cron job is replaced.
# Secrets you type are read without echo and never written to disk.
set -euo pipefail

REF="wdzrttyxcedkaifzkjvp"
URL="https://${REF}.supabase.co"
cd "$(dirname "$0")/.."

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

command -v supabase >/dev/null || { echo "Install the Supabase CLI first: brew install supabase/tap/supabase"; exit 1; }
if ! supabase projects list >/dev/null 2>&1; then
  echo "Not logged in. Run: supabase login"; exit 1
fi
if ! supabase projects list 2>/dev/null | grep -q "$REF"; then
  echo "This Supabase account can't see project $REF."
  echo "Ask the project owner to invite you: Dashboard → Organization settings → Team → Invite member."
  exit 1
fi

say "1/5  Applying database changes (supabase/schema.sql)…"
supabase db query --linked --project-ref "$REF" -f supabase/schema.sql >/dev/null
echo "     done"

say "2/5  Deploying functions…"
supabase functions deploy mcp --project-ref "$REF" --no-verify-jwt --use-api
supabase functions deploy discord-reminders --project-ref "$REF" --no-verify-jwt --use-api

say "3/5  Discord settings"
echo "     Discord → your reminders channel → Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL"
read -rsp "     Paste the webhook URL (input hidden, Enter to skip the Discord bot): " WEBHOOK; echo
if [[ -z "$WEBHOOK" ]]; then
  say "Skipped the Discord bot. The Claude connector is deployed. Re-run this script to add Discord later."
  exit 0
fi
if [[ "$WEBHOOK" != https://discord.com/api/webhooks/* && "$WEBHOOK" != https://discordapp.com/api/webhooks/* ]]; then
  echo "     That doesn't look like a Discord webhook URL."; exit 1
fi
echo "     Optional: auto-link members by server nickname (Developer Portal → Bot → Server Members Intent ON → Reset Token)."
read -rsp "     Bot token (hidden, Enter to skip): " BOT_TOKEN; echo
GUILD_ID=""
if [[ -n "$BOT_TOKEN" ]]; then
  read -rp "     Server ID (right-click server icon → Copy Server ID): " GUILD_ID
fi

CRON_SECRET="$(openssl rand -hex 24)"
SECRETS=(DISCORD_WEBHOOK_URL="$WEBHOOK" CRON_SECRET="$CRON_SECRET")
[[ -n "$BOT_TOKEN" && -n "$GUILD_ID" ]] && SECRETS+=(DISCORD_BOT_TOKEN="$BOT_TOKEN" DISCORD_GUILD_ID="$GUILD_ID")

say "4/5  Saving function secrets and starting the 15-minute schedule…"
supabase secrets set --project-ref "$REF" "${SECRETS[@]}" >/dev/null
TMP_SQL="$(mktemp)"
trap 'rm -f "$TMP_SQL"' EXIT
sed "s/PASTE_CRON_SECRET_HERE/${CRON_SECRET}/" supabase/discord_reminders.sql > "$TMP_SQL"
supabase db query --linked --project-ref "$REF" -f "$TMP_SQL" >/dev/null
echo "     done"

say "5/5  Sending a test message to Discord…"
sleep 5   # give the new secrets a moment to reach the function
curl -fsS -X POST "${URL}/functions/v1/discord-reminders?mode=test" -H "x-cron-secret: ${CRON_SECRET}" && echo
say "All set. Check your Discord channel for the test message."
