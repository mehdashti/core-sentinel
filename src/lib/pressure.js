// SPDX-License-Identifier: GPL-2.0-or-later
// Pressure Stall Information (PSI): the share of wall time in which tasks were
// stalled waiting for a resource. Utilisation says how busy a resource is;
// pressure says whether that busyness is actually slowing work down.
//   some = at least one task was stalled   full = every non-idle task was

import {readText} from './io.js';

export const RESOURCES = ['cpu', 'memory', 'io'];

/**
 * @param {string} text contents of /proc/pressure/<resource>
 * @returns {{some: object|null, full: object|null}} avg10/avg60/avg300 in %,
 *   total in microseconds
 */
export function parsePressure(text) {
    const pressure = {some: null, full: null};
    for (const line of text.split('\n')) {
        const match = /^(some|full)\s+(.*)$/.exec(line.trim());
        if (!match)
            continue;
        const record = {};
        for (const pair of match[2].split(/\s+/)) {
            const [key, value] = pair.split('=');
            record[key] = Number(value);
        }
        pressure[match[1]] = record;
    }
    return pressure;
}

/** @returns {Promise<object>} {cpu, memory, io}; a value is null when PSI is off */
export async function readPressure() {
    const entries = await Promise.all(RESOURCES.map(async resource => {
        const text = await readText(`/proc/pressure/${resource}`);
        return [resource, text === null ? null : parsePressure(text)];
    }));
    return Object.fromEntries(entries);
}
