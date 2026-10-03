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
  which screenshots the panel, menu, submenus, a notification and every prefs
  page into OUT_DIR, and checks lock/unlock in `report.json`.

## Rules

- Never block the shell: every /proc and /sys read in the shell goes through
  `lib/io.js` (async; a file whose last read is still pending reads as null).
  Never read a device in runtime suspend (`power/runtime_status`).
- No network, no subprocesses, no root.
- Sensor settings are keyed by `name@device/kindN`, where device is a bus
  address (`stableDeviceId()` in `lib/hwmon.js`), never a probe-order number
  (`hwmonN`, `nvmeN`, `phyN`, an i2c bus).
- `disable()` must undo everything `enable()` did (EGO review requirement).
- Session modes `user` and `unlock-dialog`: monitoring and notifications go on
  while locked, the panel button is hidden (`_syncLocked`). EGO requires the
  comment above `disable()` that explains why.
- User-visible numbers go through `lib/format.js` (locale digits), never
  `toFixed()` or a template literal.
- Every user-visible string goes through `_()`. After changing strings: `make pot`,
  then update `po/fa.po`; placeholders keep their English order (`fmt()` fills
  them in sequence).
- RTL: menu rows and composed prefs subtitles get a leading RLM in RTL locales
  (`RowList` in `ui/indicator.js`, `rtl()` in `prefs.js`); paths go through
  `isolate()`.

## Before calling a change done

`make lint test`, then `tools/shell-test.sh <dir>` (and with `fa_IR.UTF-8`) and
look at the screenshots. The headless shell is fully isolated (own D-Bus, dconf,
extensions dir); it never touches the logged-in desktop.
