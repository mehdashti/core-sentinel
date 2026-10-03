// SPDX-License-Identifier: GPL-2.0-or-later
// Print what Core Sentinel sees on this machine, without GNOME Shell:
//   gjs -m tools/snapshot.js [--json]
// Takes two samples one second apart (rates and CPU load need a delta) and
// runs the alert rules over the second one with default settings.

import GLib from 'gi://GLib';
import {Monitor} from '../src/lib/monitor.js';
import {buildChecks} from '../src/lib/alerts.js';

const DEFAULT_ALERTS = {
    alertFan: true, fanStallPwm: 20, fanStallSeconds: 10, alertTemp: true,
    alertDisk: true, diskFreePercent: 10, alertSwap: true, swapAlertMiB: 1024,
    alertThrash: true, thrashPercent: 10, cpuPressurePercent: 0, ioPressurePercent: 0,
};

const GiB = 1024 ** 3;
const gib = n => `${(n / GiB).toFixed(1)} GiB`;

async function main() {
    const monitor = new Monitor();
    await monitor.init();
    await monitor.sample();
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    const snap = await monitor.sample();

    if (ARGV.includes('--json')) {
        print(JSON.stringify(snap, (k, v) => v instanceof Map ? Object.fromEntries(v) : v, 2));
        return;
    }

    const {cpu, pressure, memory, storage} = snap;
    print(`CPU      real ${cpu.real.toFixed(1)}%  logical ${cpu.logical.toFixed(1)}%  ` +
        `(${cpu.cores} cores / ${cpu.threads} threads)`);
    for (const r of ['cpu', 'memory', 'io'])
        print(`PSI      ${r.padEnd(7)} some ${pressure[r]?.some?.avg10}  full ${pressure[r]?.full?.avg10}`);
    print(`Memory   used ${gib(memory.used)} of ${gib(memory.total)}, available ${gib(memory.available)}`);
    if (memory.zram)
        print(`zram     ${gib(memory.zram.used)} of ${gib(memory.zram.size)}, ratio ${memory.zram.ratio?.toFixed(2) ?? '-'}`);
    if (memory.diskSwap)
        print(`swap     on disk ${gib(memory.diskSwap.used)} of ${gib(memory.diskSwap.size)}`);
    for (const fs of storage.filesystems)
        print(`FS       ${fs.mountpoint.padEnd(12)} ${fs.percent.toFixed(0)}% used, ${gib(fs.free)} free (${fs.fstype})`);
    for (const d of storage.disks)
        print(`Disk     ${d.name} read ${(d.readBps / 1024).toFixed(0)} KiB/s write ${(d.writeBps / 1024).toFixed(0)} KiB/s busy ${d.busy.toFixed(1)}%`);
    for (const g of snap.gpus)
        print(`GPU      ${g.slot} ${g.name}: busy ${g.busy}% VRAM ${g.vramUsed === null ? '-' : gib(g.vramUsed)}${g.asleep ? ' (asleep)' : ''}`);
    for (const chip of snap.chips) {
        for (const ch of chip.channels) {
            const r = chip.values.get(ch.key);
            const pwm = r?.pwm === null || r?.pwm === undefined ? '' : ` pwm ${r.pwm}%`;
            const lim = ch.limit ? ` limit ${ch.limit}` : '';
            print(`Sensor   ${chip.category.padEnd(8)} ${ch.key.padEnd(40)} ${ch.label.padEnd(10)} ${r?.value ?? '-'}${pwm}${lim}`);
        }
    }
    const {checks, spinning} = buildChecks(snap, {
        overrides: {}, knownFans: new Set(), settings: DEFAULT_ALERTS,
        labelOf: (chip, ch) => `${chip.name} ${ch.label}`,
    });
    print(`Checks   ${checks.length} (${checks.filter(c => c.bad).length} bad now): ` +
        checks.filter(c => c.bad).map(c => c.key).join(', '));
    print(`Spinning ${spinning.join(', ')}`);
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    printerr(e.stack ?? e);
}).finally(() => loop.quit());
loop.run();
