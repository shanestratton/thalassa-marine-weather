#!/usr/bin/env bash
# Upload the relief tiles from the wx server to Cloudflare R2 (bucket thalassa-relief).
#
#   tools/relief/upload.sh setup      ask for the R2 keys (hidden input) and save them, chmod 600
#   tools/relief/upload.sh            copy $OUT (default /srv/relief/v1) to r2:thalassa-relief/v1
#   tools/relief/upload.sh --dry-run  list what would be sent
#   PYRAMIDS=relief-global tools/relief/upload.sh   only the GEBCO pyramid
#   tools/relief/upload.sh check URL  spot-check the public copy, e.g. check https://pub-xxxx.r2.dev/v1
#
# Credentials: an R2 S3 API token (Object Read & Write on this bucket only),
# made in the Cloudflare dashboard (see README.md). `setup` writes it to
# ~/.config/thalassa-relief/r2.env (chmod 600), never to the repo:
#   R2_ACCOUNT_ID=...          (wrangler whoami, or R2 -> Overview -> Account Details)
#   R2_ACCESS_KEY_ID=...
#   R2_SECRET_ACCESS_KEY=...
# They go to rclone through its environment, so no rclone.conf holds them.
#
# Every object gets Cache-Control: public, max-age=31536000, immutable.
# A changed tile set is a NEW prefix (v2/...), never an overwrite of v1.
# Resumable: objects already in the bucket with the same size are skipped.
# ~600k objects: run it in tmux (tmux new -s relief-up tools/relief/upload.sh).
set -euo pipefail

ROOT=${ROOT:-/srv/relief}
OUT=${OUT:-$ROOT/v1}
VERSION=$(basename "$OUT")
BUCKET=${BUCKET:-thalassa-relief}
ENV_FILE=${ENV_FILE:-$HOME/.config/thalassa-relief/r2.env}
TRANSFERS=${TRANSFERS:-64}
PYRAMIDS=${PYRAMIDS:-relief-global relief-au}   # e.g. PYRAMIDS=relief-global to hold relief-au back
IMMUTABLE='Cache-Control: public, max-age=31536000, immutable'

check() { # base URL of the public copy, ending in /v1
  local base=${1%/} ok=0 bad=0
  local probes=(manifest.json)
  for set in relief-global/idx relief-global/dem relief-au/idx relief-au/dem; do
    [ -d "$OUT/$set" ] && probes+=($(cd "$OUT" && find "$set" -type f | shuf -n 3))
  done
  for p in "${probes[@]}"; do
    local h; h=$(curl -sS -o /dev/null -D - -H 'Origin: https://thalassawx.app' "$base/$p" | tr -d '\r')
    local code; code=$(printf '%s\n' "$h" | awk 'NR==1{print $2}')
    printf '%-40s %s  %s | %s | %s\n' "$p" "$code" \
      "$(printf '%s\n' "$h" | grep -i '^content-type:' | cut -d' ' -f2-)" \
      "$(printf '%s\n' "$h" | grep -i '^cache-control:' | cut -d' ' -f2-)" \
      "$(printf '%s\n' "$h" | grep -i '^access-control-allow-origin:' | cut -d' ' -f2-)"
    [ "$code" = 200 ] && ok=$((ok + 1)) || bad=$((bad + 1))
  done
  echo "ok=$ok bad=$bad (each probe is a tile that exists on wx, so every one should be 200)"
  # A missing tile must be a 404 that still carries CORS, or the browser turns
  # it into a network error and Mapbox reports every land tile as a failure.
  local h; h=$(curl -sS -o /dev/null -D - -H 'Origin: capacitor://localhost' "$base/relief-au/idx/8/0/0.png" | tr -d '\r')
  printf '%-40s %s  allow-origin=%s  (want 404 with allow-origin *)\n' 'relief-au/idx/8/0/0.png (absent)' \
    "$(printf '%s\n' "$h" | awk 'NR==1{print $2}')" "$(printf '%s\n' "$h" | grep -i '^access-control-allow-origin:' | cut -d' ' -f2-)"
}

setup() { # ask for the token's two S3 values without echoing them; keep the account id if already saved
  local acct="${R2_ACCOUNT_ID:-}" kid secret
  mkdir -p "$(dirname "$ENV_FILE")"
  [ -z "$acct" ] && [ -r "$ENV_FILE" ] && acct=$(sed -n 's/^R2_ACCOUNT_ID=//p' "$ENV_FILE")
  [ -n "$acct" ] || read -r -p 'Cloudflare Account ID: ' acct
  read -r -p 'R2 Access Key ID: ' kid
  read -r -s -p 'R2 Secret Access Key (hidden): ' secret; echo
  [ -n "$acct" ] && [ -n "$kid" ] && [ -n "$secret" ] || { echo 'all three values are needed'; exit 1; }
  ( umask 077; printf 'R2_ACCOUNT_ID=%s\nR2_ACCESS_KEY_ID=%s\nR2_SECRET_ACCESS_KEY=%s\n' "$acct" "$kid" "$secret" > "$ENV_FILE" )
  chmod 600 "$ENV_FILE"
  echo "saved $ENV_FILE (600). Next: tmux new -s relief-up '$0; bash'"
}

if [ "${1:-}" = check ]; then check "${2:?usage: upload.sh check https://<public-host>/v1}"; exit; fi
if [ "${1:-}" = setup ]; then setup; exit; fi

[ -r "$ENV_FILE" ] || { echo "missing $ENV_FILE: run '$0 setup' first (README.md: R2 API token)"; exit 1; }
[ "$(stat -c %a "$ENV_FILE")" = 600 ] || { echo "chmod 600 $ENV_FILE first"; exit 1; }
set -a; . "$ENV_FILE"; set +a
[ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ] \
  || { echo "$ENV_FILE is missing a value: run '$0 setup'"; exit 1; }
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY
export RCLONE_CONFIG_R2_ENDPOINT=https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_ACL=private
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
unset R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY

DRY=()
[ "${1:-}" = --dry-run ] && DRY=(--dry-run)

send() { # local-subdir content-type
  echo "== $VERSION/$1 ($2)"
  rclone copy "$OUT/$1" "r2:$BUCKET/$VERSION/$1" "${DRY[@]}" \
    --size-only --fast-list --transfers "$TRANSFERS" --checkers 32 --retries 5 --low-level-retries 20 \
    --header-upload "$IMMUTABLE" --header-upload "Content-Type: $2" \
    --stats 60s --stats-one-line --log-level NOTICE
}

for pyr in $PYRAMIDS; do
  [ -d "$OUT/$pyr" ] || { echo "no $OUT/$pyr"; continue; }
  send "$pyr/idx" image/png
  send "$pyr/dem" image/webp
done
# The manifest last, so its presence means the tiles are complete. Short cache: it is metadata.
[ -f "$OUT/manifest.json" ] && rclone copyto "$OUT/manifest.json" "r2:$BUCKET/$VERSION/manifest.json" "${DRY[@]}" \
  --header-upload 'Cache-Control: public, max-age=3600' --header-upload 'Content-Type: application/json'
echo "done. Spot-check the public copy: $0 check https://<r2.dev host or custom domain>/$VERSION"
