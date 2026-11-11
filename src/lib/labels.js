// SPDX-License-Identifier: GPL-2.0-or-later
// Human-readable names and alert texts. The gettext function is passed in, so
// the shell (extension.js) and the preferences app (prefs.js), which each have
// their own, share one set of strings.

import {fmt, formatBytes, formatPercent, formatReading, formatTime, isolate, truncate} from './format.js';

/**
 * @param {Function} _ gettext for the extension's domain
 * @returns {object} label helpers
 */
export function makeLabels(_) {
    const categoryTitles = {
        cpu: _('Processor'),
        board: _('Motherboard'),
        memory: _('Memory'),
        storage: _('Storage'),
        gpu: _('Graphics'),
        network: _('Network'),
        other: _('Other'),
    };

    function chipTitle(chip, gpus = []) {
        switch (chip.category) {
        case 'cpu':
            return _('CPU');
        case 'board':
            return chip.name === 'acpitz' ? _('ACPI thermal zone') : fmt(_('Board (%s)'), chip.name);
        case 'memory':
            return fmt(_('RAM module %s'), chip.device);
        case 'storage':
            return chip.name === 'nvme' ? `NVMe ${chip.device}` : fmt(_('Disk %s'), chip.device);
        case 'gpu': {
            const gpu = gpus.find(g => g.slot === chip.devId);
            return gpu ? truncate(gpu.name, 24) : _('GPU');
        }
        case 'network':
            return fmt(_('Network (%s)'), chip.name.replace(/_.*$/, ''));
        default:
            return chip.name;
        }
    }

    function channelLabel(chip, channel, overrides, gpus) {
        return overrides[channel.key]?.label || `${chipTitle(chip, gpus)} · ${channel.label}`;
    }

    function alertMessage(alert) {
        const p = alert.params;
        switch (alert.type) {
        case 'fan-stall':
            return {
                title: fmt(_('Fan stalled: %s'), p.label),
                body: fmt(_('Driven at %s but reporting 0 RPM. Check the fan and its cable.'),
                    formatPercent(p.pwm)),
            };
        case 'fan-stopped':
            return {
                title: fmt(_('Fan stopped: %s'), p.label),
                body: _('It was spinning before and now reports 0 RPM.'),
            };
        case 'fan-low':
            return {
                title: fmt(_('Fan too slow: %s'), p.label),
                body: fmt(_('%s, below the %s minimum you set.'),
                    formatReading('fan', p.rpm), formatReading('fan', p.min)),
            };
        case 'temp':
            return {
                title: fmt(_('Too hot: %s'), p.label),
                body: fmt(_('%s, at or above the %s limit.'),
                    formatReading('temp', p.value), formatReading('temp', p.limit)),
            };
        case 'disk':
            return {
                title: fmt(_('Disk almost full: %s'), isolate(p.mountpoint)),
                body: fmt(_('Only %s free (%s).'), formatBytes(p.free), formatPercent(p.freePercent)),
            };
        case 'swap':
            return {
                title: _('Memory is running out'),
                body: fmt(_('%s has been moved to swap on disk; expect slowdowns.'), formatBytes(p.used)),
            };
        case 'thrash':
            return {
                title: _('The system is thrashing'),
                body: fmt(_('All tasks were stalled on memory %s of the last 10 seconds.'),
                    formatPercent(p.value)),
            };
        case 'cpu-pressure':
            return {
                title: _('The CPU is saturated'),
                body: fmt(_('Tasks waited for a CPU %s of the last minute.'), formatPercent(p.value)),
            };
        case 'io-pressure':
            return {
                title: _('Disk I/O is the bottleneck'),
                body: fmt(_('All tasks were stalled on I/O %s of the last 10 seconds.'),
                    formatPercent(p.value)),
            };
        default:
            return {title: alert.type, body: ''};
        }
    }

    function recoveryMessage(alert) {
        return {title: fmt(_('Back to normal: %s'), alertMessage(alert).title), body: ''};
    }

    /**
     * One line of the alert history: "Fan stopped: CPU fan, 03:12 to 03:14".
     * The start has a date when it is not today, the end when it is not the
     * start's day.
     *
     * @param {object} entry AlertHistory entry
     * @param {object} timeOpts formatTime() options ({hour12, now})
     */
    function historyLine(entry, timeOpts) {
        // isolated: in a right-to-left line a label ending in Latin ("Fan 2")
        // would otherwise pull the time after it into its left-to-right run
        const title = isolate(alertMessage(entry).title);
        const start = formatTime(entry.start, timeOpts);
        if (entry.end === null) {
            // Translators: an alert that is still on; the second %s is a time
            return fmt(_('%s, since %s'), title, start);
        }
        const sameDay = {...timeOpts, now: entry.start};
        const end = formatTime(entry.end, sameDay);
        const oneMinute = end === formatTime(entry.start, sameDay);
        if (entry.dropped) {
            // its rule was switched off, its sensor hidden or its disk unmounted
            if (oneMinute) {
                // Translators: an alert that ended because its rule was switched off or its
                // sensor hidden, within a minute of beginning; the second %s is a time
                return fmt(_('%s, at %s (no longer watched)'), title, start);
            }
            // Translators: an alert that ended because its rule was switched off or its
            // sensor hidden: "<alert>, <start time> to <end time> (no longer watched)"
            return fmt(_('%s, %s to %s (no longer watched)'), title, start, end);
        }
        if (oneMinute) {
            // Translators: an alert that began and ended within one minute; the second %s is a time
            return fmt(_('%s, at %s'), title, start);
        }
        // Translators: an alert that has ended: "<alert>, <start time> to <end time>"
        return fmt(_('%s, %s to %s'), title, start, end);
    }

    return {categoryTitles, chipTitle, channelLabel, alertMessage, recoveryMessage, historyLine};
}
