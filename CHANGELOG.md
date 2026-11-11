# Changelog

All notable changes to Core Sentinel. Releases with their bundles are on
[GitHub](https://github.com/mehdashti/core-sentinel/releases).

## 0.2.0 (2026-11-11)

- **Recent alerts** in the menu: the last 20 alerts with when each began and
  ended, so after unlocking you see what happened while you were away. An
  alert still on reads "since …"; one that ended because its rule was switched
  off or its sensor hidden reads "no longer watched". Clear removes the ended
  ones.
- **The processes behind the load**: the Processor group lists the five
  busiest processes by CPU (shares of the physical-core load), the Memory group
  the five with the most private memory, each with its PID. Read only while
  one of the two groups is open. Per-process disk I/O is left out: the kernel
  shows it only for the user's own processes.
- **A compact menu**: one row per group (Processor, Memory, Storage, Graphics,
  Temperatures, Fans, Voltages and power) whose title sums it up and turns red
  while one of its alerts is on; a click opens the details. Closed, the menu is
  about 400 px tall instead of about 930.
- CI runs the headless GNOME Shell test on the newest Fedora at every push and
  on Fedora rawhide weekly, to catch a new GNOME version before users do.

## 0.1.2 (2026-11-11)

- Switching an alert rule off, hiding its sensor or leaving its filesystem out
  now takes its notification back too. Before, the alert ended but its
  notification stayed, so the switch seemed to do nothing until the next
  login.
- Settings apply at once instead of at the next reading.

## 0.1.1 (2026-11-11)

- GNOME Shell 51 support. On GNOME 51, 0.1.0 shows as out of date and cannot
  be switched on.

## 0.1.0 (2026-10-03)

First release.

- CPU load over physical cores (SMT sibling threads merged), pressure (PSI) for
  CPU, memory and I/O, memory without page cache with zram and swap on disk
  apart, filesystems and disk I/O, AMD GPU load and VRAM, every hwmon sensor.
- Alerts as notifications: stalled or stopped fans, hot sensors, nearly full
  disks, memory spilling to disk, thrashing; with grace periods and hysteresis.
- Keeps watching while the screen is locked; the top-bar button is hidden
  there.
- Fans never seen spinning are treated as not connected; per-sensor names,
  hiding and limits; sensors keyed by bus address, not probe order.
- English and Persian, with locale digits and right-to-left layout.
