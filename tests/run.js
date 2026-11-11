// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the pure parts of Core Sentinel:  gjs -m tests/run.js

import GLib from 'gi://GLib';
import System from 'system';

import {parseCpuList, parseProcStat, busyPercent, groupCores, coreLoads} from '../src/lib/cpu.js';
import {parsePressure} from '../src/lib/pressure.js';
import {parseMeminfo, parseSwaps, parseZramMmStat, summarize} from '../src/lib/memory.js';
import {parseMounts, parseDiskstats, diskRates} from '../src/lib/storage.js';
import {pciDeviceName, shortGpuName} from '../src/lib/gpu.js';
import {categoryOf, findChannels, plausibleTempLimit, plausibleTemp, stableDeviceId, stableChipName, uniqueKeys,
    mapChips} from '../src/lib/hwmon.js';
import {AlertEngine, SpinTracker, buildChecks} from '../src/lib/alerts.js';
import {AlertHistory} from '../src/lib/history.js';
import {parseOverrides, withOverride} from '../src/lib/overrides.js';
import {fmt, formatBytes, formatId, formatNumber, formatPercent, formatReading, formatTime, meter, truncate,
    setNumberLocale}
    from '../src/lib/format.js';
import {makeLabels} from '../src/lib/labels.js';
import {readText, readTexts, pendingReads} from '../src/lib/io.js';
import {parsePidStat, safeName, statusBytes, pageSizeFrom, cpuShares, busyTicksBetween, largestPrivate,
    ProcessSampler} from '../src/lib/processes.js';

// Numbers read the same on every machine; Persian has a test of its own.
setNumberLocale('en-US');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        passed++;
    } catch (e) {
        failed++;
        printerr(`FAIL ${name}\n     ${e.message}`);
    }
}

function eq(actual, expected, what = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b)
        throw new Error(`${what} expected ${b}, got ${a}`);
}

function near(actual, expected, what = '', eps = 1e-6) {
    if (Math.abs(actual - expected) > eps)
        throw new Error(`${what} expected ${expected}, got ${actual}`);
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

// ---------------------------------------------------------------- cpu
test('parseCpuList expands ranges', () => {
    eq(parseCpuList('0-3,8,10-11\n'), [0, 1, 2, 3, 8, 10, 11]);
    eq(parseCpuList('0'), [0]);
    eq(parseCpuList(''), []);
});

test('parseProcStat reads per-cpu lines only; idle includes iowait', () => {
    const stats = parseProcStat('cpu  10 0 10 80 0 0 0 0 0 0\n' +
        'cpu0 5 0 5 30 10 0 0 0 7 0\ncpu1 5 0 5 40 0 0 0 0 0 0\nintr 1 2 3\n');
    eq(stats.size, 2);
    eq(stats.get(0), {total: 50, idle: 40}, 'guest columns excluded:');
});

test('busyPercent between two samples', () => {
    const prev = new Map([[0, {total: 100, idle: 80}], [1, {total: 100, idle: 100}]]);
    const cur = new Map([[0, {total: 200, idle: 130}], [1, {total: 100, idle: 100}]]);
    const busy = busyPercent(prev, cur);
    near(busy.get(0), 50);
    eq(busy.get(1), 0, 'no elapsed time:');
});

test('groupCores pairs SMT siblings', () => {
    const cores = groupCores([
        {cpu: 0, pkg: 0, core: 0}, {cpu: 1, pkg: 0, core: 1},
        {cpu: 2, pkg: 0, core: 0}, {cpu: 3, pkg: 0, core: 1},
    ]);
    eq(cores, [[0, 2], [1, 3]]);
});

test('coreLoads: physical vs logical average, capped at 100', () => {
    const cores = [[0, 2], [1, 3]];
    const loads = coreLoads(cores, new Map([[0, 100], [2, 0], [1, 30], [3, 40]]));
    eq(loads.perCore.map(c => c.percent), [100, 70]);
    near(loads.real, 85);
    near(loads.logical, 42.5);
    eq(coreLoads([[0, 1]], new Map([[0, 80], [1, 60]])).perCore[0].percent, 100);
});

// ----------------------------------------------------------- pressure
test('parsePressure reads some and full', () => {
    const p = parsePressure('some avg10=1.50 avg60=0.25 avg300=0.00 total=123\n' +
        'full avg10=0.00 avg60=0.00 avg300=0.00 total=0\n');
    eq(p.some.avg10, 1.5);
    eq(p.some.total, 123);
    eq(p.full.avg60, 0);
});

// ------------------------------------------------------------- memory
test('parseMeminfo converts kB to bytes and keeps (anon) names', () => {
    const m = parseMeminfo('MemTotal:       32000000 kB\nMemAvailable:   16000000 kB\n' +
        'Active(anon):     1000 kB\nHugePages_Total:       0\n');
    eq(m.MemTotal, 32000000 * 1024);
    eq(m['Active(anon)'], 1000 * 1024);
    eq(m.HugePages_Total, 0);
});

const SWAPS = 'Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n' +
    '/swapfile                               file\t\t16777212\t1024\t\t-2\n' +
    '/dev/zram0                              partition\t12582908\t2048\t\t100\n';

test('parseSwaps', () => {
    const swaps = parseSwaps(SWAPS);
    eq(swaps.length, 2);
    eq(swaps[0], {name: '/swapfile', type: 'file', size: 16777212 * 1024, used: MiB, priority: -2});
});

test('summarize splits zram from swap on disk; used excludes page cache', () => {
    const meminfo = {MemTotal: 32 * GiB, MemAvailable: 24 * GiB, MemFree: 2 * GiB};
    const zram = parseZramMmStat(`${4 * MiB} ${MiB} ${1.25 * MiB} 0 0 0 0 0 0`);
    const s = summarize(meminfo, parseSwaps(SWAPS), [zram]);
    eq(s.used, 8 * GiB);
    eq(s.zram.used, 2 * MiB);
    near(s.zram.ratio, 4);
    eq(s.diskSwap, {size: 16777212 * 1024, used: MiB});
});

test('summarize: no ratio for a nearly empty zram device', () => {
    const s = summarize({MemTotal: GiB, MemAvailable: GiB}, parseSwaps(SWAPS),
        [parseZramMmStat('4096 59 20480 0 0 0 0 0 0')]);
    eq(s.zram.ratio, null);
});

// ------------------------------------------------------------ storage
test('parseMounts: block devices once, shortest mount point, escapes decoded', () => {
    const mounts = parseMounts([
        '/dev/nvme0n1p5 /var/lib/docker/x ext4 rw 0 0',
        '/dev/nvme0n1p5 / ext4 rw 0 0',
        '/dev/nvme0n1p4 /boot/efi vfat rw 0 0',
        '/dev/loop0 /snap/x squashfs ro 0 0',
        'overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0',
        '/dev/sdb1 /media/My\\040Disk ext4 rw 0 0',
        'tmpfs /tmp tmpfs rw 0 0',
        '/dev/zram1 /mnt/z ext4 rw 0 0',
    ].join('\n'));
    eq(mounts.map(m => m.mountpoint), ['/', '/boot/efi', '/media/My Disk']);
});

test('parseDiskstats keeps whole disks; diskRates computes throughput and busy', () => {
    const line = (name, rs, ws, ticks) => ` 259 0 ${name} 1 0 ${rs} 0 1 0 ${ws} 0 0 ${ticks} 0 0 0 0 0`;
    const prev = parseDiskstats([line('nvme0n1', 2000, 4000, 300), line('nvme0n1p1', 5, 5, 5)].join('\n'));
    eq([...prev.keys()], ['nvme0n1']);
    const cur = parseDiskstats(line('nvme0n1', 4048, 4000, 800));
    const [rate] = diskRates(prev, cur, 1);
    eq(rate.readBps, 2048 * 512);
    eq(rate.writeBps, 0);
    near(rate.busy, 50);
});

// ---------------------------------------------------------------- gpu
const PCI_IDS = '# pci.ids\n' +
    '1002  Advanced Micro Devices, Inc. [AMD/ATI]\n' +
    '\t699f  Lexa PRO [Radeon 540/540X/550/550X / RX 540X/550/550X]\n' +
    '\t\t1028 1234  Some subsystem\n' +
    '\t164e  Raphael\n' +
    '1022  Advanced Micro Devices, Inc. [AMD]\n' +
    '\t699f  Not this one\n';

test('pciDeviceName looks within the vendor block only', () => {
    eq(pciDeviceName(PCI_IDS, '1002', '699f'), 'Lexa PRO [Radeon 540/540X/550/550X / RX 540X/550/550X]');
    eq(pciDeviceName(PCI_IDS, '1002', '164e'), 'Raphael');
    eq(pciDeviceName(PCI_IDS, '1022', '699f'), 'Not this one');
    eq(pciDeviceName(PCI_IDS, '1002', 'ffff'), null);
    eq(pciDeviceName(PCI_IDS, 'abcd', '699f'), null);
});

test('shortGpuName: bracketed marketing name, retail line only', () => {
    eq(shortGpuName('Lexa PRO [Radeon 550]'), 'Radeon 550');
    eq(shortGpuName('Lexa PRO [Radeon 540/540X/550/550X / RX 540X/550/550X]'), 'RX 540X/550/550X');
    eq(shortGpuName('Raphael'), 'Raphael');
});

// -------------------------------------------------------------- hwmon
test('categoryOf', () => {
    const cases = {
        k10temp: 'cpu', coretemp: 'cpu', it8689: 'board', nct6798: 'board', gigabyte_wmi: 'board',
        amdgpu: 'gpu', nvme: 'storage', spd5118: 'memory', mt7921_phy0: 'network',
        'r8169_0_e00:00': 'network', mystery: 'other',
    };
    for (const [name, category] of Object.entries(cases))
        eq(categoryOf(name), category, `${name}:`);
});

test('findChannels: ordered, power average preferred over input', () => {
    const channels = findChannels(['name', 'in0_input', 'power1_input', 'power1_average',
        'fan1_input', 'pwm1', 'temp2_input', 'temp1_input', 'temp1_label']);
    eq(channels.map(c => c.input), ['temp1_input', 'temp2_input', 'fan1_input', 'power1_average', 'in0_input']);
});

test('stableDeviceId: probe-order numbers give way to bus addresses', () => {
    const pci = '/sys/devices/pci0000:00';
    const cases = {
        [`${pci}/0000:00:01.2/0000:02:00.0/nvme/nvme0`]: '0000:02:00.0',
        [`${pci}/0000:00:02.1/0000:0b:07.0/0000:0f:00.0/ieee80211/phy0`]: '0000:0f:00.0',
        [`${pci}/0000:00:14.0/i2c-2/2-0051`]: '0000:00:14.0/0051',
        [`${pci}/0000:00:14.0/i2c-12/12-0051`]: '0000:00:14.0/0051',
        '/sys/devices/platform/AMDI0010:00/i2c-0/0-0050': 'AMDI0010:00/0050',
        // already named by address: unchanged
        [`${pci}/0000:00:01.1/0000:01:00.0`]: '0000:01:00.0',
        '/sys/devices/platform/it87.2624': 'it87.2624',
        '/sys/devices/virtual/thermal/thermal_zone0': 'thermal_zone0',
        [`${pci}/0000:00:02.1/0000:0e:00.0/mdio_bus/r8169-0-e00/r8169-0-e00:00`]: 'r8169-0-e00:00',
        '/sys/devices/platform/PNP0C14:00/wmi_bus/wmi_bus-PNP0C14:00/DEADBEEF-2001-0000-00A0-C90629100000-2':
            'DEADBEEF-2001-0000-00A0-C90629100000-2',
    };
    for (const [path, id] of Object.entries(cases))
        eq(stableDeviceId(path), id, `${path}:`);
});

test('stableChipName drops probe-order suffixes; uniqueKeys numbers repeats', () => {
    eq(['mt7921_phy0', 'iwlwifi_1', 'r8169_0_e00:00', 'amdgpu', 'nct6798'].map(stableChipName),
        ['mt7921', 'iwlwifi', 'r8169_0_e00:00', 'amdgpu', 'nct6798']);
    eq(uniqueKeys(['a', 'b', 'a', 'a']), ['a', 'b', 'a#2', 'a#3']);
});

test('plausible temperatures and limits', () => {
    eq(plausibleTempLimit(127), null);
    eq(plausibleTempLimit(0), null);
    eq(plausibleTempLimit(84.85), 84.85);
    eq(plausibleTemp(0), false);
    eq(plausibleTemp(-128), false);
    eq(plausibleTemp(127), false);
    eq(plausibleTemp(43.25), true);
});

// ------------------------------------------------------------- alerts
const ALERT_SETTINGS = {
    alertFan: true, fanStallPwm: 20, fanStallSeconds: 10, alertTemp: true,
    alertDisk: true, diskFreePercent: 10, alertSwap: true, swapAlertMiB: 1024,
    alertThrash: true, thrashPercent: 10, cpuPressurePercent: 0, ioPressurePercent: 0,
};

function snapshot({fans = [], temps = [], filesystems = [], diskSwapUsed = null, memFull = null} = {}) {
    const channels = [];
    const values = new Map();
    for (const f of fans) {
        channels.push({key: f.key, kind: 'fan', label: f.key, limit: null});
        values.set(f.key, {value: f.rpm, pwm: f.pwm ?? null});
    }
    for (const t of temps) {
        channels.push({key: t.key, kind: 'temp', label: t.key, limit: t.limit ?? null});
        values.set(t.key, {value: t.value, pwm: null});
    }
    return {
        chips: [{key: 'chip', category: 'board', asleep: false, channels, values}],
        storage: {filesystems},
        memory: diskSwapUsed === null ? null : {diskSwap: {size: 16 * GiB, used: diskSwapUsed}},
        pressure: memFull === null ? null : {memory: {some: {avg10: memFull}, full: {avg10: memFull}}},
    };
}

function checksFor(snap, {overrides = {}, known = [], settings = ALERT_SETTINGS} = {}) {
    return buildChecks(snap, {
        overrides, knownFans: new Set(known), settings, labelOf: (chip, ch) => ch.label,
    });
}

test('a fan never seen spinning is not connected: no check, not reported as spinning', () => {
    const {checks, spinning} = checksFor(snapshot({fans: [{key: 'fan4', rpm: 0, pwm: 25}]}));
    eq(checks.length, 0);
    eq(spinning, []);
});

test('a spinning fan is reported so it can be remembered', () => {
    const {spinning} = checksFor(snapshot({fans: [{key: 'fan1', rpm: 900, pwm: 30}]}));
    eq(spinning, ['fan1']);
});

test('SpinTracker: a fan counts as connected only after spinning without a break', () => {
    const tracker = new SpinTracker();
    eq(tracker.update(['f'], 0, 10), []);
    eq(tracker.update(['f'], 5, 10), []);
    eq(tracker.update([], 6, 10), [], 'a moment of noise:');
    eq(tracker.update(['f'], 8, 10), []);
    eq(tracker.update(['f'], 17, 10), [], 'the clock restarted at 8:');
    eq(tracker.update(['f'], 18, 10), ['f']);
});

test('known fan at 0 RPM while driven: stall raised only after the grace period, cleared when it spins', () => {
    const engine = new AlertEngine();
    const stalled = checksFor(snapshot({fans: [{key: 'fan1', rpm: 0, pwm: 30}]}), {known: ['fan1']}).checks;
    eq(engine.update(stalled, 100).raised.length, 0);
    eq(engine.update(stalled, 105).raised.length, 0);
    const {raised} = engine.update(stalled, 110);
    eq(raised.map(a => [a.key, a.type]), [['fan:fan1', 'fan-stall']]);
    eq(engine.update(stalled, 115).raised.length, 0, 'raised once:');
    const spinning = checksFor(snapshot({fans: [{key: 'fan1', rpm: 800, pwm: 30}]}), {known: ['fan1']}).checks;
    eq(engine.update(spinning, 120).cleared.map(a => a.key), ['fan:fan1']);
    eq(engine.active.length, 0);
});

test('a brief stop shorter than the grace period never alerts', () => {
    const engine = new AlertEngine();
    const stalled = checksFor(snapshot({fans: [{key: 'fan1', rpm: 0, pwm: 30}]}), {known: ['fan1']}).checks;
    const ok = checksFor(snapshot({fans: [{key: 'fan1', rpm: 700, pwm: 30}]}), {known: ['fan1']}).checks;
    engine.update(stalled, 0);
    engine.update(ok, 5);
    eq(engine.update(stalled, 12).raised.length, 0, 'timer restarted:');
});

test('a fan the controller slowed below the stall threshold may stop', () => {
    const {checks} = checksFor(snapshot({fans: [{key: 'fan1', rpm: 0, pwm: 10}]}), {known: ['fan1']});
    eq(checks[0].bad, false);
});

test('fan without PWM: a stop is bad unless marked zero-RPM', () => {
    const snap = snapshot({fans: [{key: 'gpu', rpm: 0, pwm: null}]});
    eq(checksFor(snap, {known: ['gpu']}).checks[0].bad, true);
    eq(checksFor(snap, {known: ['gpu']}).checks[0].type, 'fan-stopped');
    eq(checksFor(snap, {known: ['gpu'], overrides: {gpu: {zeroRpm: true}}}).checks[0].bad, false);
});

test('minimum RPM check', () => {
    const {checks} = checksFor(snapshot({fans: [{key: 'fan1', rpm: 500, pwm: 40}]}),
        {known: ['fan1'], overrides: {fan1: {minRpm: 800}}});
    const low = checks.find(c => c.type === 'fan-low');
    eq(low.bad, true);
    eq(low.params.min, 800);
});

test('temperature: hold time, then hysteresis before it clears', () => {
    const engine = new AlertEngine();
    const at = v => checksFor(snapshot({temps: [{key: 'gpu', value: v, limit: 80}]})).checks;
    eq(engine.update(at(85), 0).raised.length, 0);
    eq(engine.update(at(86), 5).raised.length, 1);
    eq(engine.update(at(77), 10).cleared.length, 0, 'still within 5 °C of the limit:');
    eq(engine.update(at(74), 15).cleared.length, 1);
});

test('temperature: a user limit overrides the hardware one; no limit means no check', () => {
    const snap = snapshot({temps: [{key: 'cpu', value: 65, limit: null}, {key: 'nvme', value: 50, limit: 84}]});
    eq(checksFor(snap).checks.map(c => c.key), ['temp:nvme']);
    const custom = checksFor(snap, {overrides: {cpu: {maxTemp: 60}}}).checks;
    eq(custom.find(c => c.key === 'temp:cpu').bad, true);
});

test('hidden sensors are not checked, and their alert is dropped without a recovery event', () => {
    const engine = new AlertEngine();
    const snap = snapshot({temps: [{key: 'hot', value: 99, limit: 80}]});
    engine.update(checksFor(snap).checks, 0);
    engine.update(checksFor(snap).checks, 10);
    eq(engine.active.length, 1);
    const hidden = checksFor(snap, {overrides: {hot: {hidden: true}}}).checks;
    eq(hidden.length, 0);
    const {raised, cleared, dropped} = engine.update(hidden, 20);
    eq([raised.length, cleared.length], [0, 0]);
    eq(dropped.map(a => a.key), ['temp:hot'], 'its notification must be taken back:');
    eq(engine.active.length, 0);
});

test('switching a rule off drops its active alert; switching it on again raises it anew', () => {
    const engine = new AlertEngine();
    const snap = snapshot({filesystems: [{mountpoint: '/', free: GiB, freePercent: 3}]});
    eq(engine.update(checksFor(snap).checks, 0).raised.length, 1);
    const off = checksFor(snap, {settings: {...ALERT_SETTINGS, alertDisk: false}}).checks;
    eq(engine.update(off, 1).dropped.map(a => a.key), ['disk:/']);
    eq(engine.update(off, 2).dropped.length, 0, 'dropped once:');
    eq(engine.update(checksFor(snap).checks, 3).raised.length, 1);
});

test('disk space: immediate, with a 2-point recovery margin', () => {
    const engine = new AlertEngine();
    const at = freePercent => checksFor(snapshot({filesystems: [{mountpoint: '/', free: GiB, freePercent}]})).checks;
    eq(engine.update(at(5), 0).raised.length, 1);
    eq(engine.update(at(11), 1).cleared.length, 0);
    eq(engine.update(at(12.5), 2).cleared.length, 1);
});

test('a filesystem meant to stay nearly full can be left out', () => {
    const snap = snapshot({filesystems: [
        {mountpoint: '/', free: GiB, freePercent: 5},
        {mountpoint: '/boot/efi', free: MiB, freePercent: 3},
    ]});
    const settings = {...ALERT_SETTINGS, diskIgnore: new Set(['/boot/efi'])};
    eq(checksFor(snap, {settings}).checks.map(c => c.key), ['disk:/']);
});

test('swap on disk and thrashing', () => {
    const engine = new AlertEngine();
    const swap = checksFor(snapshot({diskSwapUsed: 2 * GiB})).checks;
    eq(engine.update(swap, 0).raised.map(a => a.type), ['swap']);
    const thrash = checksFor(snapshot({memFull: 30})).checks;
    eq(engine.update(thrash, 1).raised.length, 0, 'thrash needs 10 s:');
    eq(engine.update(thrash, 11).raised.map(a => a.type), ['thrash']);
});

test('switched-off rules produce no checks', () => {
    const off = {...ALERT_SETTINGS, alertFan: false, alertTemp: false, alertDisk: false, alertSwap: false, alertThrash: false};
    const snap = snapshot({
        fans: [{key: 'f', rpm: 0, pwm: 90}], temps: [{key: 't', value: 99, limit: 80}],
        filesystems: [{mountpoint: '/', free: 0, freePercent: 0}], diskSwapUsed: 9 * GiB, memFull: 90,
    });
    eq(checksFor(snap, {known: ['f'], settings: off}).checks.length, 0);
});

// ------------------------------------------------------------ history
// Wall-clock times are built in local time, so the tests read the same in any time zone.
const T0 = new Date(2026, 10, 11, 3, 12).getTime();
const MIN = 60 * 1000;

/** Runs AlertEngine and AlertHistory together, as extension.js does; `t` is in minutes after T0. */
function historyRig(limit) {
    const engine = new AlertEngine();
    const history = new AlertHistory(limit);
    return {
        engine,
        history,
        tick(t, checks) {
            const events = engine.update(checks, t * 60);
            history.update(events, T0 + t * MIN, t * 60);
        },
    };
}

const diskAt = (freePercent, mountpoint = '/') =>
    checksFor(snapshot({filesystems: [{mountpoint, free: GiB, freePercent}]})).checks;

test('history: a clear is paired with its raise; an alert still on has no end', () => {
    const rig = historyRig();
    rig.tick(0, diskAt(5));
    eq(rig.history.entries.map(e => [e.key, e.start, e.end]), [['disk:/', T0, null]]);
    rig.tick(1, diskAt(8));
    eq(rig.history.entries[0].end, null, 'not recovered yet:');
    rig.tick(2, diskAt(20));
    eq(rig.history.entries.map(e => [e.start, e.end]), [[T0, T0 + 2 * MIN]]);
    rig.tick(3, diskAt(4));
    eq(rig.history.entries.map(e => [e.start, e.end]), [[T0 + 3 * MIN, null], [T0, T0 + 2 * MIN]],
        'raised again: a new entry, newest first:');
});

test('history: the start is when the condition began, before its hold time', () => {
    const rig = historyRig();
    const hot = value => checksFor(snapshot({temps: [{key: 'cpu', value, limit: 80}]})).checks;
    rig.tick(0, hot(90));
    eq(rig.history.entries.length, 0, 'still within the hold time:');
    rig.tick(0.5, hot(91));
    eq(rig.history.entries.map(e => [e.type, e.start, e.params.label]), [['temp', T0, 'cpu']]);
});

test('history: an alert whose subject is no longer watched ends, marked as dropped', () => {
    const rig = historyRig();
    rig.tick(0, [...diskAt(5, '/media/usb'), ...diskAt(5)]);
    rig.tick(1, diskAt(20)); // unplugged; / recovered
    eq(rig.history.entries.map(e => [e.key, e.end, e.dropped]),
        [['disk:/media/usb', T0 + MIN, true], ['disk:/', T0 + MIN, false]]);
});

test('history: bounded, dropping the oldest ended alerts but never one still on', () => {
    const rig = historyRig(3);
    rig.tick(0, [...diskAt(5, '/a'), ...diskAt(50, '/b')]); // /a stays full throughout
    for (let t = 1; t <= 4; t++) {
        rig.tick(t, [...diskAt(5, '/a'), ...diskAt(5, '/b')]);
        rig.tick(t + 0.5, [...diskAt(5, '/a'), ...diskAt(50, '/b')]);
    }
    eq(rig.history.entries.map(e => [e.key, e.start]), [
        ['disk:/b', T0 + 4 * MIN], ['disk:/b', T0 + 3 * MIN], ['disk:/a', T0],
    ]);
    eq(rig.history.entries[2].end, null);
});

test('history: Clear forgets the alerts that ended and keeps those still on', () => {
    const rig = historyRig();
    rig.tick(0, [...diskAt(5, '/a'), ...diskAt(5, '/b')]);
    rig.tick(1, [...diskAt(5, '/a'), ...diskAt(50, '/b')]);
    rig.history.clear();
    eq(rig.history.entries.map(e => e.key), ['disk:/a']);
    rig.tick(2, diskAt(50, '/a'));
    eq(rig.history.entries.map(e => e.end), [T0 + 2 * MIN], 'a kept alert still gets its end:');
});

test('history lines: still on, ended, within one minute, no longer watched', () => {
    const labels = makeLabels(s => s);
    const entry = (start, end) => ({type: 'fan-stopped', params: {label: 'Fan 2'}, start, end});
    const title = '\u2068Fan stopped: Fan 2\u2069'; // isolated, for right-to-left lines
    const opts = {now: T0 + 10 * MIN};
    eq(labels.historyLine(entry(T0, null), opts), `${title}, since 03:12`);
    eq(labels.historyLine(entry(T0, T0 + 2 * MIN), opts), `${title}, 03:12 to 03:14`);
    eq(labels.historyLine(entry(T0, T0 + 20 * 1000), opts), `${title}, at 03:12`);
    const tomorrow = {now: T0 + 24 * 60 * MIN};
    eq(labels.historyLine(entry(T0, T0 + 2 * MIN), tomorrow), `${title}, Nov 11, 03:12 to 03:14`,
        'the date once:');
    eq(labels.historyLine(entry(T0, T0 + 20 * 1000), tomorrow), `${title}, at Nov 11, 03:12`);
    const lateNight = new Date(2026, 10, 10, 23, 50).getTime();
    eq(labels.historyLine(entry(lateNight, T0), opts), `${title}, Nov 10, 23:50 to Nov 11, 03:12`,
        'past midnight:');
    const dropped = (start, end) => ({...entry(start, end), dropped: true});
    eq(labels.historyLine(dropped(T0, T0 + 2 * MIN), opts), `${title}, 03:12 to 03:14 (no longer watched)`);
    eq(labels.historyLine(dropped(T0, T0 + 20 * 1000), opts), `${title}, at 03:12 (no longer watched)`);
});

// ---------------------------------------------------------- overrides
test('withOverride stores only non-defaults', () => {
    let o = withOverride({}, 'k', 'hidden', true);
    eq(o, {k: {hidden: true}});
    o = withOverride(o, 'k', 'label', 'CPU fan');
    eq(o, {k: {hidden: true, label: 'CPU fan'}});
    o = withOverride(o, 'k', 'hidden', false);
    o = withOverride(o, 'k', 'label', '');
    eq(o, {});
});

test('parseOverrides tolerates garbage', () => {
    eq(parseOverrides('not json'), {});
    eq(parseOverrides('[]'), {});
    eq(parseOverrides('{"a":{"hidden":true}}'), {a: {hidden: true}});
});

// ---------------------------------------------------------- processes
// proc_pid_stat(5): pid (comm) state ppid pgrp session tty tpgid flags minflt
// cminflt majflt cmajflt utime stime cutime cstime priority nice threads
// itrealvalue starttime vsize rss ...
function pidStat(pid, comm, {flags = 4194560, utime = 0, stime = 0, start = 1000, rss = 0} = {}) {
    return `${pid} (${comm}) S 1 ${pid} ${pid} 0 -1 ${flags} 10 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 ` +
        `${start} 4096000 ${rss} 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0\n`;
}

test('parsePidStat: fields after the name, which may hold spaces and parentheses', () => {
    eq(parsePidStat(pidStat(42, 'Web Content', {utime: 120, stime: 30, start: 5000, rss: 2560})),
        {name: 'Web Content', kernel: false, ticks: 150, start: 5000, rssPages: 2560});
    eq(parsePidStat(pidStat(7, 'a) S 1 2 (b')).name, 'a) S 1 2 (b');
    eq(parsePidStat(pidStat(2, 'kthreadd', {flags: 0x208040})).kernel, true, 'PF_KTHREAD:');
    eq(parsePidStat('42 (truncated) S 1 2'), null);
    eq(parsePidStat(''), null);
});

test('safeName replaces control and formatting characters, keeps the rest', () => {
    eq(safeName('firefox-esr'), 'firefox-esr');
    eq(safeName('پایتون ۳'), 'پایتون ۳');
    eq(safeName('ok\n⚠ Fan stopped'), 'ok\uFFFD⚠ Fan stopped', 'a fake second row:');
    eq(safeName('\u202Eexe.txt'), '\uFFFDexe.txt', 'a bidi override:');
    eq(safeName('a\u200Bb\u2028c\u0007'), 'a\uFFFDb\uFFFDc\uFFFD');
});

test('statusBytes and pageSizeFrom', () => {
    const status = 'Name:\tfirefox\nVmRSS:\t  409600 kB\nRssAnon:\t  307200 kB\nRssFile:\t 1024 kB\n';
    eq(statusBytes(status, 'RssAnon'), 300 * MiB);
    eq(statusBytes(status, 'VmRSS'), 400 * MiB);
    eq(statusBytes('Name:\tkthreadd\n', 'RssAnon'), null, 'a kernel thread has none:');
    eq(pageSizeFrom(400 * MiB, 102400), 4096);
    eq(pageSizeFrom(400 * MiB + 12345, 102400), 4096, 'grown between the two reads:');
    eq(pageSizeFrom(400 * MiB, 25600), 16384);
    eq(pageSizeFrom(400 * MiB, 6400), 65536);
    eq(pageSizeFrom(0, 0), 4096);
});

test('busyTicksBetween sums busy ticks over all CPUs', () => {
    const prev = new Map([[0, {total: 100, idle: 80}], [1, {total: 100, idle: 100}]]);
    const cur = new Map([[0, {total: 300, idle: 130}], [1, {total: 300, idle: 250}], [2, {total: 50, idle: 0}]]);
    eq(busyTicksBetween(prev, cur), 150 + 50, 'a CPU without a previous reading is left out:');
});

test('cpuShares: a part of the physical-core load in proportion to CPU time', () => {
    const before = (start, ticks) => ({start, ticks});
    const prev = new Map([[10, before(500, 1000)], [11, before(500, 40)], [12, before(500, 0)], [13, null],
        [14, before(500, 70)]]);
    const procs = [
        {pid: 10, start: 500, ticks: 1200}, // +200
        {pid: 11, start: 500, ticks: 140}, // +100
        {pid: 12, start: 500, ticks: 0}, // idle: left out
        {pid: 13, start: 500, ticks: 9000}, // not read last time: unknown, left out
        {pid: 14, start: 900, ticks: 50}, // pid reused by a new process: all 50 count
        {pid: 15, start: 950, ticks: 50}, // new: all 50 count
    ];
    // 400 busy ticks in all; the physical-core load was 40%
    const shares = cpuShares(prev, procs, 400, 40);
    eq(shares.map(p => [p.pid, p.share]), [[10, 20], [11, 10], [14, 5], [15, 5]]);
    eq(cpuShares(prev, procs, 0, 40), [], 'no busy time:');
    eq(cpuShares(new Map(), [{pid: 1, start: 0, ticks: 99999}], 400, 40)[0].share, 40,
        'never more than the whole load:');
    eq(cpuShares(new Map([[1, before(0, 1000)]]), [{pid: 1, start: 0, ticks: 999}], 400, 40), [],
        'a counter that went back:');
});

test('cpuShares on an otherwise idle CPU: one busy thread is one physical core', () => {
    // 12 cores, 24 threads, 2 s at 100 ticks/s: one thread busy, everything else idle
    const shares = cpuShares(new Map([[1, {start: 0, ticks: 0}]]), [{pid: 1, start: 0, ticks: 200}],
        200, 100 / 12);
    near(shares[0].share, 100 / 12);
});

// ------------------------------------------------------------- format
test('fmt, bytes, percent, readings, meter, truncate', () => {
    eq(fmt('%s of %s (%d%%)', 'a', 'b', 5), 'a of b (5%)');
    eq(formatBytes(0), '0 B');
    eq(formatBytes(1536), '1.5 KiB');
    eq(formatBytes(150 * MiB), '150 MiB');
    eq(formatBytes(30.5 * GiB), '30.5 GiB');
    eq(formatBytes(null), '–');
    eq(formatPercent(12.345, 1), '12.3%');
    eq(formatReading('temp', 43.6), '44°C');
    eq(formatReading('fan', 958.4), '958 RPM');
    eq(formatReading('fan', 1076), '1,076 RPM');
    eq(formatNumber(2.46, 1), '2.5');
    eq(formatReading('in', 1.176), '1.18 V');
    eq(formatReading('power', 9.262), '9.3 W');
    eq(meter(30), '▰▰▰▱▱▱▱▱▱▱');
    eq(meter(150, 4), '▰▰▰▰');
    eq(truncate('abcdef', 4), 'abc…');
    eq(formatId(271689), '271689', 'no grouping:');
    eq(formatNumber(271689), '271,689');
});

test('formatTime: 24- or 12-hour clock, with the date when it is not today', () => {
    const plain = text => text.replace(/\s/g, ' '); // ICU puts a narrow no-break space before AM
    eq(formatTime(T0), '03:12');
    eq(plain(formatTime(T0, {hour12: true})), '3:12 AM');
    const lastNight = new Date(2026, 10, 10, 23, 50).getTime();
    eq(formatTime(lastNight, {now: T0}), 'Nov 10, 23:50');
    eq(formatTime(T0, {now: T0 + 5 * MIN}), '03:12', 'same day:');
});

test('numbers follow the locale: Persian digits, decimal separator and percent sign', () => {
    setNumberLocale('fa');
    try {
        eq(formatPercent(26), '۲۶٪');
        eq(formatBytes(1536), '۱٫۵ KiB');
        eq(fmt('%d cores', 12), '۱۲ cores');
        eq(formatReading('temp', 43.6), '۴۴°C');
        eq(formatTime(T0), '۰۳:۱۲');
        eq(formatId(271689), '۲۷۱۶۸۹');
    } finally {
        setNumberLocale('en-US');
    }
});

test('every alert type has a complete message', () => {
    const labels = makeLabels(s => s);
    const params = {label: 'X', rpm: 0, pwm: 30, min: 800, value: 90, limit: 80,
        mountpoint: '/', free: GiB, freePercent: 5, used: GiB};
    for (const type of ['fan-stall', 'fan-stopped', 'fan-low', 'temp', 'disk', 'swap', 'thrash',
        'cpu-pressure', 'io-pressure']) {
        const {title, body} = labels.alertMessage({type, params});
        if (!title || !body || /%[sd]/.test(title + body) || /undefined|NaN/.test(title + body))
            throw new Error(`${type}: "${title}" / "${body}"`);
    }
});

// ----------------------------------------------------------------- io
async function testAsync(name, fn) {
    try {
        await fn();
        passed++;
    } catch (e) {
        failed++;
        printerr(`FAIL ${name}\n     ${e.message}`);
    }
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function ioTests() {
    await testAsync('mapChips reads board chips one at a time, the others alongside', async () => {
        const chips = ['it8689', 'gigabyte_wmi', 'acpitz', 'amdgpu', 'k10temp'].map(name => ({name}));
        const active = {board: 0, other: 0};
        const peak = {board: 0, other: 0};
        const results = await mapChips(chips, async (chip, i) => {
            const kind = categoryOf(chip.name) === 'board' ? 'board' : 'other';
            peak[kind] = Math.max(peak[kind], ++active[kind]);
            await sleep(20);
            active[kind]--;
            return i;
        });
        eq(results, [0, 1, 2, 3, 4]);
        eq(peak, {board: 1, other: 2});
    });

    await testAsync('a read that never answers does not queue another one behind it', async () => {
        // a FIFO with no writer blocks open() like a hung driver blocks read()
        const dir = GLib.dir_make_tmp('core-sentinel-XXXXXX');
        const fifo = `${dir}/fifo`;
        GLib.spawn_command_line_sync(`mkfifo ${fifo}`);
        try {
            const stuck = readText(fifo);
            eq(pendingReads(), [fifo]);
            eq(await readText(fifo), null, 'second read while the first hangs:');
            GLib.spawn_command_line_sync(`sh -c 'echo ok > ${fifo}'`);
            eq(await stuck, 'ok\n', 'first read once answered:');
            eq(pendingReads(), []);
        } finally {
            GLib.spawn_command_line_sync(`rm -r ${dir}`);
        }
    });
}

async function processTests() {
    await testAsync('largestPrivate reads private memory only as far down as it can matter', async () => {
        // rss and private memory in MiB, largest rss first
        const table = [[1, 2000, 15], [2, 1600, 1500], [3, 1300, 1200], [4, 900, 800], [5, 800, 700],
            [6, 700, 650], [7, 600, 100], [8, 500, 450], [9, 400, 390], [10, 300, 290], [11, 0, 0]];
        const procs = table.map(([pid, rss]) => ({pid, rss: rss * MiB}));
        const read = [];
        const top = await largestPrivate(procs, 3, async proc => {
            read.push(proc.pid);
            await sleep(1);
            return proc.pid === 4 ? null : table[proc.pid - 1][2] * MiB; // 4 ended meanwhile
        });
        eq(top.map(p => [p.pid, p.memory / MiB]), [[2, 1500], [3, 1200], [5, 700]]);
        // rounds of 3: [1 2 3], [4 5 6]; then the 3rd largest (700) beats the next rss (600)
        eq(read, [1, 2, 3, 4, 5, 6]);
        eq(await largestPrivate(procs, 3, async () => null), [], 'nothing readable:');
        eq((await largestPrivate(procs.slice(0, 2), 3, async p => p.rss)).length, 2, 'fewer than asked:');
    });

    await testAsync('readTexts keeps at most `limit` reads in flight, in order, null where unreadable', async () => {
        const dir = GLib.dir_make_tmp('core-sentinel-XXXXXX');
        try {
            GLib.file_set_contents(`${dir}/a`, 'A');
            GLib.file_set_contents(`${dir}/b`, 'B');
            eq(await readTexts([`${dir}/a`, `${dir}/missing`, `${dir}/b`], 2), ['A', null, 'B']);
            eq(await readTexts([], 4), []);

            // FIFOs with no writer block like a hung file
            const fifos = [0, 1, 2].map(i => `${dir}/fifo${i}`);
            GLib.spawn_command_line_sync(`mkfifo ${fifos.join(' ')}`);
            const all = readTexts(fifos, 2);
            eq(pendingReads(), fifos.slice(0, 2), 'two in flight, the third waits:');
            GLib.spawn_command_line_sync(`sh -c 'echo 0 > ${fifos[0]}'`);
            await sleep(100);
            eq(pendingReads(), fifos.slice(1), 'the third starts once one is done:');
            eq(await readText(fifos[1]), null, 'a file still pending reads as null:');
            GLib.spawn_command_line_sync(`sh -c 'echo 1 > ${fifos[1]}; echo 2 > ${fifos[2]}'`);
            eq(await all, ['0\n', '1\n', '2\n']);
            eq(pendingReads(), []);
        } finally {
            GLib.spawn_command_line_sync(`rm -r ${dir}`);
        }
    });

    await testAsync('ProcessSampler on this machine: memory at once, CPU shares from the second reading', async () => {
        const self = Number(new TextDecoder().decode(GLib.file_get_contents('/proc/self/stat')[1]).split(' ')[0]);
        const sampler = new ProcessSampler({count: 50});
        const first = await sampler.sample();
        eq(first.cpu, null);
        if (first.processes < 1 || first.memory.length < 1)
            throw new Error(`read ${first.processes} processes, ${first.memory.length} by memory`);
        // burn some CPU so this process has a share to find
        const until = GLib.get_monotonic_time() + 300000;
        while (GLib.get_monotonic_time() < until)
            ;
        const second = await sampler.sample();
        if (!second.cpu?.length || second.cpu.some(p => !(p.share > 0 && p.share <= 100)))
            throw new Error(`cpu: ${JSON.stringify(second.cpu)}`);
        if (!second.cpu.some(p => p.pid === self))
            throw new Error(`this process is not among the busiest: ${second.cpu.map(p => p.name)}`);
        sampler.reset();
        eq((await sampler.sample()).cpu, null, 'after reset:');
    });
}

const loop = new GLib.MainLoop(null, false);
ioTests().then(processTests).finally(() => loop.quit());
loop.run();

print(`${passed} passed, ${failed} failed`);
if (failed > 0)
    System.exit(1);
