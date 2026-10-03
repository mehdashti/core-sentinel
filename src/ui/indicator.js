// SPDX-License-Identifier: GPL-2.0-or-later
// The top-bar button and its menu. The panel part is redrawn every tick; the
// menu only while it is open (and once when it opens), so a closed menu costs
// nothing.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fmt, formatBytes, formatNumber, formatPercent, formatRate, formatReading, isolate, meter, truncate}
    from '../lib/format.js';
import {PANEL_ITEMS} from '../lib/panel.js';

// PSI "some" avg10 thresholds for the pressure dots, in %
const PRESSURE_WARN = 5;
const PRESSURE_CRIT = 25;

// A row's base direction comes from its first strong character, so in an RTL
// locale a row opening with "RX 550" or "nvme0n1" would be laid out
// left-to-right and scramble its translated words. A leading RLM fixes the base.
const RLM = '\u200F';

/** A run of read-only menu rows that grows and shrinks with its data. */
class RowList {
    constructor(menu) {
        this._menu = menu;
        this._items = [];
        this._prefix = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL ? RLM : '';
    }

    get length() {
        return this._items.length;
    }

    /** @param {Array<{text: string, bad?: boolean, dim?: boolean, mono?: boolean}>} rows */
    set(rows) {
        while (this._items.length > rows.length)
            this._items.pop().destroy();
        while (this._items.length < rows.length) {
            const item = new PopupMenu.PopupMenuItem('', {reactive: false, can_focus: false});
            item.add_style_class_name('cs-item');
            this._menu.addMenuItem(item);
            this._items.push(item);
        }
        rows.forEach((row, i) => {
            const label = this._items[i].label;
            label.text = row.mono ? row.text : this._prefix + row.text;
            label.style_class = ['cs-row', row.mono && 'cs-mono', row.bad && 'cs-bad', row.dim && 'cs-dim']
                .filter(Boolean).join(' ');
        });
    }
}

function panelLabel(text) {
    return new St.Label({text, y_align: Clutter.ActorAlign.CENTER, style_class: 'cs-panel-label'});
}

function pressureLevel(record) {
    const value = record?.some?.avg10;
    if (value === undefined)
        return 'off';
    if (value >= PRESSURE_CRIT)
        return 'crit';
    return value >= PRESSURE_WARN ? 'warn' : 'ok';
}

export const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init(extension, labels) {
        super._init(0.0, 'Core Sentinel', false);
        this._extension = extension;
        this._labels = labels;
        this._last = null;
        this._enabled = new Set(['cpu']);
        this._hasAlerts = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box cs-panel'});
        this.add_child(box);
        const dots = new St.BoxLayout({style_class: 'cs-dots', y_align: Clutter.ActorAlign.CENTER});
        this._dots = ['cpu', 'memory', 'io'].map(() => {
            const dot = new St.Widget({style_class: 'cs-dot cs-dot-off', y_align: Clutter.ActorAlign.CENTER});
            dots.add_child(dot);
            return dot;
        });
        this._panel = {
            'cpu': panelLabel('⬡ –'),
            'pressure': dots,
            'cpu-temp': panelLabel('–°'),
            'memory': panelLabel('▦ –'),
            'gpu': panelLabel('▣ –'),
            'alert': new St.Icon({
                icon_name: 'dialog-warning-symbolic',
                style_class: 'system-status-icon cs-alert-icon',
            }),
        };
        for (const id of PANEL_ITEMS)
            box.add_child(this._panel[id]);

        this._buildMenu();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._last)
                this._renderMenu();
        });
    }

    /** @param {string[]} ids panel items to show */
    setPanelItems(ids) {
        this._enabled = new Set(ids.filter(id => PANEL_ITEMS.includes(id)));
        if ([...this._enabled].every(id => id === 'alert'))
            this._enabled.add('cpu'); // never leave the button without a permanent face
        this._applyVisibility();
    }

    _applyVisibility() {
        for (const id of PANEL_ITEMS) {
            this._panel[id].visible = this._enabled.has(id) &&
                (id !== 'alert' || this._hasAlerts);
        }
    }

    _buildMenu() {
        const menu = this.menu;
        const section = () => {
            const s = new PopupMenu.PopupMenuSection();
            menu.addMenuItem(s);
            return s;
        };
        const block = (title, ...subTitles) => {
            const heading = new PopupMenu.PopupSeparatorMenuItem(title);
            menu.addMenuItem(heading);
            const rows = new RowList(section());
            const subs = subTitles.map(subTitle => {
                const item = new PopupMenu.PopupSubMenuMenuItem(subTitle);
                menu.addMenuItem(item);
                return {item, title: subTitle, rows: new RowList(item.menu)};
            });
            return {heading, rows, subs};
        };

        this._alertRows = new RowList(section());
        this._cpu = block(_('Processor'), _('Per-core load'));
        this._memory = block(_('Memory'));
        this._storage = block(_('Storage'));
        this._gpu = block(_('Graphics'));
        this._sensors = block(_('Sensors'), _('Temperatures'), _('Fans'), _('Voltages and power'));

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem(_('Settings'));
        settings.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(settings);
    }

    /**
     * @param {object} snapshot Monitor.sample() result
     * @param {object} state {overrides, knownFans, alerts}
     */
    update(snapshot, state) {
        this._last = {snapshot, state};
        this._renderPanel();
        if (this.menu.isOpen)
            this._renderMenu();
    }

    _renderPanel() {
        const {snapshot: s, state} = this._last;
        if (s.cpu)
            this._panel.cpu.text = `⬡ ${formatPercent(s.cpu.real)}`;
        ['cpu', 'memory', 'io'].forEach((resource, i) => {
            this._dots[i].style_class = `cs-dot cs-dot-${pressureLevel(s.pressure?.[resource])}`;
        });
        const cpuTemps = s.chips
            .filter(chip => chip.category === 'cpu' && !chip.asleep)
            .flatMap(chip => chip.channels
                .filter(ch => ch.kind === 'temp' && !state.overrides[ch.key]?.hidden)
                .map(ch => chip.values.get(ch.key)?.value))
            .filter(v => v !== null && v !== undefined);
        this._panel['cpu-temp'].text = cpuTemps.length ? `${formatNumber(Math.max(...cpuTemps))}°` : '–°';
        if (s.memory?.total)
            this._panel.memory.text = `▦ ${formatPercent(100 * s.memory.used / s.memory.total)}`;
        const busy = s.gpus.filter(g => !g.asleep && g.busy !== null).map(g => g.busy);
        this._panel.gpu.text = busy.length ? `▣ ${formatPercent(Math.max(...busy))}` : '▣ –';
        this._hasAlerts = state.alerts.length > 0;
        this._applyVisibility();
    }

    _renderMenu() {
        const {snapshot: s, state} = this._last;
        const active = new Set(state.alerts.map(a => a.key));

        this._alertRows.set(state.alerts.map(alert => ({
            text: `⚠ ${this._labels.alertMessage(alert).title}`,
            bad: true,
        })));
        this._renderCpu(s, active);
        this._renderMemory(s, active);
        this._renderStorage(s, active);
        this._renderGpus(s, state);
        this._renderSensors(s, state, active);
    }

    _renderCpu(s, active) {
        const rows = [];
        if (s.cpu) {
            rows.push({
                text: fmt(_('%s on physical cores, %s on logical threads'),
                    formatPercent(s.cpu.real, 1), formatPercent(s.cpu.logical, 1)),
            });
            rows.push({text: fmt(_('%d cores, %d threads'), s.cpu.cores, s.cpu.threads)});
        }
        const pressure = s.pressure?.cpu?.some;
        if (pressure) {
            rows.push({
                text: fmt(_('Tasks waiting for a CPU: %s (10 s), %s (1 min)'),
                    formatPercent(pressure.avg10, 1), formatPercent(pressure.avg60, 1)),
                bad: active.has('cpu-pressure'),
            });
        }
        this._cpu.rows.set(rows);
        this._cpu.subs[0].rows.set((s.cpu?.perCore ?? []).map((core, i) => ({
            text: `${fmt(_('Core %d'), i).padEnd(8)} ${meter(core.percent)} ${formatPercent(core.percent).padStart(4)}  ${core.cpus.map(cpu => formatNumber(cpu)).join('+')}`,
            mono: true,
        })));
    }

    _renderMemory(s, active) {
        const rows = [];
        const mem = s.memory;
        if (mem) {
            rows.push({
                text: fmt(_('Used %s of %s (%s), %s available'), formatBytes(mem.used),
                    formatBytes(mem.total), formatPercent(100 * mem.used / mem.total),
                    formatBytes(mem.available)),
            });
            if (mem.zram) {
                rows.push({
                    text: mem.zram.ratio
                        ? fmt(_('zram: %s stored in %s of RAM (%s:1)'), formatBytes(mem.zram.used),
                            formatBytes(mem.zram.ram), formatNumber(mem.zram.ratio, 1))
                        : fmt(_('zram: %s of %s used'), formatBytes(mem.zram.used), formatBytes(mem.zram.size)),
                });
            }
            if (mem.diskSwap) {
                rows.push({
                    text: fmt(_('Swap on disk: %s of %s'), formatBytes(mem.diskSwap.used),
                        formatBytes(mem.diskSwap.size)),
                    bad: active.has('swap'),
                });
            }
        }
        const pressure = s.pressure?.memory;
        if (pressure?.some) {
            rows.push({
                text: fmt(_('Stalled on memory: %s some, %s all tasks (10 s)'),
                    formatPercent(pressure.some.avg10, 1), formatPercent(pressure.full?.avg10 ?? 0, 1)),
                bad: active.has('thrash'),
            });
        }
        this._memory.rows.set(rows);
    }

    _renderStorage(s, active) {
        const rows = [];
        for (const fs of s.storage?.filesystems ?? []) {
            rows.push({
                text: fmt(_('%s: %s free of %s (%s used)'), isolate(fs.mountpoint), formatBytes(fs.free),
                    formatBytes(fs.size), formatPercent(fs.percent)),
                bad: active.has(`disk:${fs.mountpoint}`),
            });
        }
        for (const disk of s.storage?.disks ?? []) {
            rows.push({
                text: fmt(_('%s: read %s, write %s, busy %s'), disk.name, formatRate(disk.readBps),
                    formatRate(disk.writeBps), formatPercent(disk.busy)),
            });
        }
        const pressure = s.pressure?.io;
        if (pressure?.some) {
            rows.push({
                text: fmt(_('Stalled on I/O: %s some, %s all tasks (10 s)'),
                    formatPercent(pressure.some.avg10, 1), formatPercent(pressure.full?.avg10 ?? 0, 1)),
                bad: active.has('io-pressure'),
            });
        }
        this._storage.rows.set(rows);
    }

    _renderGpus(s, state) {
        const rows = [];
        for (const gpu of s.gpus) {
            const name = truncate(gpu.name, 32);
            if (gpu.asleep) {
                rows.push({text: fmt(_('%s: asleep'), name), dim: true});
                continue;
            }
            rows.push({
                text: fmt(_('%s: busy %s, VRAM %s of %s'), name, formatPercent(gpu.busy),
                    formatBytes(gpu.vramUsed), formatBytes(gpu.vramTotal)),
            });
            const chip = s.chips.find(c => c.devId === gpu.slot && !c.asleep);
            const parts = [];
            for (const kind of ['temp', 'fan', 'power']) {
                const ch = chip?.channels.find(c => c.kind === kind && (kind !== 'power' || c.hasCap) &&
                    !state.overrides[c.key]?.hidden);
                const value = ch ? chip.values.get(ch.key)?.value : null;
                if (value !== null && value !== undefined)
                    parts.push(formatReading(kind, value));
            }
            if (parts.length)
                rows.push({text: `    ${parts.join(' · ')}`});
        }
        this._gpu.rows.set(rows);
        this._gpu.heading.visible = rows.length > 0;
    }

    _renderSensors(s, state, active) {
        const temps = [];
        const fans = [];
        const others = [];
        for (const chip of s.chips) {
            if (chip.asleep)
                continue;
            for (const ch of chip.channels) {
                const o = state.overrides[ch.key] ?? {};
                const reading = chip.values.get(ch.key);
                if (o.hidden || !reading || reading.value === null)
                    continue;
                const label = this._labels.channelLabel(chip, ch, state.overrides, s.gpus);
                if (ch.kind === 'temp') {
                    const limit = o.maxTemp > 0 ? o.maxTemp : ch.limit;
                    const suffix = limit ? `  (${fmt(_('limit %s'), formatReading('temp', limit))})` : '';
                    temps.push({
                        text: `${label}: ${formatReading('temp', reading.value)}${suffix}`,
                        bad: active.has(`temp:${ch.key}`),
                    });
                } else if (ch.kind === 'fan') {
                    if (reading.value === 0 && !state.knownFans.has(ch.key)) {
                        fans.push({text: fmt(_('%s: not connected'), label), dim: true});
                    } else {
                        const pwm = reading.pwm === null ? '' : ` · ${formatPercent(reading.pwm)}`;
                        fans.push({
                            text: `${label}: ${formatReading('fan', reading.value)}${pwm}`,
                            bad: active.has(`fan:${ch.key}`) || active.has(`fan-low:${ch.key}`),
                        });
                    }
                } else {
                    others.push({text: `${label}: ${formatReading(ch.kind, reading.value)}`});
                }
            }
        }
        [temps, fans, others].forEach((rows, i) => {
            const sub = this._sensors.subs[i];
            sub.rows.set(rows);
            sub.item.label.text = `${sub.title} (${formatNumber(rows.length)})`;
            sub.item.visible = rows.length > 0;
        });
    }
});
