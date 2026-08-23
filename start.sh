#!/bin/sh
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 is required (Windows Server 2012 R2)."
  echo "https://nodejs.org/dist/v18.20.8/node-v18.20.8-x64.msi"
  exit 1
fi

MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$MAJOR" != "18" ]; then
  echo "This app targets Node.js 18. Found $(node -v)."
  echo "Install Node 18 x64: https://nodejs.org/dist/v18.20.8/"
  exit 1
fi

if [ ! -d node_modules ]; then
  npm install
fi

if [ ! -d web/dist ]; then
  npm run build -w web
fi

npm start
