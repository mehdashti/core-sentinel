// SPDX-License-Identifier: GPL-2.0-or-later
// Unit tests for the pure parts of Core Sentinel:  gjs -m tests/run.js

import System from 'system';

import {parseCpuList, parseProcStat, busyPercent, groupCores, coreLoads} from '../src/lib/cpu.js';
import {parsePressure} from '../src/lib/pressure.js';
import {parseMeminfo, parseSwaps, parseZramMmStat, summarize} from '../src/lib/memory.js';
import {parseMounts, parseDiskstats, diskRates} from '../src/lib/storage.js';
import {pciDeviceName, shortGpuName} from '../src/lib/gpu.js';
import {categoryOf, findChannels, plausibleTempLimit, plausibleTemp} from '../src/lib/hwmon.js';
import {AlertEngine, buildChecks} from '../src/lib/alerts.js';
import {parseOverrides, withOverride} from '../src/lib/overrides.js';
import {fmt, formatBytes, formatPercent, formatReading, meter, truncate} from '../src/lib/format.js';
import {makeLabels} from '../src/lib/labels.js';

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

test('hidden sensors are not checked, and their alert ends without a recovery event', () => {
    const engine = new AlertEngine();
    const snap = snapshot({temps: [{key: 'hot', value: 99, limit: 80}]});
    engine.update(checksFor(snap).checks, 0);
    engine.update(checksFor(snap).checks, 10);
    eq(engine.active.length, 1);
    const hidden = checksFor(snap, {overrides: {hot: {hidden: true}}}).checks;
    eq(hidden.length, 0);
    eq(engine.update(hidden, 20), {raised: [], cleared: []});
    eq(engine.active.length, 0);
});

test('disk space: immediate, with a 2-point recovery margin', () => {
    const engine = new AlertEngine();
    const at = freePercent => checksFor(snapshot({filesystems: [{mountpoint: '/', free: GiB, freePercent}]})).checks;
    eq(engine.update(at(5), 0).raised.length, 1);
    eq(engine.update(at(11), 1).cleared.length, 0);
    eq(engine.update(at(12.5), 2).cleared.length, 1);
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
    eq(formatReading('in', 1.176), '1.18 V');
    eq(formatReading('power', 9.262), '9.3 W');
    eq(meter(30), '▰▰▰▱▱▱▱▱▱▱');
    eq(meter(150, 4), '▰▰▰▰');
    eq(truncate('abcdef', 4), 'abc…');
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

print(`${passed} passed, ${failed} failed`);
if (failed > 0)
    System.exit(1);
