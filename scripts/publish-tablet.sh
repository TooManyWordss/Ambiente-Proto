#!/usr/bin/env bash
# Publishes a ready-built copy of the café system to the "tablet" branch on GitHub, for the café
# tablet's `cafe-update`. Run from the project folder on the computer:  npm run publish-tablet
# Only the files the tablet runs go up (the server, the built screens, the Termux scripts):
# never .env, databases or backups. The tablet then needs no build tools of its own.
set -euo pipefail
cd "$(dirname "$0")/.."
REMOTE="${TABLET_REMOTE:-proto}"
FILES=(server.js server events.js menu-catalog.js menu-descriptions.js dining-domain.js dining-server.js weighed.js
  package.json package-lock.json dist client/public termux)

[ -z "$(git status --porcelain)" ] || { echo "Commit your changes first, so the tablet gets exactly what's on main."; exit 1; }
npm run build
INDEX="$(mktemp)"; trap 'rm -f "$INDEX"' EXIT
export GIT_INDEX_FILE="$INDEX"
git read-tree --empty
git add -f -- "${FILES[@]}"
git rm -r -q --cached --ignore-unmatch -- '*.DS_Store' '*.db' '*.db-*' '.env' > /dev/null
TREE="$(git write-tree)"
unset GIT_INDEX_FILE
git fetch -q "$REMOTE" tablet 2>/dev/null || true
PARENT="$(git rev-parse -q --verify "$REMOTE/tablet" || true)"
if [ -n "$PARENT" ] && [ "$(git rev-parse "$PARENT^{tree}")" = "$TREE" ]; then echo "The tablet branch already has this version."; exit 0; fi
COMMIT="$(printf 'Tablet build of %s\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n' "$(git rev-parse --short HEAD)" | git commit-tree "$TREE" ${PARENT:+-p "$PARENT"})"
git push -q "$REMOTE" "$COMMIT:refs/heads/tablet"
echo "Published $(git rev-parse --short "$COMMIT") to $REMOTE/tablet. On the tablet, type: cafe-update"
