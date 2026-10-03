// SPDX-License-Identifier: GPL-2.0-or-later
// Hardware sensors from /sys/class/hwmon. hwmonN numbers are handed out in
// probe order and can change between boots, so every chip is keyed by its
// driver name plus the device it sits on ("it8689@it87.2624",
// "amdgpu@0000:01:00.0"), and every channel by chip key + kind + index.
// Settings stored against those keys survive reboots.

import {readText, readNumber, listDir, linkTargetName} from './io.js';

const CATEGORY_RULES = [
    [/^(k10temp|coretemp|zenpower|cpu_thermal|fam15h_power)$/, 'cpu'],
    [/^(amdgpu|radeon|nouveau|i915|xe)$/, 'gpu'],
    [/^(nvme|drivetemp)$/, 'storage'],
    [/^(spd5118|jc42|ee1004)$/, 'memory'],
    [/^(it8\d+|nct\d+|w83\w+|f71\w+|gigabyte_wmi|asus\w*|dell_smm|thinkpad|acpitz)/, 'board'],
    [/^(iwlwifi\w*|mt7\w+|ath\w+|r8169\w*|igc|e1000e|rtw\w*|bnxt\w*|mlx\w*)/, 'network'],
];

export const CATEGORY_ORDER = ['cpu', 'board', 'memory', 'storage', 'gpu', 'network', 'other'];

/** Divisor from the sysfs unit to SI: m°C, rpm, mV, µW. */
const SCALE = {temp: 1000, fan: 1, in: 1000, power: 1e6};

/** @param {string} chipName hwmon "name" attribute */
export function categoryOf(chipName) {
    for (const [pattern, category] of CATEGORY_RULES) {
        if (pattern.test(chipName))
            return category;
    }
    return 'other';
}

/**
 * Drivers report "no limit" as 0, 127 or 255 °C; only a plausible value is a limit.
 *
 * @param {number|null} celsius
 * @returns {number|null}
 */
export function plausibleTempLimit(celsius) {
    return celsius !== null && celsius > 20 && celsius < 125 ? celsius : null;
}

/** An unconnected thermistor reads 0, -128 or 127 °C. */
export function plausibleTemp(celsius) {
    return celsius !== null && celsius > 0 && celsius < 127;
}

/**
 * @param {string[]} files names in one hwmon directory
 * @returns {Array<{kind: string, index: number, input: string}>}
 */
export function findChannels(files) {
    const names = new Set(files);
    const channels = [];
    for (const name of files) {
        let match = /^(temp|fan|in)(\d+)_input$/.exec(name);
        if (!match) {
            match = /^(power)(\d+)_(average|input)$/.exec(name);
            // a chip may offer both; prefer the averaged reading
            if (match && match[3] === 'input' && names.has(`power${match[2]}_average`))
                continue;
        }
        if (match)
            channels.push({kind: match[1], index: Number(match[2]), input: name});
    }
    const order = ['temp', 'fan', 'power', 'in'];
    return channels.sort((a, b) =>
        order.indexOf(a.kind) - order.indexOf(b.kind) || a.index - b.index);
}

async function describeChannel(dir, chipKey, ch, names) {
    const base = `${ch.kind}${ch.index}`;
    const label = names.has(`${base}_label`) ? (await readText(`${dir}/${base}_label`))?.trim() : null;
    const channel = {
        key: `${chipKey}/${base}`,
        kind: ch.kind,
        index: ch.index,
        file: `${dir}/${ch.input}`,
        label: label || base,
        limit: null,
        pwmFile: null,
        // A power reading with a settable cap is a board's own (a dGPU); without
        // one it can be a whole package (an APU's PPT covers the CPU cores too).
        hasCap: ch.kind === 'power' && names.has(`${base}_cap`),
    };
    if (ch.kind === 'temp') {
        // crit is the hardware's own alarm point; max is a softer warning level
        for (const suffix of ['crit', 'max']) {
            if (names.has(`${base}_${suffix}`)) {
                const raw = await readNumber(`${dir}/${base}_${suffix}`);
                channel.limit = plausibleTempLimit(raw === null ? null : raw / 1000);
                if (channel.limit !== null)
                    break;
            }
        }
    } else if (ch.kind === 'fan' && names.has(`pwm${ch.index}`)) {
        // it87, nct67xx and amdgpu number a fan and the PWM output driving it alike
        channel.pwmFile = `${dir}/pwm${ch.index}`;
    }
    return channel;
}

/**
 * @param {object[]} previous the last scan; a chip whose device is in runtime
 *   suspend is carried over from it instead of being read (reading would wake it)
 * @returns {Promise<object[]>} chips with their channels, ordered by category
 */
export async function scanHwmon(previous = []) {
    const known = new Map(previous.map(chip => [chip.key, chip]));
    const entries = (await listDir('/sys/class/hwmon')).filter(n => /^hwmon\d+$/.test(n));
    const chips = await Promise.all(entries.map(async entry => {
        const dir = `/sys/class/hwmon/${entry}`;
        const name = (await readText(`${dir}/name`))?.trim();
        if (!name)
            return null;
        const files = await listDir(dir);
        const names = new Set(files);
        const devId = names.has('device') ? linkTargetName(`${dir}/device`) ?? entry : entry;
        const key = `${name}@${devId}`;
        const runtimeStatusFile = names.has('device') ? `${dir}/device/power/runtime_status` : null;
        if (runtimeStatusFile && (await readText(runtimeStatusFile))?.trim() === 'suspended')
            return known.get(key) ?? null;
        const channels = await Promise.all(
            findChannels(files).map(ch => describeChannel(dir, key, ch, names)));
        return {key, name, devId, category: categoryOf(name), runtimeStatusFile, channels};
    }));
    return chips
        .filter(chip => chip !== null && chip.channels.length > 0)
        .sort((a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
            a.key.localeCompare(b.key));
}

/**
 * @param {object} chip from scanHwmon()
 * @returns {Promise<{asleep: boolean, values: Map<string, {value: number|null, pwm: number|null}>}>}
 *   value in °C, RPM, V or W; pwm in % of full duty
 */
export async function readChip(chip) {
    if (chip.runtimeStatusFile &&
        (await readText(chip.runtimeStatusFile))?.trim() === 'suspended')
        return {asleep: true, values: new Map()};
    const values = await Promise.all(chip.channels.map(async ch => {
        const [raw, rawPwm] = await Promise.all([
            readNumber(ch.file), ch.pwmFile ? readNumber(ch.pwmFile) : null]);
        let value = raw === null ? null : raw / SCALE[ch.kind];
        if (ch.kind === 'temp' && !plausibleTemp(value))
            value = null;
        const pwm = rawPwm === null ? null : Math.round(100 * rawPwm / 255);
        return [ch.key, {value, pwm}];
    }));
    return {asleep: false, values: new Map(values)};
}
