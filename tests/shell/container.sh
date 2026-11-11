#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Prepare a fresh Fedora container to run tools/shell-test.sh. Run as root:
# installs GNOME Shell, starts a system bus with the two services the shell
# cannot do without, logind and GDM (a container has neither, so both are
# python-dbusmock mocks with a session c1 for the test user), and adds that
# user, "tester", who owns the checkout (shell-test.sh compiles into it).
# CI does this (.github/workflows/ci.yml); to do the same on your machine, with
# Docker:
#   docker run --rm -v "$PWD:/src" -w /src quay.io/fedora/fedora:rawhide bash -c \
#       'tests/shell/container.sh && runuser -u tester -- env XDG_SESSION_ID=c1 tools/shell-test.sh out'
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

# Fonts: the shell brings its own; DejaVu has the panel's ⬡ ▦ ▣, Vazirmatn is
# for Persian.
dnf -y -q install --setopt=install_weak_deps=False \
    gnome-shell mesa-dri-drivers xorg-x11-server-Xwayland \
    dbus-daemon dbus-tools python3-dbusmock util-linux \
    gjs glib2 gettext make jq \
    dejavu-sans-fonts vazirmatn-vf-fonts glibc-langpack-en glibc-langpack-fa

# Given the checkout owner's uid, the chown below changes nothing on a bind
# mount. On GitHub the checkout is throwaway and partly root's.
owner="$(stat -c %u "$ROOT")"
if [ "$owner" != 0 ]; then
    useradd -m -u "$owner" tester
elif [ "${GITHUB_ACTIONS:-}" = true ]; then
    useradd -m tester
else
    echo "$ROOT belongs to root in this container (rootless Podman maps you to root);" \
        "use Docker, or a copy of the checkout" >&2
    exit 1
fi
chown -R tester "$ROOT"
uid="$(id -u tester)"

dbus-uuidgen --ensure=/etc/machine-id
mkdir -p /run/dbus
dbus-daemon --system --fork
python3 -m dbusmock --system --template logind >/var/log/mock-logind.log 2>&1 &
python3 -m dbusmock --system --template "$ROOT/tests/shell/gdm.py" >/var/log/mock-gdm.log 2>&1 &
gdbus wait --system --timeout 20 org.freedesktop.login1
gdbus wait --system --timeout 20 org.gnome.DisplayManager

mock() {
    gdbus call --system --dest org.freedesktop.login1 --object-path /org/freedesktop/login1 \
        --method "org.freedesktop.DBus.Mock.$1" "${@:2}" >/dev/null
}
mock AddSession c1 seat0 "$uid" tester true
# the template's GetUser adds a number to a string
mock AddMethod org.freedesktop.login1.Manager GetUser u o \
    'ret = dbus.ObjectPath("/org/freedesktop/login1/user/%d" % args[0])'
