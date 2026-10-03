// SPDX-License-Identifier: GPL-2.0-or-later
// Async procfs/sysfs helpers. Everything the shell reads goes through here, so no
// read ever blocks the compositor's main loop. Unreadable files become null: a
// sensor that vanishes or answers EIO must never take the indicator down.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async');
Gio._promisify(Gio.File.prototype, 'query_filesystem_info_async');

const decoder = new TextDecoder();

// A read that never comes back (a hung driver, a dying disk) holds a GIO worker
// thread until it does. While one is pending, further reads of the same file
// answer "unreadable" at once, so a stuck sensor neither stalls every later
// reading nor ties up one more thread each tick.
const pending = new Set();

async function exclusive(id, read, fallback) {
    if (pending.has(id))
        return fallback;
    pending.add(id);
    try {
        return await read();
    } catch {
        return fallback;
    } finally {
        pending.delete(id);
    }
}

/** @returns {string[]} reads still waiting for an answer, for diagnostics */
export function pendingReads() {
    return [...pending];
}

/**
 * @param {string} path
 * @returns {Promise<string|null>} the file's text, or null if it can't be read
 */
export function readText(path) {
    return exclusive(path, async () => {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return decoder.decode(bytes);
    }, null);
}

/**
 * @param {string} path
 * @returns {Promise<number|null>} the file's content as a number, or null
 */
export async function readNumber(path) {
    const text = await readText(path);
    if (text === null)
        return null;
    const value = Number(text.trim());
    return Number.isFinite(value) ? value : null;
}

/**
 * @param {string} path
 * @returns {Promise<string[]>} child names of a directory (empty if unreadable)
 */
export function listDir(path) {
    return exclusive(`list:${path}`, async () => {
        const enumerator = await Gio.File.new_for_path(path).enumerate_children_async(
            'standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        const names = [];
        for (;;) {
            const infos = await enumerator.next_files_async(64, GLib.PRIORITY_DEFAULT, null);
            if (infos.length === 0)
                break;
            for (const info of infos)
                names.push(info.get_name());
        }
        return names;
    }, []);
}

/**
 * readlink(2) is answered from the kernel's in-memory sysfs tree, so the
 * synchronous call never touches a device.
 *
 * @param {string} path a symlink, e.g. /sys/class/hwmon/hwmon3/device
 * @returns {string|null} the basename of its target, e.g. "it87.2624"
 */
export function linkTargetName(path) {
    try {
        return GLib.path_get_basename(GLib.file_read_link(path));
    } catch {
        return null;
    }
}

/**
 * Like realpath(3) for a link inside a directory that is itself a link, the
 * usual shape of sysfs (/sys/class/hwmon/hwmon3 -> ../../devices/...).
 * Synchronous for the same reason as linkTargetName().
 *
 * @param {string} dirLink e.g. /sys/class/hwmon/hwmon3
 * @param {string} name a link inside it, e.g. "device"
 * @returns {string|null} the absolute target, e.g. /sys/devices/platform/it87.2624
 */
export function resolveLink(dirLink, name) {
    try {
        const dir = GLib.canonicalize_filename(GLib.file_read_link(dirLink), GLib.path_get_dirname(dirLink));
        return GLib.canonicalize_filename(GLib.file_read_link(`${dir}/${name}`), dir);
    } catch {
        return null;
    }
}

/**
 * @param {string} path any path on the filesystem
 * @returns {Promise<{size: number, free: number, used: number}|null>} bytes;
 *   `free` is what unprivileged users can still write (statvfs f_bavail)
 */
export function filesystemUsage(path) {
    return exclusive(`statfs:${path}`, async () => {
        const info = await Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_DEFAULT, null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        const used = info.get_attribute_uint64('filesystem::used') || size - free;
        return {size, free, used};
    }, null);
}

/** @returns {number} monotonic seconds (does not advance while suspended) */
export function monotonicSeconds() {
    return GLib.get_monotonic_time() / 1e6;
}
