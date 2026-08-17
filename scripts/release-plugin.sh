#!/bin/sh
# Publicerar streams-scraper som GitHub-release med dist/runtime.js som asset
# och pekar marketplace.json på release-asseten. Release-assets serveras från
# objects.githubusercontent.com (riktig CDN, ingen raw-kvot) och passerar
# appens host-allowlist i alla versioner.
#
#   sh scripts/release-plugin.sh 1.0.100
#
# Förutsätter: dist/runtime.js är OMBYGGD FÖRE versionsbump (se
# lumio-plugin-release-trap), versionen redan satt i plugin.json +
# marketplace.json + runtime/index.ts, allt committat. Kräver gh inloggad som
# dev-sketcher (kontot med skrivrätt här).
set -eu

VERSION="${1:?ange pluginversion, t.ex. 1.0.100}"
REPO="dev-sketcher/Lumio-scraper"
TAG="plugin-v$VERSION"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ACTIVE_ACCOUNT="$(gh api user -q .login 2>/dev/null || echo okänd)"
if [ "$ACTIVE_ACCOUNT" != "dev-sketcher" ]; then
  echo "gh är inloggad som '$ACTIVE_ACCOUNT' — byt med: gh auth switch -u dev-sketcher" >&2
  exit 1
fi

MANIFEST_VERSION="$(python3 -c "import json; print([p for p in json.load(open('marketplace.json'))['plugins'] if p['id']=='com.lumio.streams-scraper'][0]['version'])")"
if [ "$MANIFEST_VERSION" != "$VERSION" ]; then
  echo "marketplace.json säger $MANIFEST_VERSION men du släpper $VERSION — bumpa först." >&2
  exit 1
fi

git tag "$TAG" 2>/dev/null || true
git push origin "$TAG"

gh release create "$TAG" plugins/streams-scraper/dist/runtime.js \
  --repo "$REPO" --title "Streams Scraper $VERSION" \
  --notes "Runtime bundle för Lumio. Serveras som release-asset (CDN) istället för raw." \
  || gh release upload "$TAG" plugins/streams-scraper/dist/runtime.js --repo "$REPO" --clobber

ASSET_URL="https://github.com/$REPO/releases/download/$TAG/runtime.js"
python3 - "$ASSET_URL" <<'EOF'
import json, sys
url = sys.argv[1]
d = json.load(open('marketplace.json'))
for p in d['plugins']:
    if p['id'] == 'com.lumio.streams-scraper':
        p['runtimeBundleUrl'] = url
json.dump(d, open('marketplace.json', 'w'), indent=2, ensure_ascii=False)
p = json.load(open('plugins/streams-scraper/plugin.json'))
p['runtimeBundleUrl'] = url
json.dump(p, open('plugins/streams-scraper/plugin.json', 'w'), indent=2, ensure_ascii=False)
print('runtimeBundleUrl →', url)
EOF

git add marketplace.json plugins/streams-scraper/plugin.json
git commit -m "release: $VERSION via release-asset (runtimeBundleUrl)"
git push origin main

echo "PLUGIN $VERSION SLÄPPT som release-asset — apparna hämtar via $ASSET_URL"
