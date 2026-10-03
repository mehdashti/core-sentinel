// SPDX-License-Identifier: GPL-2.0-or-later
// Preferences: what the top bar shows, alert rules, and per-sensor settings.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {scanHwmon, readChips} from './lib/hwmon.js';
import {listGpus} from './lib/gpu.js';
import {StorageSampler} from './lib/storage.js';
import {parseOverrides, withOverride} from './lib/overrides.js';
import {makeLabels} from './lib/labels.js';
import {fmt, formatBytes, formatReading} from './lib/format.js';
import {PANEL_ITEMS} from './lib/panel.js';

/** Shipped with the extension: an icon theme may lack any given stock icon. */
const ICON = 'core-sentinel-symbolic';

/**
 * A subtitle that opens with a number or a Latin name ("91.3 GiB free...",
 * "temp1 · 44°C") would be laid out left-to-right in an RTL locale and scramble
 * its translated words; a leading RLM sets the base direction, as in the menu.
 */
function rtl(text) {
    return Gtk.Widget.get_default_direction() === Gtk.TextDirection.RTL ? `\u200F${text}` : text;
}

function adjustment(lower, upper, step, value) {
    const adj = new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10});
    if (value !== undefined)
        adj.set_value(value);
    return adj;
}

function boundSpinRow(settings, key, title, subtitle, lower, upper, step = 1) {
    const row = new Adw.SpinRow({title, subtitle, adjustment: adjustment(lower, upper, step)});
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function boundSwitchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function group(page, title, description = '') {
    const g = new Adw.PreferencesGroup({title, description});
    page.add(g);
    return g;
}

export default class CoreSentinelPreferences extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings; // lives as long as the window
        window.set_default_size(640, 760);
        const icons = Gtk.IconTheme.get_for_display(window.get_display());
        if (!icons.get_search_path().includes(`${this.path}/icons`))
            icons.add_search_path(`${this.path}/icons`);
        window.add(this._generalPage(settings));
        window.add(await this._alertsPage(settings));
        window.add(await this._sensorsPage(settings));
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        group(page, _('Readings')).add(boundSpinRow(settings, 'update-interval',
            _('Update interval'), _('Seconds between readings'), 1, 30));

        const bar = group(page, _('Top bar'), _('What the top bar shows. The menu always shows everything.'));
        const titles = {
            'cpu': _('CPU load over physical cores'),
            'pressure': _('Pressure dots for CPU, memory and I/O'),
            'cpu-temp': _('CPU temperature'),
            'memory': _('Memory use'),
            'gpu': _('GPU load'),
            'alert': _('Warning icon while an alert is active'),
        };
        for (const id of PANEL_ITEMS) {
            const row = new Adw.SwitchRow({title: titles[id], active: settings.get_strv('panel-items').includes(id)});
            row.connect('notify::active', () => {
                const items = new Set(settings.get_strv('panel-items'));
                if (row.active)
                    items.add(id);
                else
                    items.delete(id);
                settings.set_strv('panel-items', PANEL_ITEMS.filter(i => items.has(i)));
            });
            bar.add(row);
        }
        return page;
    }

    async _alertsPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Alerts'), icon_name: 'dialog-warning-symbolic'});

        const fans = group(page, _('Fans'),
            _('A fan that has never been seen spinning is treated as not connected and raises no alerts.'));
        fans.add(boundSwitchRow(settings, 'alert-fan', _('Alert when a fan stalls or stops')));
        fans.add(boundSpinRow(settings, 'fan-stall-pwm', _('Stall threshold'),
            _('PWM duty (%) above which a fan reporting 0 RPM counts as stalled'), 1, 100));
        fans.add(boundSpinRow(settings, 'fan-stall-seconds', _('Grace period'),
            _('Seconds a fan problem must last before an alert'), 3, 300));

        group(page, _('Temperatures'),
            _('Each sensor uses the limit its hardware reports. Set your own on the Sensors page.'))
            .add(boundSwitchRow(settings, 'alert-temp', _('Alert when a sensor reaches its limit')));

        const disks = group(page, _('Storage'));
        disks.add(boundSwitchRow(settings, 'alert-disk', _('Alert when a filesystem is almost full')));
        disks.add(boundSpinRow(settings, 'disk-free-percent', _('Free space threshold'),
            _('Alert below this much free space (%)'), 1, 50));
        await this._filesystemRows(page, settings);

        const memory = group(page, _('Memory'));
        memory.add(boundSwitchRow(settings, 'alert-swap', _('Alert when memory spills into swap on disk')));
        memory.add(boundSpinRow(settings, 'swap-alert-mib', _('Swap threshold'),
            _('Swap on disk (MiB) that triggers the alert'), 64, 1048576, 64));
        memory.add(boundSwitchRow(settings, 'alert-thrash', _('Alert when the system thrashes')));
        memory.add(boundSpinRow(settings, 'thrash-percent', _('Thrashing threshold'),
            _('Share of time (%) all tasks were stalled on memory, 10 s average'), 1, 100));

        const pressure = group(page, _('Pressure'), _('0 turns an alert off.'));
        pressure.add(boundSpinRow(settings, 'cpu-pressure-percent', _('CPU saturation'),
            _('Share of time (%) tasks waited for a CPU, 1 min average'), 0, 100));
        pressure.add(boundSpinRow(settings, 'io-pressure-percent', _('I/O bottleneck'),
            _('Share of time (%) all tasks were stalled on I/O, 10 s average'), 0, 100));

        group(page, _('Notifications')).add(
            boundSwitchRow(settings, 'notify-recovery', _('Notify when a problem is over')));
        return page;
    }

    async _filesystemRows(page, settings) {
        const g = group(page, _('Filesystems to watch'),
            _('Switch off a filesystem that is meant to stay nearly full, such as a small EFI partition.'));
        settings.bind('alert-disk', g, 'sensitive', Gio.SettingsBindFlags.GET);
        const {filesystems} = await new StorageSampler().sample();
        const mounted = new Map(filesystems.map(fs => [fs.mountpoint, fs]));
        const ignored = new Set(settings.get_strv('disk-alert-ignore'));
        for (const mountpoint of [...new Set([...mounted.keys(), ...ignored])].sort()) {
            const fs = mounted.get(mountpoint);
            const row = new Adw.SwitchRow({
                title: mountpoint,
                subtitle: fs ? rtl(fmt(_('%s free of %s'), formatBytes(fs.free), formatBytes(fs.size))) : _('not mounted'),
                active: !ignored.has(mountpoint),
            });
            row.connect('notify::active', () => {
                const next = new Set(settings.get_strv('disk-alert-ignore'));
                if (row.active)
                    next.delete(mountpoint);
                else
                    next.add(mountpoint);
                settings.set_strv('disk-alert-ignore', [...next].sort());
            });
            g.add(row);
        }
    }

    async _sensorsPage(settings) {
        const page = new Adw.PreferencesPage({title: _('Sensors'), icon_name: ICON});
        group(page, '', _('Rename or hide each sensor and set its alert limits. Changes apply at once.'));

        const labels = makeLabels(_);
        const [chips, gpus] = await Promise.all([scanHwmon(), listGpus()]);
        const reads = await readChips(chips);
        const known = new Set(settings.get_strv('known-fans'));
        chips.forEach((chip, i) => {
            const g = group(page, labels.chipTitle(chip, gpus), chip.key);
            for (const channel of chip.channels)
                g.add(this._sensorRow(settings, channel, reads[i], known));
        });
        return page;
    }

    _sensorRow(settings, channel, read, known) {
        const current = () => parseOverrides(settings.get_string('sensor-overrides'));
        const set = (field, value) => settings.set_string('sensor-overrides',
            JSON.stringify(withOverride(current(), channel.key, field, value)));
        const o = current()[channel.key] ?? {};

        const value = read.asleep ? null : read.values.get(channel.key)?.value ?? null;
        const status = channel.kind === 'fan' && value === 0 && !known.has(channel.key)
            ? _('not connected (never seen spinning)')
            : formatReading(channel.kind, value);
        const row = new Adw.ExpanderRow({title: o.label || channel.label, subtitle: rtl(`${channel.label} · ${status}`)});

        const show = new Adw.SwitchRow({title: _('Show'), active: !o.hidden});
        show.connect('notify::active', () => set('hidden', !show.active));
        row.add_row(show);

        const name = new Adw.EntryRow({title: _('Display name'), text: o.label ?? '', show_apply_button: true});
        name.connect('apply', () => {
            const text = name.text.trim();
            set('label', text);
            row.title = text || channel.label;
        });
        row.add_row(name);

        if (channel.kind === 'fan') {
            const min = new Adw.SpinRow({
                title: _('Minimum RPM'),
                subtitle: _('Alert when it turns slower than this; 0 turns it off'),
                adjustment: adjustment(0, 10000, 50, o.minRpm ?? 0),
            });
            min.connect('notify::value', () => set('minRpm', Math.round(min.value)));
            row.add_row(min);

            const zero = new Adw.SwitchRow({
                title: _('Stops on its own'),
                subtitle: _('A zero-RPM fan (some GPU and PSU fans): stopping is not an alarm'),
                active: o.zeroRpm ?? false,
            });
            zero.connect('notify::active', () => set('zeroRpm', zero.active));
            row.add_row(zero);

            if (known.has(channel.key)) {
                const forget = new Adw.ActionRow({
                    title: _('Forget this fan'),
                    subtitle: _('Treat it as not connected until it is seen spinning again'),
                });
                const button = new Gtk.Button({label: _('Forget'), valign: Gtk.Align.CENTER});
                button.connect('clicked', () => {
                    settings.set_strv('known-fans', settings.get_strv('known-fans').filter(k => k !== channel.key));
                    forget.sensitive = false;
                });
                forget.add_suffix(button);
                row.add_row(forget);
            }
        } else if (channel.kind === 'temp') {
            const limit = new Adw.SpinRow({
                title: _('Alert at (°C)'),
                subtitle: channel.limit
                    ? fmt(_('0 uses the hardware limit, %s'), formatReading('temp', channel.limit))
                    : _('0 means no alert: the hardware reports no limit'),
                adjustment: adjustment(0, 125, 1, o.maxTemp ?? 0),
            });
            limit.connect('notify::value', () => set('maxTemp', Math.round(limit.value)));
            row.add_row(limit);
        }
        return row;
    }
}
