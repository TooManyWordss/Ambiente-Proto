#!/data/data/com.termux/files/usr/bin/bash
# Installs, or updates, the café server on this tablet, from the ready-built copy on GitHub
# (the "tablet" branch of the private Ambiente-Proto repo). The first time, in Termux:
#   export CAFE_GITHUB_TOKEN=<the read-only GitHub key>
#   curl -fsSL -H "Authorization: Bearer $CAFE_GITHUB_TOKEN" -H "Accept: application/vnd.github.raw" \
#     "https://api.github.com/repos/TooManyWordss/Ambiente-Proto/contents/termux/install.sh?ref=tablet" | bash
# After that, updating is one word:  cafe-update
# Updating keeps the sales (in ~/cafe-pos-data) and the settings (~/cafe-pos/.env).

# Everything is inside main(), so nothing runs unless the whole script arrived.
main() {
  set -e
  local REPO="TooManyWordss/Ambiente-Proto" BRANCH="tablet"
  local APP_DIR="$HOME/cafe-pos" DATA_DIR="$HOME/cafe-pos-data" KEY_FILE="$HOME/.cafe-github-token"

  echo "== 1/5 Installing tools (a few minutes the first time) =="
  # A full upgrade, not just a refresh: half-updated Termux libraries stop node with "cannot link executable".
  pkg upgrade -y -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold < /dev/null
  pkg install -y nodejs-lts tar < /dev/null || pkg install -y nodejs tar < /dev/null
  if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)'; then
    pkg uninstall -y nodejs-lts < /dev/null || true
    pkg install -y nodejs < /dev/null   # the database needs Node 22.13 or newer
  fi
  pkg install -y cloudflared < /dev/null || echo "(cloudflared unavailable: remote owner access will be off)"
  echo "Node $(node -v) ready."

  echo "== 2/5 Downloading the café system =="
  # The read-only GitHub key: kept on this tablet only, so later updates don't ask again.
  local KEY="${CAFE_GITHUB_TOKEN:-}"
  [ -n "$KEY" ] || KEY="$(cat "$KEY_FILE" 2>/dev/null || true)"
  [ -n "$KEY" ] || { read -rsp "GitHub key (starts with github_pat_): " KEY < /dev/tty; echo; }
  mkdir -p "$APP_DIR" "$DATA_DIR"
  local STATUS
  STATUS="$(curl -sSL -w '%{http_code}' -o "$APP_DIR/package.tgz" -H "Authorization: Bearer $KEY" -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/$REPO/tarball/$BRANCH" || echo 000)"
  if [ "$STATUS" = "401" ] || [ "$STATUS" = "403" ] || [ "$STATUS" = "404" ]; then
    rm -f "$APP_DIR/package.tgz" "$KEY_FILE"
    echo "GitHub didn't accept the key (it may have expired). Nothing was changed. Run this again with a new key."; exit 1
  elif [ "$STATUS" != "200" ]; then
    rm -f "$APP_DIR/package.tgz"
    echo "Could not download the update (no internet?). Nothing was changed. Try again later."; exit 1
  fi
  ( umask 077; printf '%s\n' "$KEY" > "$KEY_FILE" )
  cd "$APP_DIR"
  rm -rf server dist client termux          # old app files only; .env and the sales stay
  tar -xzf package.tgz --strip-components=1 && rm package.tgz

  echo "== 3/5 Installing the app's libraries =="
  npm ci --omit=dev --no-audit --no-fund < /dev/null

  echo "== 4/5 Settings =="
  local NEW_TOPIC; NEW_TOPIC="ambiente-$(node -e 'console.log(require("crypto").randomBytes(8).toString("hex"))')"
  if [ -f .env ]; then
    echo "Keeping this tablet's settings."
    # Phone alerts and the internet link, for tablets set up before they existed.
    grep -q '^NTFY_TOPIC=' .env || echo "NTFY_TOPIC=$NEW_TOPIC" >> .env
    if command -v cloudflared > /dev/null && ! grep -q '^TUNNEL=' .env; then echo "TUNNEL=1" >> .env; fi
  else
    local OWNER="${CAFE_OWNER_PASSWORD:-}" PIN="${CAFE_PIN:-}" SECRET TUNNEL=0
    [ -n "$OWNER" ] || { read -rsp "Owner password for the admin panel (at least 10 characters): " OWNER < /dev/tty; echo; }
    [ -n "$PIN" ] || { read -rp "PIN for the POS, waiter, kitchen and inventory screens [123456789]: " PIN < /dev/tty; }
    PIN="${PIN:-123456789}"
    SECRET="$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')"
    command -v cloudflared > /dev/null && TUNNEL=1
    {
      echo "POS_PIN=$PIN"; echo "BARISTA_PIN=$PIN"; echo "KITCHEN_PIN=$PIN"; echo "INVENTORY_PIN=$PIN"
      echo "ADMIN_PASSWORD=$OWNER"; echo "SESSION_SECRET=$SECRET"
      echo "TZ=Asia/Manila"; echo "PORT=3000"; echo "DATA_DIR=$DATA_DIR"
      echo "TUNNEL=$TUNNEL"; echo "NTFY_TOPIC=$NEW_TOPIC"
    } > .env
    chmod 600 .env
    echo "Saved. Change PINs or the owner password later in Admin → Staff & sign-in."
  fi

  echo "== 5/5 Shortcuts =="
  # "cafe" and "cafe-update" are real commands (not shell aliases), so they work in every Termux session.
  # An alias left by an earlier setup would hide them, so remove any.
  sed -i '/alias cafe=/d' "$HOME/.bashrc" 2>/dev/null || true
  printf '#!/data/data/com.termux/files/usr/bin/bash\nexec bash "%s/termux/start.sh" "$@"\n' "$APP_DIR" > "$PREFIX/bin/cafe"
  chmod +x "$PREFIX/bin/cafe"
  cat > "$PREFIX/bin/cafe-update" <<UPDATE
#!/data/data/com.termux/files/usr/bin/bash
# Downloads the newest café system from GitHub and restarts the server. Sales and settings stay.
set -o pipefail
KEY="\$(cat "$KEY_FILE" 2>/dev/null)"
curl -fsSL -H "Authorization: Bearer \$KEY" -H "Accept: application/vnd.github.raw" \\
  "https://api.github.com/repos/$REPO/contents/termux/install.sh?ref=$BRANCH" | bash \\
  || echo "Could not reach GitHub (no internet, or the key expired). The café keeps running as it was."
UPDATE
  chmod +x "$PREFIX/bin/cafe-update"
  mkdir -p "$HOME/.termux/boot"   # used by the Termux:Boot app, if installed: starts the café when the tablet turns on
  printf '#!/data/data/com.termux/files/usr/bin/bash\nbash "%s/termux/start.sh"\n' "$APP_DIR" > "$HOME/.termux/boot/start-cafe"
  chmod +x "$HOME/.termux/boot/start-cafe"

  local TOPIC; TOPIC="$(grep '^NTFY_TOPIC=' .env | cut -d= -f2)"
  echo
  echo "Phone alerts for the owner link: install the free \"ntfy\" app on your phone,"
  echo "tap +, and subscribe to:  $TOPIC"
  echo "(or open https://ntfy.sh/$TOPIC in the phone's browser)"
  echo
  echo "All set. Starting the café server... (next time: cafe   ·   to update: cafe-update)"
  exec bash "$APP_DIR/termux/start.sh"
}
main
