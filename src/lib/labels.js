// SPDX-License-Identifier: GPL-2.0-or-later
// Human-readable names and alert texts. The gettext function is passed in, so
// the shell (extension.js) and the preferences app (prefs.js), which each have
// their own, share one set of strings.

import {fmt, formatBytes, formatPercent, formatReading, truncate} from './format.js';

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
            return fmt(_('RAM module %s'), chip.devId);
        case 'storage':
            return chip.name === 'nvme' ? `NVMe ${chip.devId}` : fmt(_('Disk %s'), chip.devId);
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
                title: fmt(_('Disk almost full: %s'), p.mountpoint),
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

    return {categoryTitles, chipTitle, channelLabel, alertMessage, recoveryMessage};
}
