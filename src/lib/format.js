// SPDX-License-Identifier: GPL-2.0-or-later
// Value formatting shared by the indicator and the preferences window.

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const DASH = '–';

/** printf-lite for translated templates: %s and %d in order, %% for a percent sign. */
export function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd%]/g, token => token === '%%' ? '%' : String(args[i++]));
}

export function formatBytes(bytes) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes))
        return DASH;
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit++;
    }
    const digits = unit === 0 || value >= 100 ? 0 : 1;
    return `${value.toFixed(digits)} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond) {
    return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value, digits = 0) {
    return value === null || value === undefined ? DASH : `${value.toFixed(digits)}%`;
}

/**
 * @param {string} kind hwmon channel kind: temp, fan, in, power
 * @param {number|null} value in °C, RPM, V or W
 */
export function formatReading(kind, value) {
    if (value === null || value === undefined)
        return DASH;
    switch (kind) {
    case 'temp':
        return `${Math.round(value)}°C`;
    case 'fan':
        return `${Math.round(value)} RPM`;
    case 'in':
        return `${value.toFixed(2)} V`;
    case 'power':
        return `${value.toFixed(1)} W`;
    default:
        return String(value);
    }
}

/** A text meter: meter(30) -> "▰▰▰▱▱▱▱▱▱▱" */
export function meter(percent, width = 10) {
    const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

export function truncate(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
