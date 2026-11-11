// SPDX-License-Identifier: GPL-2.0-or-later
// Print what Core Sentinel sees on this machine, without GNOME Shell:
//   gjs -m tools/snapshot.js [--json]
// Takes two samples one second apart (rates and CPU load need a delta) and
// runs the alert rules over the second one with default settings. Also reads
// the top processes, as the open menu does, and times both: wall time, and
// CPU time on the main thread, where the shell runs its JavaScript.

import GLib from 'gi://GLib';
import {Monitor} from '../src/lib/monitor.js';
import {ProcessSampler} from '../src/lib/processes.js';
import {buildChecks} from '../src/lib/alerts.js';
import {listDir, readText} from '../src/lib/io.js';

const DEFAULT_ALERTS = {
    alertFan: true, fanStallPwm: 20, fanStallSeconds: 10, alertTemp: true,
    alertDisk: true, diskFreePercent: 10, alertSwap: true, swapAlertMiB: 1024,
    alertThrash: true, thrashPercent: 10, cpuPressurePercent: 0, ioPressurePercent: 0,
};

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const gib = n => `${(n / GiB).toFixed(1)} GiB`;

/** @returns {Promise<number>} CPU time of a thread of this process, in ms */
async function threadMs(tid) {
    const text = await readText(`/proc/self/task/${tid}/schedstat`);
    return text === null ? 0 : Number(text.split(' ')[0]) / 1e6;
}

/** @returns {Promise<{wall: number, main: number, all: number}>} ms taken by fn */
async function timed(fn) {
    const tids = async () => (await listDir('/proc/self/task')).filter(t => /^\d+$/.test(t));
    const all = async () => (await Promise.all((await tids()).map(threadMs))).reduce((a, b) => a + b, 0);
    const pid = (await readText('/proc/self/stat')).split(' ')[0];
    const [main0, all0, t0] = [await threadMs(pid), await all(), GLib.get_monotonic_time()];
    const result = await fn();
    const wall = (GLib.get_monotonic_time() - t0) / 1000;
    return {result, wall, main: await threadMs(pid) - main0, all: await all() - all0};
}

async function main() {
    const monitor = new Monitor();
    const processes = new ProcessSampler();
    await monitor.init();
    await monitor.sample();
    await processes.sample();
    await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
    const tick = await timed(() => monitor.sample());
    const procs = await timed(() => processes.sample());
    const snap = tick.result;

    if (ARGV.includes('--json')) {
        print(JSON.stringify({...snap, processes: procs.result},
            (k, v) => v instanceof Map ? Object.fromEntries(v) : v, 2));
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
    for (const p of procs.result.cpu)
        print(`Process  cpu ${p.name.padEnd(16)} ${String(p.pid).padStart(7)} ${p.share.toFixed(1)}% of the physical-core load`);
    for (const p of procs.result.memory)
        print(`Process  mem ${p.name.padEnd(16)} ${String(p.pid).padStart(7)} ${(p.memory / MiB).toFixed(0)} MiB private (resident ${(p.rss / MiB).toFixed(0)} MiB)`);
    const ms = t => `${t.wall.toFixed(1)} ms (CPU: ${t.main.toFixed(1)} ms main thread, ${t.all.toFixed(1)} ms all threads)`;
    print(`Timing   readings ${ms(tick)}`);
    print(`Timing   ${procs.result.processes} processes ${ms(procs)}`);
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    printerr(e.stack ?? e);
}).finally(() => loop.quit());
loop.run();
