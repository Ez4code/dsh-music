#!/bin/sh
# Rebuild the helper app that owns the Music automation permission.
# Run from the package root: sh tools/build-helper.sh
set -e
cd "$(dirname "$0")/.."
mkdir -p assets/MusicHelper.app/Contents/MacOS
clang -fobjc-arc -framework Foundation -o assets/MusicHelper.app/Contents/MacOS/MusicHelper tools/MusicHelper.m
xattr -cr assets/MusicHelper.app
codesign --force --sign - assets/MusicHelper.app
echo "rebuilt assets/MusicHelper.app"
