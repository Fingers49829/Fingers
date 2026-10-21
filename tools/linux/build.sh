#!/bin/bash
# Rebuild the whole site on Linux: node tools/linux/build.sh  ->  bash tools/linux/build.sh [build-site args]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
cd "$here/../.."
chmod +x "$here/powershell" "$here/chromium"
PATH="$here:$PATH" FOS_BROWSER="$here/chromium" node tools/build-site.mjs "$@"
