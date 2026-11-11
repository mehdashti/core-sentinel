// SPDX-License-Identifier: GPL-2.0-or-later
// The processes behind the load: the busiest by CPU and the largest by memory.
// Read only while the menu is open, from files every user may read.
//
// One file per process: /proc/[pid]/stat holds the name, the CPU time of all
// the process's threads together and its resident size. Memory is ranked by
// private memory (RssAnon in /proc/[pid]/status), read only for the few
// processes that can still make the list: RssAnon is part of the resident
// size, so once the N-th largest RssAnon found is at least the resident size
// of the next process in line, nobody further down can enter the list.

import {listDir, readText, readTexts} from './io.js';
import {parseProcStat, readTopology, busyPercent, coreLoads} from './cpu.js';

const PF_KTHREAD = 0x00200000; // include/linux/sched.h

// Shares below this would read 0.0% and say nothing.
const MIN_SHARE = 0.05;

// Control and formatting characters (line breaks, bidi overrides, zero-width
// marks) are replaced: a process names itself, and may try to scramble or
// fake a menu row.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * @param {string} name as the kernel reports it; any process can set its own
 * @returns {string} the name with control and formatting characters replaced
 */
export function safeName(name) {
    return name.replace(UNSAFE, '\uFFFD');
}

/**
 * @param {string} text contents of /proc/[pid]/stat
 * @returns {{name: string, kernel: boolean, ticks: number, start: number, rssPages: number}|null}
 *   ticks: user + system CPU time of all threads, in clock ticks (the unit of
 *   /proc/stat); start: start time in clock ticks after boot
 */
export function parsePidStat(text) {
    // The name sits in parentheses and may itself hold ")" or spaces; the
    // last ")" ends it.
    const open = text.indexOf('(');
    const close = text.lastIndexOf(')');
    if (open < 0 || close < open)
        return null;
    // f[0] is field 3 of proc_pid_stat(5); field n is f[n - 3]
    const f = text.slice(close + 1).trim().split(/\s+/);
    if (f.length < 22)
        return null;
    const flags = Number(f[6]);
    const ticks = Number(f[11]) + Number(f[12]);
    const start = Number(f[19]);
    const rssPages = Number(f[21]);
    if (![flags, ticks, start, rssPages].every(Number.isFinite))
        return null;
    return {name: text.slice(open + 1, close), kernel: (flags & PF_KTHREAD) !== 0, ticks, start, rssPages};
}

/**
 * @param {string} text contents of /proc/[pid]/status
 * @param {string} field e.g. "RssAnon"
 * @returns {number|null} the field in bytes (the file counts kB)
 */
export function statusBytes(text, field) {
    const match = new RegExp(`^${field}:\\s+(\\d+) kB$`, 'm').exec(text);
    return match ? Number(match[1]) * 1024 : null;
}

/**
 * The kernel's page size, which GLib does not expose, from one process's
 * resident size counted both ways.
 *
 * @param {number} bytes resident size in bytes (VmRSS in status)
 * @param {number} pages the same in pages (rss in stat)
 * @returns {number} the nearest power of two, 4096 if the figures say nothing
 */
export function pageSizeFrom(bytes, pages) {
    const ratio = bytes / pages;
    return Number.isFinite(ratio) && ratio >= 1024 ? 2 ** Math.round(Math.log2(ratio)) : 4096;
}

/**
 * Each process's part of the physical-core load: its CPU time over all busy
 * CPU time, times that load. The shares add up to the load in the top bar,
 * less the time spent on interrupts, which no process owns. On a CPU with
 * idle physical cores this is the process's CPU time over the time of all
 * physical cores: one thread kept busy is one core, 1/12 on a 12-core CPU.
 *
 * @param {Map<number, {start: number, ticks: number}|null>} prev the previous
 *   sample, by pid; null for a pid listed in /proc but not read
 * @param {Array<{pid: number, start: number, ticks: number}>} procs
 * @param {number} busyTicks busy clock ticks of all CPUs between the samples (/proc/stat)
 * @param {number} load the physical-core load between the samples, in %
 * @returns {Array<object>} procs with `share` (%), largest first, those that
 *   would read 0.0% left out
 */
export function cpuShares(prev, procs, busyTicks, load) {
    if (busyTicks <= 0)
        return [];
    const shares = [];
    for (const proc of procs) {
        const before = prev.get(proc.pid);
        // Not read last time: its time since then is unknown, and counting
        // all of it would credit a whole lifetime to a few seconds.
        if (before === null)
            continue;
        // A pid not listed before, or reused by a new process, started after
        // the previous sample: all its CPU time falls between the two (as in top).
        const ticks = before && before.start === proc.start ? proc.ticks - before.ticks : proc.ticks;
        const share = Math.min(load, Math.max(0, load * ticks / busyTicks));
        if (share >= MIN_SHARE)
            shares.push({...proc, share});
    }
    return shares.sort((a, b) => b.share - a.share || a.pid - b.pid);
}

/**
 * The `count` processes with the most private memory, reading it only as far
 * down the resident-size order as needed (see the top of this file).
 *
 * @param {Array<{pid: number, rss: number}>} procs rss in bytes
 * @param {number} count
 * @param {Function} readPrivate proc => Promise<number|null>, bytes (null: gone)
 * @returns {Promise<Array<object>>} procs with `memory` (bytes), largest first
 */
export async function largestPrivate(procs, count, readPrivate) {
    const queue = procs.filter(p => p.rss > 0).sort((a, b) => b.rss - a.rss);
    const found = [];
    let next = 0;
    while (next < queue.length &&
           !(found.length >= count && found[count - 1].memory >= queue[next].rss)) {
        const batch = queue.slice(next, next + count);
        next += batch.length;
        const memory = await Promise.all(batch.map(readPrivate));
        batch.forEach((proc, i) => {
            if (memory[i] !== null)
                found.push({...proc, memory: memory[i]});
        });
        found.sort((a, b) => b.memory - a.memory || a.pid - b.pid);
    }
    return found.slice(0, count);
}

/**
 * @param {Map} prev parsed /proc/stat
 * @param {Map} cur parsed /proc/stat
 * @returns {number} busy clock ticks of all CPUs between the two
 */
export function busyTicksBetween(prev, cur) {
    let ticks = 0;
    for (const [cpu, c] of cur) {
        const p = prev.get(cpu);
        if (p)
            ticks += Math.max(0, (c.total - c.idle) - (p.total - p.idle));
    }
    return ticks;
}

async function readPageSize() {
    const [stat, status] = await Promise.all([readText('/proc/self/stat'), readText('/proc/self/status')]);
    const pages = stat === null ? null : parsePidStat(stat)?.rssPages;
    const bytes = status === null ? null : statusBytes(status, 'VmRSS');
    return pageSizeFrom(bytes ?? 0, pages ?? 0);
}

export class ProcessSampler {
    /**
     * @param {object} options
     * @param {number} options.count processes per list
     * @param {number} options.concurrency most /proc/[pid] files read at once
     */
    constructor({count = 5, concurrency = 4} = {}) {
        this._count = count;
        this._concurrency = concurrency;
        this._cores = null;
        this._pageSize = 4096;
        this._prev = null;
        this._epoch = 0;
        this._queue = Promise.resolve();
    }

    /** Forgets the previous sample: CPU shares need two samples again. */
    reset() {
        this._prev = null;
        this._epoch++;
    }

    /**
     * Samples run one at a time: a call while one is in flight waits for it.
     *
     * @returns {Promise<{cpu: object[]|null, memory: object[], processes: number}>}
     *   cpu is null on the first sample after reset(); each entry has pid,
     *   name (made safe), kernel, and share (%) or memory (bytes)
     */
    sample() {
        const run = this._queue.then(() => this._sample(this._epoch));
        this._queue = run.catch(() => {});
        return run;
    }

    async _sample(epoch) {
        if (this._cores === null)
            [this._cores, this._pageSize] = await Promise.all([readTopology(), readPageSize()]);

        // A key of its own: the monitor reads /proc/stat on its own schedule,
        // and a read of a file that is still pending answers null (io.js).
        const statText = await readText('/proc/stat', 'processes:/proc/stat');
        const pids = (await listDir('/proc')).filter(name => /^\d+$/.test(name));
        if (pids.length === 0) // /proc unreadable: nothing to measure from
            return {cpu: null, memory: [], processes: 0};
        const texts = await readTexts(pids.map(pid => `/proc/${pid}/stat`), this._concurrency);
        const procs = [];
        const listed = new Map();
        texts.forEach((text, i) => {
            const pid = Number(pids[i]);
            const stat = text === null ? null : parsePidStat(text);
            const proc = stat && {
                pid,
                name: safeName(stat.name),
                kernel: stat.kernel,
                ticks: stat.ticks,
                start: stat.start,
                rss: stat.rssPages * this._pageSize,
            };
            listed.set(pid, proc);
            if (proc)
                procs.push(proc);
        });

        const cpuStat = statText === null ? null : parseProcStat(statText);
        const prev = this._prev;
        let cpu = null;
        if (prev && cpuStat) {
            const load = coreLoads(this._cores, busyPercent(prev.cpuStat, cpuStat)).real;
            cpu = cpuShares(prev.listed, procs, busyTicksBetween(prev.cpuStat, cpuStat), load)
                .slice(0, this._count);
        }
        const memory = await largestPrivate(procs, this._count, async proc => {
            const text = await readText(`/proc/${proc.pid}/status`);
            return text === null ? null : statusBytes(text, 'RssAnon');
        });

        // Without /proc/stat the last good sample stays the baseline. A sample
        // begun before reset() is not one.
        if (cpuStat && epoch === this._epoch)
            this._prev = {cpuStat, listed};
        return {cpu, memory, processes: procs.length};
    }
}
