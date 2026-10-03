// SPDX-License-Identifier: GPL-2.0-or-later
// Core Sentinel: honest CPU load over physical cores, resource pressure, and
// hardware health (temperatures, fans, disks) with alerts.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Monitor} from './lib/monitor.js';
import {AlertEngine, SpinTracker, buildChecks} from './lib/alerts.js';
import {pendingReads} from './lib/io.js';
import {parseOverrides} from './lib/overrides.js';
import {makeLabels} from './lib/labels.js';
import {Indicator} from './ui/indicator.js';
import {Notifier} from './ui/notifier.js';

/** Alerts that stay on screen until dismissed: the hardware may be in danger. */
const CRITICAL_TYPES = new Set(['fan-stall', 'fan-stopped', 'temp', 'thrash']);

/**
 * A reading still in flight after this long is given up on: a file that never
 * answers (a hung driver, a dying disk) must not freeze everything else. Its
 * reads then fail at once until it answers (lib/io.js).
 */
const STALL_SECONDS = 15;

function readAlertSettings(settings) {
    return {
        alertFan: settings.get_boolean('alert-fan'),
        fanStallPwm: settings.get_uint('fan-stall-pwm'),
        fanStallSeconds: settings.get_uint('fan-stall-seconds'),
        alertTemp: settings.get_boolean('alert-temp'),
        alertDisk: settings.get_boolean('alert-disk'),
        diskFreePercent: settings.get_uint('disk-free-percent'),
        diskIgnore: new Set(settings.get_strv('disk-alert-ignore')),
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
        this._spin = new SpinTracker();
        this._notifier = new Notifier(this.metadata.name,
            Gio.icon_new_for_string(`${this.path}/icons/core-sentinel-symbolic.svg`));
        this._indicator = new Indicator(this, this._labels);
        this._indicator.setPanelItems(this._settings.get_strv('panel-items'));
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._sessionModeId = Main.sessionMode.connect('updated', () => this._syncLocked());
        this._syncLocked();

        this._timerId = 0;
        this._tickId = 0;
        this._busySince = 0;
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

    /** The top-bar button (readings, mount points, Settings) stays off the lock screen. */
    _syncLocked() {
        const locked = Main.sessionMode.isLocked;
        if (locked)
            this._indicator.menu.close();
        this._indicator.container.visible = !locked;
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
        const now = GLib.get_monotonic_time() / 1e6;
        if (this._busySince) {
            if (now - this._busySince < STALL_SECONDS) // the previous reading is still in flight
                return;
            console.warn(`Core Sentinel: a reading has not finished in ${STALL_SECONDS} s; ` +
                `going on without: ${pendingReads().join(', ') || 'nothing pending'}`);
        }
        const tickId = ++this._tickId;
        this._busySince = now;
        const monitor = this._monitor;
        try {
            const snapshot = await monitor.sample();
            if (this._monitor !== monitor || tickId !== this._tickId) // disabled, or given up on
                return;
            this._process(snapshot);
        } catch (e) {
            logError(e, 'Core Sentinel: reading failed');
        } finally {
            if (tickId === this._tickId)
                this._busySince = 0;
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
        const connected = this._spin.update(spinning, snapshot.time);
        if (connected.length > 0) {
            connected.forEach(key => knownFans.add(key));
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

    // Core Sentinel stays enabled on the lock screen (session mode
    // unlock-dialog): a fan that stops or a part that overheats while the user
    // is away must still raise its alarm, shown on the lock screen, and an
    // alert that is still on must not be announced again at every unlock. The
    // top-bar button is hidden while the screen is locked (_syncLocked).
    disable() {
        if (this._timerId) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
        Main.sessionMode.disconnect(this._sessionModeId);
        this._settings.disconnect(this._settingsChangedId);
        this._indicator.destroy();
        this._notifier.destroy();
        this._indicator = null;
        this._notifier = null;
        this._alerts = null;
        this._spin = null;
        this._monitor = null;
        this._labels = null;
        this._settings = null;
    }
}
