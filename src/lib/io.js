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

/**
 * @param {string} path
 * @returns {Promise<string|null>} the file's text, or null if it can't be read
 */
export async function readText(path) {
    try {
        const [bytes] = await Gio.File.new_for_path(path).load_contents_async(null);
        return decoder.decode(bytes);
    } catch {
        return null;
    }
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
export async function listDir(path) {
    try {
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
    } catch {
        return [];
    }
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
 * @param {string} path any path on the filesystem
 * @returns {Promise<{size: number, free: number, used: number}|null>} bytes;
 *   `free` is what unprivileged users can still write (statvfs f_bavail)
 */
export async function filesystemUsage(path) {
    try {
        const info = await Gio.File.new_for_path(path).query_filesystem_info_async(
            'filesystem::size,filesystem::free,filesystem::used', GLib.PRIORITY_DEFAULT, null);
        const size = info.get_attribute_uint64('filesystem::size');
        const free = info.get_attribute_uint64('filesystem::free');
        const used = info.get_attribute_uint64('filesystem::used') || size - free;
        return {size, free, used};
    } catch {
        return null;
    }
}

/** @returns {number} monotonic seconds (does not advance while suspended) */
export function monotonicSeconds() {
    return GLib.get_monotonic_time() / 1e6;
}
