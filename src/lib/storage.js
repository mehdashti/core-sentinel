// SPDX-License-Identifier: GPL-2.0-or-later
// Filesystem space (one entry per block device, at its shortest mount point)
// and per-disk throughput and utilisation from /proc/diskstats.

import {readText, filesystemUsage, monotonicSeconds} from './io.js';

const SKIP_FSTYPES = new Set([
    'squashfs', 'iso9660', 'udf', 'overlay', 'tmpfs', 'devtmpfs', 'ramfs', 'erofs',
]);

/** Whole disks only; partitions would double-count throughput. */
export const WHOLE_DISK = /^(nvme\d+n\d+|sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|mmcblk\d+)$/;

const SECTOR_BYTES = 512; // diskstats always counts 512-byte sectors

/** @param {string} field a /proc/mounts field with octal escapes (\040 = space) */
export function unescapeMountField(field) {
    return field.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * @param {string} text contents of /proc/self/mounts
 * @returns {Array<{device: string, mountpoint: string, fstype: string}>}
 */
export function parseMounts(text) {
    const byDevice = new Map();
    for (const line of text.split('\n')) {
        const [device, mountField, fstype] = line.split(' ');
        if (!device?.startsWith('/dev/') || /^\/dev\/(loop|zram|ram)\d/.test(device) ||
            SKIP_FSTYPES.has(fstype))
            continue;
        const mountpoint = unescapeMountField(mountField);
        const known = byDevice.get(device);
        if (!known || mountpoint.length < known.mountpoint.length)
            byDevice.set(device, {device, mountpoint, fstype});
    }
    return [...byDevice.values()].sort((a, b) => a.mountpoint.localeCompare(b.mountpoint));
}

/**
 * @param {string} text contents of /proc/diskstats
 * @returns {Map<string, {sectorsRead: number, sectorsWritten: number, ioTicks: number}>}
 */
export function parseDiskstats(text) {
    const disks = new Map();
    for (const line of text.split('\n')) {
        const f = line.trim().split(/\s+/);
        if (f.length < 13 || !WHOLE_DISK.test(f[2]))
            continue;
        disks.set(f[2], {
            sectorsRead: Number(f[5]),
            sectorsWritten: Number(f[9]),
            ioTicks: Number(f[12]), // ms the device had I/O in flight
        });
    }
    return disks;
}

/**
 * @param {Map} prev parsed diskstats
 * @param {Map} cur parsed diskstats
 * @param {number} seconds elapsed between them
 * @returns {Array<{name: string, readBps: number, writeBps: number, busy: number}>}
 */
export function diskRates(prev, cur, seconds) {
    const rates = [];
    for (const [name, c] of cur) {
        const p = prev.get(name);
        if (!p || seconds <= 0) {
            rates.push({name, readBps: 0, writeBps: 0, busy: 0});
            continue;
        }
        rates.push({
            name,
            readBps: (c.sectorsRead - p.sectorsRead) * SECTOR_BYTES / seconds,
            writeBps: (c.sectorsWritten - p.sectorsWritten) * SECTOR_BYTES / seconds,
            busy: Math.min(100, (c.ioTicks - p.ioTicks) / (seconds * 10)),
        });
    }
    return rates;
}

export class StorageSampler {
    constructor() {
        this._prev = null;
        this._prevTime = 0;
    }

    /** @returns {Promise<{filesystems: object[], disks: object[]}>} */
    async sample() {
        const [mountsText, statsText] = await Promise.all([
            readText('/proc/self/mounts'), readText('/proc/diskstats')]);
        const mounts = mountsText ? parseMounts(mountsText) : [];
        const usage = await Promise.all(mounts.map(m => filesystemUsage(m.mountpoint)));
        const filesystems = [];
        mounts.forEach((mount, i) => {
            const u = usage[i];
            if (u && u.size > 0) {
                const capacity = u.used + u.free; // excludes root-reserved blocks, like df
                filesystems.push({
                    ...mount, ...u,
                    percent: capacity > 0 ? 100 * u.used / capacity : 0,
                    freePercent: capacity > 0 ? 100 * u.free / capacity : 0,
                });
            }
        });

        const now = monotonicSeconds();
        const cur = statsText ? parseDiskstats(statsText) : new Map();
        const disks = diskRates(this._prev ?? cur, cur, this._prev ? now - this._prevTime : 0);
        this._prev = cur;
        this._prevTime = now;
        return {filesystems, disks};
    }
}
