// SPDX-License-Identifier: GPL-2.0-or-later
// Alert rules. Pure: no I/O, no clock, no GNOME. buildChecks() turns one
// Monitor snapshot into checks; AlertEngine.update() keeps state across ticks
// and answers which alerts started and which ended.
//
// Every check has two thresholds, `bad` and `recovered`, with a gap between
// them (hysteresis), and an optional hold time, so a reading that hovers at a
// limit raises one alert instead of a stream of them.

export const TEMP_HYSTERESIS = 5; // °C below the limit before a heat alert ends
export const TEMP_HOLD = 5; // s above the limit before it counts (ignores spikes)
export const PRESSURE_HOLD = 10; // s for the 10-second pressure averages

const MiB = 1024 * 1024;

/**
 * @typedef {object} Check
 * @property {string} key stable identity of the condition
 * @property {string} type message kind (fan-stall, temp, disk, ...)
 * @property {boolean} bad the condition holds now
 * @property {boolean} recovered the condition is clearly over now
 * @property {number} hold seconds `bad` must last before an alert is raised
 * @property {object} params values for the message
 */

/**
 * A fan that has never been seen spinning is treated as not connected: an
 * empty header reads 0 RPM while its PWM output still drives it, which would
 * otherwise look exactly like a stalled fan. Fans seen spinning are reported in
 * `spinning` so the caller can remember them across sessions; from then on a
 * stop is an alarm, even right after boot.
 *
 * @param {object} snapshot Monitor.sample() result
 * @param {object} ctx
 * @param {Record<string, object>} ctx.overrides per-channel user settings
 * @param {Set<string>} ctx.knownFans fan keys seen spinning before
 * @param {object} ctx.settings alert settings (see extension.js readAlertSettings)
 * @param {Function} ctx.labelOf (chip, channel) => display label
 * @returns {{checks: Check[], spinning: string[]}}
 */
export function buildChecks(snapshot, {overrides, knownFans, settings, labelOf}) {
    const checks = [];
    const spinning = [];

    for (const chip of snapshot.chips ?? []) {
        if (chip.asleep)
            continue;
        for (const ch of chip.channels) {
            const reading = chip.values?.get(ch.key);
            if (!reading || reading.value === null)
                continue;
            const o = overrides[ch.key] ?? {};
            if (ch.kind === 'fan') {
                const rpm = reading.value;
                if (rpm > 0 && !knownFans.has(ch.key))
                    spinning.push(ch.key);
                if (settings.alertFan && !o.hidden && (rpm > 0 || knownFans.has(ch.key)))
                    checks.push(...fanChecks(ch, reading, o, settings, labelOf(chip, ch)));
            } else if (ch.kind === 'temp' && settings.alertTemp && !o.hidden) {
                const limit = o.maxTemp > 0 ? o.maxTemp : ch.limit;
                if (limit) {
                    checks.push({
                        key: `temp:${ch.key}`,
                        type: 'temp',
                        bad: reading.value >= limit,
                        recovered: reading.value <= limit - TEMP_HYSTERESIS,
                        hold: TEMP_HOLD,
                        params: {label: labelOf(chip, ch), value: reading.value, limit},
                    });
                }
            }
        }
    }

    if (settings.alertDisk) {
        for (const fs of snapshot.storage?.filesystems ?? []) {
            checks.push({
                key: `disk:${fs.mountpoint}`,
                type: 'disk',
                bad: fs.freePercent < settings.diskFreePercent,
                recovered: fs.freePercent >= settings.diskFreePercent + 2,
                hold: 0,
                params: {mountpoint: fs.mountpoint, free: fs.free, freePercent: fs.freePercent},
            });
        }
    }

    const diskSwap = snapshot.memory?.diskSwap;
    if (settings.alertSwap && diskSwap) {
        const limit = settings.swapAlertMiB * MiB;
        checks.push({
            key: 'swap',
            type: 'swap',
            bad: diskSwap.used >= limit,
            recovered: diskSwap.used < limit / 2,
            hold: 0,
            params: {used: diskSwap.used},
        });
    }

    const memFull = snapshot.pressure?.memory?.full;
    if (settings.alertThrash && memFull)
        checks.push(pressureCheck('thrash', memFull.avg10, settings.thrashPercent, PRESSURE_HOLD, 0.5));
    const cpuSome = snapshot.pressure?.cpu?.some;
    if (settings.cpuPressurePercent > 0 && cpuSome) // avg60 is already smoothed: no hold
        checks.push(pressureCheck('cpu-pressure', cpuSome.avg60, settings.cpuPressurePercent, 0, 0.8));
    const ioFull = snapshot.pressure?.io?.full;
    if (settings.ioPressurePercent > 0 && ioFull)
        checks.push(pressureCheck('io-pressure', ioFull.avg10, settings.ioPressurePercent, PRESSURE_HOLD, 0.8));

    return {checks, spinning};
}

function fanChecks(ch, reading, o, settings, label) {
    const rpm = reading.value;
    const pwm = reading.pwm;
    // Driven at a real duty cycle yet not turning: stuck or dead. A fan whose
    // controller asks for less than the threshold may legitimately stop.
    const stalled = rpm === 0 && pwm !== null && pwm >= settings.fanStallPwm;
    // No PWM to compare with: any stop is suspicious unless the fan is known
    // to park itself (zero-RPM GPU and PSU fans).
    const stopped = rpm === 0 && pwm === null && !o.zeroRpm;
    const checks = [{
        key: `fan:${ch.key}`,
        type: pwm === null ? 'fan-stopped' : 'fan-stall',
        bad: stalled || stopped,
        recovered: rpm > 0,
        hold: settings.fanStallSeconds,
        params: {label, rpm, pwm},
    }];
    if (o.minRpm > 0) {
        checks.push({
            key: `fan-low:${ch.key}`,
            type: 'fan-low',
            bad: rpm > 0 && rpm < o.minRpm,
            recovered: rpm === 0 || rpm >= o.minRpm * 1.05,
            hold: settings.fanStallSeconds,
            params: {label, rpm, min: o.minRpm},
        });
    }
    return checks;
}

function pressureCheck(type, value, threshold, hold, recoverFactor) {
    return {
        key: type,
        type,
        bad: value >= threshold,
        recovered: value < threshold * recoverFactor,
        hold,
        params: {value},
    };
}

export class AlertEngine {
    constructor() {
        this._active = new Map();
        this._pendingSince = new Map();
    }

    /** @returns {object[]} alerts currently raised */
    get active() {
        return [...this._active.values()];
    }

    /**
     * @param {Check[]} checks this tick's checks
     * @param {number} now seconds on a monotonic clock
     * @returns {{raised: object[], cleared: object[]}}
     */
    update(checks, now) {
        const raised = [];
        const cleared = [];
        const seen = new Set();
        for (const check of checks) {
            seen.add(check.key);
            const active = this._active.get(check.key);
            if (active) {
                if (check.recovered) {
                    this._active.delete(check.key);
                    cleared.push(active);
                } else {
                    active.params = check.params;
                }
                continue;
            }
            if (!check.bad) {
                this._pendingSince.delete(check.key);
                continue;
            }
            const since = this._pendingSince.get(check.key) ?? now;
            if (now - since >= check.hold) {
                const alert = {key: check.key, type: check.type, params: check.params, since};
                this._active.set(check.key, alert);
                this._pendingSince.delete(check.key);
                raised.push(alert);
            } else {
                this._pendingSince.set(check.key, since);
            }
        }
        // A subject that is gone (sensor hidden, disk unmounted, rule switched
        // off) ends quietly: no "recovered" message for something not watched.
        for (const map of [this._active, this._pendingSince]) {
            for (const key of [...map.keys()]) {
                if (!seen.has(key))
                    map.delete(key);
            }
        }
        return {raised, cleared};
    }
}
