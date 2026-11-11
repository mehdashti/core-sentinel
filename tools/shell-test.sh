#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Run Core Sentinel in a throwaway headless GNOME Shell, screenshot it and check
# the result.
#   tools/shell-test.sh [OUT_DIR] [LANG]      e.g. tools/shell-test.sh /tmp/cs fa_IR.UTF-8
# Fully isolated: its own D-Bus session, dconf database, runtime directory and
# extensions directory, so the desktop you are logged into is not touched.
# The shell stops as soon as the harness has written report.json, or after
# CS_TEST_SECONDS (default 120). Exits 1, saying why, when report.json or
# shell.log shows a failure, or when this GNOME Shell's major version is not in
# shell-version (the extension is then run anyway, with the shell's version
# check off, to show whether it works there).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$(mktemp -d)}"
LOCALE="${2:-en_US.UTF-8}"
SECONDS_TO_RUN="${CS_TEST_SECONDS:-120}"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
# what the harness writes, so nothing from an earlier run is taken for this one's
rm -f "$OUT/report.json" "$OUT"/{panel,menu*,notification,prefs*}.png

make -C "$ROOT" --quiet schemas translations

failures=()
fail() { failures+=("$1"); }

version="$(gnome-shell --version | sed -nE 's/^GNOME Shell ([0-9]+).*/\1/p')"
if [ -z "$version" ]; then
    echo "cannot tell the GNOME Shell major version from: $(gnome-shell --version)" >&2
    exit 1
fi
NO_VERSION_CHECK=false
for metadata in src/metadata.json tests/shell/harness@core-sentinel.test/metadata.json; do
    jq -e --arg v "$version" '."shell-version" | index($v)' "$ROOT/$metadata" >/dev/null && continue
    NO_VERSION_CHECK=true
    if [ "$metadata" = src/metadata.json ]; then
        fail "GNOME Shell $version is not in shell-version in src/metadata.json, so GNOME Shell $version refuses Core Sentinel as out of date. Add $version as CLAUDE.md, section \"A new GNOME major version\", describes. (This run turned the shell's version check off to show whether the extension works on $version.)"
    else
        fail "GNOME Shell $version is not in shell-version in $metadata, the test harness: add it there too (CLAUDE.md, section \"A new GNOME major version\")."
    fi
done

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT
mkdir -p "$SANDBOX/data/gnome-shell/extensions" "$SANDBOX/config" "$SANDBOX/cache"
mkdir -m 700 "$SANDBOX/runtime"
ln -s "$ROOT/src" "$SANDBOX/data/gnome-shell/extensions/core-sentinel@mehdashti.github.io"
ln -s "$ROOT/tests/shell/harness@core-sentinel.test" "$SANDBOX/data/gnome-shell/extensions/harness@core-sentinel.test"

# The runtime directory too: the shell keeps its crash guard there
# (gnome-shell-disable-extensions), which must not land in the desktop's.
export XDG_DATA_HOME="$SANDBOX/data" XDG_CONFIG_HOME="$SANDBOX/config" XDG_CACHE_HOME="$SANDBOX/cache"
export XDG_RUNTIME_DIR="$SANDBOX/runtime"
export CS_TEST_OUT="$OUT" LANG="$LOCALE" LANGUAGE="${LOCALE%%_*}" LC_ALL="$LOCALE"
export ROOT SECONDS_TO_RUN NO_VERSION_CHECK

# Everything on the session bus logs to shell.log, the preferences window too.
dbus-run-session -- bash -c '
    gsettings set org.gnome.shell enabled-extensions "[\"core-sentinel@mehdashti.github.io\", \"harness@core-sentinel.test\"]"
    gsettings set org.gnome.shell disable-extension-version-validation "$NO_VERSION_CHECK"
    gsettings set org.gnome.shell welcome-dialog-last-shown-version "999"
    # a new virtual pointer first lands at the top edge; on 51 that trips the hot corner
    gsettings set org.gnome.desktop.interface enable-hot-corners false
    GSETTINGS_SCHEMA_DIR="$ROOT/src/schemas" gsettings set org.gnome.shell.extensions.core-sentinel \
        panel-items "[\"cpu\", \"pressure\", \"cpu-temp\", \"memory\", \"gpu\", \"alert\"]"
    gnome-shell --headless --virtual-monitor 1600x1000 &
    pid=$!
    for ((i = 0; i < SECONDS_TO_RUN; i++)); do
        [ -e "$CS_TEST_OUT/report.json" ] && break
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
    done
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
' >"$OUT/shell.log" 2>&1 || true

echo "GNOME Shell $(gnome-shell --version | sed 's/^GNOME Shell //'), $LOCALE; output in $OUT"
cat "$OUT/report.json" 2>/dev/null && echo

if [ ! -e "$OUT/report.json" ]; then
    fail "no report.json: the harness did not finish within $SECONDS_TO_RUN s (CS_TEST_SECONDS). The end of shell.log:
$(tail -n 25 "$OUT/shell.log")"
# state 1 is ExtensionState.ACTIVE
elif ! checks="$(jq -r '
    if .error then "the harness failed: \(.error)" else
        (if .extError then "Core Sentinel failed: \(.extError)" else empty end),
        (if .state != 1 then "Core Sentinel is not active (extension state \(.state))" else empty end),
        (if .startupComplete != true then "GNOME Shell never finished its startup animation, so an invisible cover took the clicks meant for the preferences window" else empty end),
        (if .locked.sessionMode != "unlock-dialog" then "locking did not reach the lock screen (session mode \(.locked.sessionMode))" else empty end),
        (if .locked.extensionState != 1 then "locking stopped Core Sentinel (extension state \(.locked.extensionState))" else empty end),
        (if .locked.buttonVisible != false then "the panel button shows on the lock screen" else empty end),
        (if .unlocked.sessionMode != "user" then "unlocking did not return to the session (session mode \(.unlocked.sessionMode))" else empty end),
        (if .unlocked.sameIndicator != true then "unlocking rebuilt the panel button: the extension was disabled while locked" else empty end),
        (if .unlocked.buttonVisible != true then "the panel button stays hidden after unlocking" else empty end),
        (if .prefsWindow != true then "the preferences window did not open" else empty end),
        (if .switchOff.activeBefore > 0 and (.switchOff.activeAfter != 0 or .switchOff.notificationsAfter != 0)
            then "switching the alert rules off left \(.switchOff.activeAfter) of \(.switchOff.activeBefore) alerts on and \(.switchOff.notificationsAfter) notifications shown" else empty end),
        (if .history.entriesAfterClear != .history.ongoingAfterClear
            then "clearing Recent alerts left \(.history.entriesAfterClear) entries, only \(.history.ongoingAfterClear) of them still on" else empty end)
    end | gsub("\n"; " | ")' "$OUT/report.json")"; then
    fail "report.json cannot be read"
elif [ -n "$checks" ]; then
    while IFS= read -r line; do fail "$line"; done <<<"$checks"
fi
if [ "$(jq '.switchOff.activeBefore' "$OUT/report.json" 2>/dev/null)" = 0 ]; then
    echo "note: no alert was on when the rules were switched off, so that check had nothing to take back"
fi

if grep -q "JS ERROR" "$OUT/shell.log"; then
    fail "shell.log has JS errors:
$(grep -A 4 "JS ERROR" "$OUT/shell.log" | head -n 40)"
fi

if [ "${#failures[@]}" -eq 0 ]; then
    echo "PASS"
    exit 0
fi
for message in "${failures[@]}"; do
    if [ "${GITHUB_ACTIONS:-}" = true ]; then
        # an annotation is one line; its title may hold neither commas nor colons
        message="${message//'%'/'%25'}"
        message="${message//$'\r'/'%0D'}"
        echo "::error title=Shell test (GNOME Shell $version; $LOCALE)::${message//$'\n'/'%0A'}"
    else
        echo "FAIL: $message" >&2
    fi
done
exit 1
