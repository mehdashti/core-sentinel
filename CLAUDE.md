# Core Sentinel: working rules

GNOME Shell extension (GNOME 48–51, GJS ESM), published as open source under
GPL-2.0-or-later at github.com/mehdashti/core-sentinel. UUID
`core-sentinel@mehdashti.github.io`, schema `org.gnome.shell.extensions.core-sentinel`,
gettext domain `core-sentinel`.

## Layout

- `src/lib/`: no GNOME Shell imports (only `gi://GLib`/`gi://Gio`). Data readers,
  `alerts.js` (pure rules; `AlertEngine.update()` returns raised, cleared and
  dropped), `history.js` (Recent alerts), `processes.js` (top processes),
  `labels.js` (gettext injected), `format.js`. Shared by the shell, `prefs.js`
  and `tests/run.js`. Keep it that way: prefs and tests cannot import
  `resource:///org/gnome/shell/...`.
- `src/ui/`: shell-only (panel button, menu, notifications). The menu is one
  row per group (`group()` in `ui/indicator.js`): the row's title sums the
  group up and turns red while one of its alerts is on, and its details open
  below it. Keep the closed menu short, so an open group has the screen to
  itself: `report.json` has `menuHeight` and, per group, `shown` against
  `content`.
- `tools/snapshot.js`: data layer against the real machine. `tools/shell-test.sh`:
  isolated headless GNOME Shell + `tests/shell/harness@core-sentinel.test`,
  which screenshots the panel, the menu with each group open, Recent alerts, a
  notification and every prefs page into OUT_DIR, and records lock/unlock,
  the alert switch-off, clearing Recent alerts and each open group's height in
  `report.json`. The script then prints PASS, or each failure (the report, a
  `JS ERROR` in `shell.log`, a GNOME major missing from `shell-version`) and
  exits 1. When you add a field to the report, add its check there too.
- `tests/shell/container.sh`: readies a Fedora container for `shell-test.sh`
  (CI, `.github/workflows/ci.yml`). GNOME Shell does not start without
  logind and has no lock screen without GDM; a container has neither, so both
  are python-dbusmock mocks (`tests/shell/gdm.py`).

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
  comment above `disable()` that explains why; its last `//` line must name
  the session mode, since Shexli reads only the line right above `disable()`.
- User-visible numbers go through `lib/format.js` (locale digits), never
  `toFixed()` or a template literal.
- Every user-visible string goes through `_()`. After changing strings: `make pot`,
  then update `po/fa.po`; placeholders keep their English order (`fmt()` fills
  them in sequence).
- RTL: menu rows and composed prefs subtitles get a leading RLM in RTL locales
  (`RowList` in `ui/indicator.js`, `rtl()` in `prefs.js`); paths go through
  `isolate()`.
- Text from another process (a process name) is untrusted: plain label text,
  never markup, control and bidi characters replaced, isolated.
- A settings change applies at once (`_process()` on the last reading), and an
  alert whose subject stops being watched is dropped: its notification is
  withdrawn, without a "recovered" message.
- Work goes straight to `main`, in a linear history: no merge commits, no pull
  requests. A side branch comes in by fast-forward or cherry-pick.

## Before calling a change done

`make lint test`, then `tools/shell-test.sh <dir>` (and with `fa_IR.UTF-8`):
it must print PASS; then look at the screenshots. The headless shell has its
own session bus, dconf, runtime dir and extensions dir; it never touches the
logged-in desktop. CI runs the same test on the newest stable Fedora at every
push, and on Fedora rawhide every Monday (or by hand: Actions, CI, Run
workflow); the screenshots are in each run's artifacts.

## A new GNOME major version

The shell refuses an extension whose `shell-version` does not list the running
major (Extensions app: "out of date"). The weekly CI run on Fedora rawhide is
the warning: once rawhide moves to that major it fails with "GNOME Shell N is
not in shell-version". It runs the extension anyway, with the shell's version
check off, so the rest of its result and its screenshots show what else broke.
To add one:

1. Add it to `shell-version` in `src/metadata.json` and in
   `tests/shell/harness@core-sentinel.test/metadata.json`, and to the version
   lists in `README.md` (Requirements) and the top of this file.
2. Run the full check above on a machine with that GNOME Shell, or the rawhide
   CI run while rawhide has it. A failure in `report.json` can come from the
   harness, not the extension: the harness uses more shell internals (virtual
   input, the hot corner, window placement, the startup animation).
3. On the live desktop the change shows only after logging out and back in:
   the shell reads `metadata.json` once, at session start.

GNOME 51: `Clutter.get_default_backend()` is gone (use
`global.stage.context.get_backend()`), and a new virtual pointer first lands in
the top-left corner, which opened the overview until `shell-test.sh` turned
hot corners off.

## Releasing

1. Add the version to `CHANGELOG.md`, set `version-name` in
   `src/metadata.json` (its `description` is the text on extensions.gnome.org:
   name new features there), `make lint test`, the shell test.
2. Commit "Core Sentinel X.Y.Z: <what changed>", an annotated tag `vX.Y.Z`,
   push `main` and the tag. CI checks the tag against `version-name` and
   publishes the bundle as a GitHub release; then write its notes
   (`gh release edit vX.Y.Z --notes ...`, from the CHANGELOG entry).
3. `make pack` for the bundle to upload. If it hangs, the desktop's gvfs
   metadata daemon is stuck: `GIO_USE_VFS=local make pack` does not need it.

## Uploading to extensions.gnome.org

Run EGO's static analyzer on the bundle first (`uv` is installed;
`python3 -m venv` fails on Debian without `python3-venv`):
`uvx shexli dist/core-sentinel@mehdashti.github.io.shell-extension.zip`.
Shexli 0.2.1 reports every `shell-version` above 50 as an implausible future
release (EGO-M-004); that is out of date, EGO itself lists GNOME 51, and the
site's own Shexli passes 0.2.0.

The owner uploads at extensions.gnome.org/upload (account `mehdashti`): a
browser driven by Claude cannot attach a file from disk, and the two consent
boxes are the owner's. Uploading a version auto-rejects the previous one still
waiting for review ("Auto-rejected because of new version ... was uploaded");
that is normal. On the new version's review page, leave a note for the
reviewers on what needs justifying: the unlock-dialog session mode, and the
reading of other processes' `/proc/[pid]` files (see the note on 0.2.0).
