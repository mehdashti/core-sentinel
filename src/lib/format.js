// SPDX-License-Identifier: GPL-2.0-or-later
// Value formatting shared by the indicator and the preferences window. Numbers
// are written the way the session's locale writes them: Persian digits and ٪
// in Persian, a decimal comma in German.

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
const DASH = '–';

let locale; // undefined: the locale GNOME runs in
const formatters = new Map(); // building an Intl.NumberFormat is slow; formatting is not

/** @param {string|undefined} tag a BCP 47 tag ("fa"), or undefined for the session's locale */
export function setNumberLocale(tag) {
    locale = tag;
    formatters.clear();
}

function numberFormat(digits, style) {
    const key = `${style}:${digits}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.NumberFormat(locale, {
            style, minimumFractionDigits: digits, maximumFractionDigits: digits,
        });
        formatters.set(key, formatter);
    }
    return formatter;
}

/**
 * @param {number} value
 * @param {number} digits after the decimal separator
 */
export function formatNumber(value, digits = 0) {
    return numberFormat(digits, 'decimal').format(value);
}

/**
 * printf-lite for translated templates, filled in order: %s takes a string, %d
 * a number (written in the locale's digits), %% is a percent sign.
 */
export function fmt(template, ...args) {
    let i = 0;
    return template.replace(/%[sd%]/g, token => {
        if (token === '%%')
            return '%';
        const arg = args[i++];
        return token === '%d' ? formatNumber(arg) : String(arg);
    });
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
    return `${formatNumber(value, digits)} ${BYTE_UNITS[unit]}`;
}

export function formatRate(bytesPerSecond) {
    return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value, digits = 0) {
    return value === null || value === undefined ? DASH : numberFormat(digits, 'percent').format(value / 100);
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
        return `${formatNumber(value)}°C`;
    case 'fan':
        return `${formatNumber(value)} RPM`;
    case 'in':
        return `${formatNumber(value, 2)} V`;
    case 'power':
        return `${formatNumber(value, 1)} W`;
    default:
        return String(value);
    }
}

function dateFormat(withDate, hour12) {
    const key = `time:${withDate}:${hour12}`;
    let formatter = formatters.get(key);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat(locale, {
            ...withDate ? {month: 'short', day: 'numeric'} : {},
            hour: hour12 ? 'numeric' : '2-digit',
            minute: '2-digit',
            hourCycle: hour12 ? 'h12' : 'h23',
        });
        formatters.set(key, formatter);
    }
    return formatter;
}

/**
 * A wall-clock time in the locale's digits and calendar: "03:12", or "3:12 AM"
 * on a 12-hour clock, with the date in front when it is not today: "Nov 10, 23:50".
 *
 * @param {number} ms since the epoch
 * @param {object} [opts]
 * @param {boolean} [opts.hour12] a 12-hour clock (GNOME's clock-format setting)
 * @param {number} [opts.now] ms since the epoch: the date is left out on the same day
 */
export function formatTime(ms, {hour12 = false, now = ms} = {}) {
    const date = new Date(ms);
    const today = date.toDateString() === new Date(now).toDateString();
    return dateFormat(!today, hour12).format(date);
}

/** A text meter: meter(30) -> "▰▰▰▱▱▱▱▱▱▱" */
export function meter(percent, width = 10) {
    const filled = Math.round(Math.min(100, Math.max(0, percent)) / 100 * width);
    return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/**
 * Wraps left-to-right text that starts with a neutral character, such as a
 * path ("/boot/efi"), in a first-strong isolate: inside a right-to-left line
 * its leading slash would otherwise jump to the far end.
 */
export function isolate(text) {
    return `\u2068${text}\u2069`;
}

export function truncate(text, length) {
    return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}
