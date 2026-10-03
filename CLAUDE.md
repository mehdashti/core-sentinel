# Core Sentinel: working rules

GNOME Shell extension (GNOME 48–50, GJS ESM), published as open source under
GPL-2.0-or-later at github.com/mehdashti/core-sentinel. UUID
`core-sentinel@mehdashti.github.io`, schema `org.gnome.shell.extensions.core-sentinel`,
gettext domain `core-sentinel`.

## Layout

- `src/lib/`: no GNOME Shell imports (only `gi://GLib`/`gi://Gio`). Data readers,
  `alerts.js` (pure rules), `labels.js` (gettext injected), `format.js`. Shared by
  the shell, `prefs.js` and `tests/run.js`. Keep it that way: prefs and tests
  cannot import `resource:///org/gnome/shell/...`.
- `src/ui/`: shell-only (panel button, menu, notifications).
- `tools/snapshot.js`: data layer against the real machine. `tools/shell-test.sh`:
  isolated headless GNOME Shell + `tests/shell/harness@core-sentinel.test`,
  which screenshots the panel, menu, submenus and prefs into OUT_DIR.

## Rules

- Never block the shell: every /proc and /sys read in the shell goes through
  `lib/io.js` (async). Never read a device in runtime suspend (`power/runtime_status`).
- No network, no subprocesses, no root.
- Sensor settings are keyed by `name@device/kindN`, never by `hwmonN`.
- `disable()` must undo everything `enable()` did (EGO review requirement).
- Every user-visible string goes through `_()`. After changing strings: `make pot`,
  then update `po/fa.po`; placeholders keep their English order (`fmt()` fills
  them in sequence).
- RTL: menu rows get a leading RLM in RTL locales (`ui/indicator.js` RowList).

## Before calling a change done

`make lint test`, then `tools/shell-test.sh <dir>` (and with `fa_IR.UTF-8`) and
look at the screenshots. The headless shell is fully isolated (own D-Bus, dconf,
extensions dir); it never touches the logged-in desktop.
