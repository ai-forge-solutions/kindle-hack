#!/bin/sh
# Netlify: empaqueta la extensión en un .zip descargable y publica la guía.
set -e
rm -rf dist && mkdir -p dist
cp site/* dist/
(cd extension && zip -qr ../dist/subrayados-extension.zip . -x '.*')
VERSION=$(node -p "require('./extension/manifest.json').version")
COMMIT=$(git rev-parse --short HEAD 2>/dev/null || echo "")
printf '{"version":"%s","built":"%s","commit":"%s"}\n' "$VERSION" "$(date -u +%Y-%m-%d)" "$COMMIT" > dist/version.json
echo "Built dist/ with extension $VERSION"
