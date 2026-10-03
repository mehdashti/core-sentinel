#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Run Core Sentinel in a throwaway headless GNOME Shell and screenshot it.
#   tools/shell-test.sh [OUT_DIR] [LANG]      e.g. tools/shell-test.sh /tmp/cs fa_IR.UTF-8
# Fully isolated: its own D-Bus session, dconf database and extensions
# directory, so the desktop you are logged into is not touched.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$(mktemp -d)}"
LOCALE="${2:-en_US.UTF-8}"
SECONDS_TO_RUN="${CS_TEST_SECONDS:-80}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

make -C "$ROOT" --quiet schemas translations

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/data/gnome-shell/extensions" "$SANDBOX/config" "$SANDBOX/cache"
ln -s "$ROOT/src" "$SANDBOX/data/gnome-shell/extensions/core-sentinel@mehdashti.github.io"
ln -s "$ROOT/tests/shell/harness@core-sentinel.test" "$SANDBOX/data/gnome-shell/extensions/harness@core-sentinel.test"

export XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" XDG_CACHE_HOME="$SANDBOX/cache"
export CS_TEST_OUT="$OUT" LANG="$LOCALE" LANGUAGE="${LOCALE%%_*}" LC_ALL="$LOCALE"
export ROOT SECONDS_TO_RUN

dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"core-sentinel@mehdashti.github.io\", \"harness@core-sentinel.test\"]"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    GSETTINGS_SCHEMA_DIR="$ROOT/src/schemas" gsettings set org.gnome.shell.extensions.core-sentinel \
        panel-items "[\"cpu\", \"pressure\", \"cpu-temp\", \"memory\", \"gpu\", \"alert\"]"
    gnome-shell --headless --virtual-monitor 1600x1000 >"$CS_TEST_OUT/shell.log" 2>&1 &
    pid=$!
    sleep "$SECONDS_TO_RUN"
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
'
echo "output: $OUT"
grep -iE "core.sentinel|JS ERROR|TypeError|ReferenceError" "$OUT/shell.log" | head -20 || true
cat "$OUT/report.json" 2>/dev/null || echo "no report written"
