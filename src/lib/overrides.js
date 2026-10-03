// SPDX-License-Identifier: GPL-2.0-or-later
// Per-sensor user settings, stored as one JSON object in the
// `sensor-overrides` key: { "<channel key>": {hidden, label, minRpm, zeroRpm, maxTemp} }.
// Only non-default fields are stored, so the object stays small.

const DEFAULTS = {hidden: false, label: '', minRpm: 0, zeroRpm: false, maxTemp: 0};

/** @returns {Record<string, object>} */
export function parseOverrides(json) {
    try {
        const value = JSON.parse(json);
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch {
        return {};
    }
}

/**
 * @param {Record<string, object>} overrides
 * @param {string} key channel key
 * @param {string} field one of DEFAULTS' keys
 * @param {*} value
 * @returns {Record<string, object>} a new object; defaults are dropped
 */
export function withOverride(overrides, key, field, value) {
    const next = {...overrides};
    const entry = {...next[key] ?? {}};
    if (value === DEFAULTS[field] || value === undefined || value === null)
        delete entry[field];
    else
        entry[field] = value;
    if (Object.keys(entry).length > 0)
        next[key] = entry;
    else
        delete next[key];
    return next;
}
