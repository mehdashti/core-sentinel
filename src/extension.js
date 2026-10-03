// SPDX-License-Identifier: GPL-2.0-or-later
// Core Sentinel: honest CPU load over physical cores, resource pressure, and
// hardware health (temperatures, fans, disks) with alerts.

import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Monitor} from './lib/monitor.js';
import {AlertEngine, buildChecks} from './lib/alerts.js';
import {parseOverrides} from './lib/overrides.js';
import {makeLabels} from './lib/labels.js';
import {Indicator} from './ui/indicator.js';
import {Notifier} from './ui/notifier.js';

/** Alerts that stay on screen until dismissed: the hardware may be in danger. */
const CRITICAL_TYPES = new Set(['fan-stall', 'fan-stopped', 'temp', 'thrash']);

function readAlertSettings(settings) {
    return {
        alertFan: settings.get_boolean('alert-fan'),
        fanStallPwm: settings.get_uint('fan-stall-pwm'),
        fanStallSeconds: settings.get_uint('fan-stall-seconds'),
        alertTemp: settings.get_boolean('alert-temp'),
        alertDisk: settings.get_boolean('alert-disk'),
        diskFreePercent: settings.get_uint('disk-free-percent'),
        alertSwap: settings.get_boolean('alert-swap'),
        swapAlertMiB: settings.get_uint('swap-alert-mib'),
        alertThrash: settings.get_boolean('alert-thrash'),
        thrashPercent: settings.get_uint('thrash-percent'),
        cpuPressurePercent: settings.get_uint('cpu-pressure-percent'),
        ioPressurePercent: settings.get_uint('io-pressure-percent'),
    };
}

export default class CoreSentinelExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._labels = makeLabels(_);
        this._monitor = new Monitor();
        this._alerts = new AlertEngine();
        this._notifier = new Notifier(this.metadata.name);
        this._indicator = new Indicator(this, this._labels);
        this._indicator.setPanelItems(this._settings.get_strv('panel-items'));
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._timerId = 0;
        this._busy = false;
        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (key === 'update-interval')
                this._restartTimer();
            else if (key === 'panel-items')
                this._indicator.setPanelItems(this._settings.get_strv('panel-items'));
        });

        const monitor = this._monitor;
        monitor.init().then(() => {
            if (this._monitor !== monitor) // disabled while starting up
                return;
            this._restartTimer();
            this._tick();
        }).catch(e => logError(e, 'Core Sentinel: startup failed'));
    }

    _restartTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        const seconds = Math.max(1, this._settings.get_uint('update-interval'));
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    async _tick() {
        if (this._busy) // the previous reading is still in flight
            return;
        this._busy = true;
        const monitor = this._monitor;
        try {
            const snapshot = await monitor.sample();
            if (this._monitor !== monitor)
                return;
            this._process(snapshot);
        } catch (e) {
            logError(e, 'Core Sentinel: reading failed');
        } finally {
            this._busy = false;
        }
    }

    _process(snapshot) {
        const overrides = parseOverrides(this._settings.get_string('sensor-overrides'));
        const knownFans = new Set(this._settings.get_strv('known-fans'));
        const {checks, spinning} = buildChecks(snapshot, {
            overrides,
            knownFans,
            settings: readAlertSettings(this._settings),
            labelOf: (chip, channel) => this._labels.channelLabel(chip, channel, overrides, snapshot.gpus),
        });
        if (spinning.length > 0) {
            spinning.forEach(key => knownFans.add(key));
            this._settings.set_strv('known-fans', [...knownFans]);
        }

        const {raised, cleared} = this._alerts.update(checks, snapshot.time);
        for (const alert of raised)
            this._notifier.raise(alert.key, this._labels.alertMessage(alert), CRITICAL_TYPES.has(alert.type));
        for (const alert of cleared) {
            if (this._settings.get_boolean('notify-recovery'))
                this._notifier.recover(alert.key, this._labels.recoveryMessage(alert));
            else
                this._notifier.withdraw(alert.key);
        }

        this._indicator.update(snapshot, {overrides, knownFans, alerts: this._alerts.active});
    }

    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        this._settings.disconnect(this._settingsChangedId);
        this._indicator.destroy();
        this._notifier.destroy();
        this._indicator = null;
        this._notifier = null;
        this._alerts = null;
        this._monitor = null;
        this._labels = null;
        this._settings = null;
    }
}
