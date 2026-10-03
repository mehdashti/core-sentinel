// SPDX-License-Identifier: GPL-2.0-or-later
// Memory as the kernel sees it. "Used" is total minus MemAvailable, the
// kernel's own estimate of what can be handed out without swapping, so
// reclaimable page cache is not counted as used. Swap is split into zram
// (compressed RAM, cheap) and swap on disk (where slowdowns begin).

import {readText} from './io.js';

/**
 * @param {string} text contents of /proc/meminfo
 * @returns {Record<string, number>} bytes per field
 */
export function parseMeminfo(text) {
    const fields = {};
    for (const line of text.split('\n')) {
        const match = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?$/.exec(line.trim());
        if (match)
            fields[match[1]] = Number(match[2]) * (line.includes('kB') ? 1024 : 1);
    }
    return fields;
}

/**
 * @param {string} text contents of /proc/swaps
 * @returns {Array<{name: string, type: string, size: number, used: number, priority: number}>} bytes
 */
export function parseSwaps(text) {
    return text.split('\n').slice(1)
        .map(line => line.trim().split(/\s+/))
        .filter(f => f.length >= 5)
        .map(([name, type, size, used, priority]) => ({
            name: name.replace(/\\040/g, ' '),
            type,
            size: Number(size) * 1024,
            used: Number(used) * 1024,
            priority: Number(priority),
        }));
}

/**
 * @param {string} text contents of /sys/block/zramN/mm_stat
 * @returns {{orig: number, compr: number, memUsed: number}} bytes: data stored,
 *   its compressed size, and RAM the device really occupies
 */
export function parseZramMmStat(text) {
    const [orig, compr, memUsed] = text.trim().split(/\s+/).map(Number);
    return {orig, compr, memUsed};
}

export function isZram(swap) {
    return /^\/dev\/zram\d+$/.test(swap.name);
}

/**
 * @param {Record<string, number>} meminfo
 * @param {object[]} swaps parsed /proc/swaps
 * @param {Array<object|null>} zramStats parsed mm_stat, one per zram swap in order
 * @returns {object} totals in bytes
 */
export function summarize(meminfo, swaps, zramStats) {
    const total = meminfo.MemTotal ?? 0;
    const available = meminfo.MemAvailable ?? meminfo.MemFree ?? 0;
    const zramSwaps = swaps.filter(isZram);
    const diskSwaps = swaps.filter(s => !isZram(s));
    const stats = zramStats.filter(s => s !== null);
    const orig = stats.reduce((acc, s) => acc + s.orig, 0);
    const compr = stats.reduce((acc, s) => acc + s.compr, 0);
    // a nearly empty device compresses a few zero pages "69:1": not a real ratio
    const ratio = compr > 0 && orig >= 1024 * 1024 ? orig / compr : null;
    return {
        total,
        available,
        used: Math.max(0, total - available),
        zram: zramSwaps.length ? {
            size: sum(zramSwaps, 'size'),
            used: sum(zramSwaps, 'used'),
            ram: stats.reduce((acc, s) => acc + s.memUsed, 0),
            ratio,
        } : null,
        diskSwap: diskSwaps.length ? {size: sum(diskSwaps, 'size'), used: sum(diskSwaps, 'used')} : null,
    };
}

function sum(items, key) {
    return items.reduce((acc, item) => acc + item[key], 0);
}

/** @returns {Promise<object|null>} see summarize() */
export async function readMemory() {
    const [meminfo, swapsText] = await Promise.all([readText('/proc/meminfo'), readText('/proc/swaps')]);
    if (meminfo === null)
        return null;
    const swaps = swapsText ? parseSwaps(swapsText) : [];
    const zramStats = await Promise.all(swaps.filter(isZram).map(async swap => {
        const text = await readText(`/sys/block/${swap.name.slice('/dev/'.length)}/mm_stat`);
        return text ? parseZramMmStat(text) : null;
    }));
    return summarize(parseMeminfo(meminfo), swaps, zramStats);
}
