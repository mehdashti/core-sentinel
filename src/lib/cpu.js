// SPDX-License-Identifier: GPL-2.0-or-later
// CPU load over PHYSICAL cores. /proc/stat counts time per logical cpu; the
// kernel's topology files say which logical cpus are SMT siblings of one core.
// Averaging the logical cpus (what stock monitors do) reads "50% idle" on a
// 12-core/24-thread CPU whose every physical core is busy.

import {readText} from './io.js';

/**
 * @param {string} text a kernel cpu list, e.g. "0-3,8,10-11"
 * @returns {number[]}
 */
export function parseCpuList(text) {
    const cpus = [];
    for (const part of text.trim().split(',')) {
        if (!part)
            continue;
        const [first, last] = part.split('-').map(Number);
        for (let cpu = first; cpu <= (last ?? first); cpu++)
            cpus.push(cpu);
    }
    return cpus;
}

/**
 * @param {string} text contents of /proc/stat
 * @returns {Map<number, {total: number, idle: number}>} jiffies per logical cpu
 */
export function parseProcStat(text) {
    const stats = new Map();
    for (const line of text.split('\n')) {
        const match = /^cpu(\d+)\s+(.*)$/.exec(line);
        if (!match)
            continue;
        const f = match[2].trim().split(/\s+/).map(Number);
        // user nice system idle iowait irq softirq steal (guest time is already
        // inside user/nice, so the two guest columns are left out)
        const total = f.slice(0, 8).reduce((sum, x) => sum + x, 0);
        stats.set(Number(match[1]), {total, idle: f[3] + f[4]});
    }
    return stats;
}

/**
 * @param {Map<number, {total: number, idle: number}>} prev
 * @param {Map<number, {total: number, idle: number}>} cur
 * @returns {Map<number, number>} busy % per logical cpu between the samples
 */
export function busyPercent(prev, cur) {
    const busy = new Map();
    for (const [cpu, c] of cur) {
        const p = prev.get(cpu);
        const dt = p ? c.total - p.total : 0;
        busy.set(cpu, dt > 0 ? 100 * (dt - (c.idle - p.idle)) / dt : 0);
    }
    return busy;
}

/**
 * @param {Array<{cpu: number, pkg: number, core: number}>} entries
 * @returns {number[][]} logical cpus of each physical core, ordered by first cpu
 */
export function groupCores(entries) {
    const cores = new Map();
    for (const {cpu, pkg, core} of entries) {
        const key = `${pkg}:${core}`;
        if (!cores.has(key))
            cores.set(key, []);
        cores.get(key).push(cpu);
    }
    return [...cores.values()]
        .map(cpus => cpus.sort((a, b) => a - b))
        .sort((a, b) => a[0] - b[0]);
}

/**
 * A physical core's load is min(100, sum of its threads' busy %): the
 * no-overlap bound. Linux spreads runnable tasks over idle physical cores
 * before doubling up on siblings, so siblings rarely overlap until every core
 * is busy anyway, where the bound and the truth both reach 100.
 *
 * @param {number[][]} cores
 * @param {Map<number, number>} busy
 * @returns {{perCore: Array<{cpus: number[], percent: number}>, real: number, logical: number}}
 */
export function coreLoads(cores, busy) {
    const perCore = cores.map(cpus => ({
        cpus,
        percent: Math.min(100, cpus.reduce((sum, cpu) => sum + (busy.get(cpu) ?? 0), 0)),
    }));
    const values = [...busy.values()];
    return {
        perCore,
        real: average(perCore.map(c => c.percent)),
        logical: average(values),
    };
}

function average(values) {
    return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
}

/** @returns {Promise<number[][]>} the machine's physical cores */
export async function readTopology() {
    const online = await readText('/sys/devices/system/cpu/online');
    const cpus = online ? parseCpuList(online) : [];
    const entries = await Promise.all(cpus.map(async cpu => {
        const base = `/sys/devices/system/cpu/cpu${cpu}/topology`;
        const [core, pkg] = await Promise.all([
            readText(`${base}/core_id`), readText(`${base}/physical_package_id`)]);
        return core === null || pkg === null ? null : {cpu, core: Number(core), pkg: Number(pkg)};
    }));
    return groupCores(entries.filter(e => e !== null));
}

export class CpuSampler {
    constructor() {
        this._cores = [];
        this._prev = null;
    }

    async init() {
        this._cores = await readTopology();
        this._prev = null;
    }

    /** @returns {Promise<object|null>} loads since the previous call (zeros on the first) */
    async sample() {
        const text = await readText('/proc/stat');
        if (text === null)
            return null;
        const cur = parseProcStat(text);
        const prev = this._prev ?? cur;
        this._prev = cur;
        return {
            ...coreLoads(this._cores, busyPercent(prev, cur)),
            cores: this._cores.length,
            threads: cur.size,
        };
    }
}
