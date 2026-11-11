// SPDX-License-Identifier: GPL-2.0-or-later
// The top-bar button and its menu. The panel part is redrawn every tick; the
// menu only while it is open (and once when it opens), so a closed menu costs
// nothing. The menu is one row per group (Processor, Memory, ...) whose title
// sums it up; a group's details open below its row, so an open group has the
// height of the screen to itself. The process lists are read only while the
// Processor or Memory group is open, on a timer of their own.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fmt, formatBytes, formatId, formatNumber, formatPercent, formatRate, formatReading, isolate, meter,
    truncate} from '../lib/format.js';
import {PANEL_ITEMS} from '../lib/panel.js';
import {ProcessSampler} from '../lib/processes.js';

// PSI "some" avg10 thresholds for the pressure dots, in %
const PRESSURE_WARN = 5;
const PRESSURE_CRIT = 25;

// While the menu is open the process lists are read every PROCESS_SECONDS;
// CPU shares need two readings, so the second comes sooner.
const PROCESS_SECONDS = 2;
const FIRST_SHARES_MS = 1000;
const PROCESS_ROWS = 5;
const PROCESS_NAME_LENGTH = 32;

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

/**
 * A process for a menu row. Its name is the process's own choice: it reaches
 * the label as plain text (never markup), stripped of control characters
 * (lib/processes.js) and isolated, so it cannot turn the row around.
 */
function processName(proc) {
    const name = truncate(proc.name, PROCESS_NAME_LENGTH);
    return isolate(proc.kernel ? `[${name}]` : name);
}

function processRow(proc, value) {
    return {text: `${processName(proc)} (${formatId(proc.pid)}): ${value}`};
}

/** A group's row: its summary, in the alert color while one of its alerts is on. */
function setGroupTitle(group, text, bad) {
    group.item.label.text = text;
    if (bad)
        group.item.label.add_style_class_name('cs-bad');
    else
        group.item.label.remove_style_class_name('cs-bad');
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
    /**
     * @param {Extension} extension
     * @param {object} labels makeLabels() result
     * @param {AlertHistory} alertHistory the session's alerts, for "Recent alerts"
     */
    _init(extension, labels, alertHistory) {
        super._init(0.0, 'Core Sentinel', false);
        this._extension = extension;
        this._labels = labels;
        this._alertHistory = alertHistory;
        // times in the history follow the top-bar clock: 24- or 12-hour
        this._clockSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
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

        this._processes = new ProcessSampler({count: PROCESS_ROWS});
        this._processTimerId = 0;
        this._processRun = 0;

        this._buildMenu();
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                this._stopProcesses();
                return;
            }
            if (this._last)
                this._renderMenu();
        });
        // a menu opens one group at a time; switching groups closes the other
        const withProcesses = [this._cpu, this._memory];
        for (const group of withProcesses) {
            group.item.menu.connect('open-state-changed', (_menu, open) => {
                if (open)
                    this._startProcesses();
                else if (!withProcesses.some(g => g.item.menu.isOpen))
                    this._stopProcesses();
            });
        }
    }

    _onDestroy() {
        this._stopProcesses();
        super._onDestroy();
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
        const section = parent => {
            const s = new PopupMenu.PopupMenuSection();
            parent.addMenuItem(s);
            return s;
        };
        // A group: one row whose title sums it up (set by its render method),
        // opening onto its detail rows and, under small headings, its lists.
        const group = (title, listTitles = []) => {
            const item = new PopupMenu.PopupSubMenuMenuItem(title);
            menu.addMenuItem(item);
            const rows = new RowList(section(item.menu));
            const lists = listTitles.map(listTitle => {
                item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(listTitle));
                return new RowList(section(item.menu));
            });
            return {item, title, rows, lists};
        };

        this._alertRows = new RowList(section(menu));
        this._history = this._buildHistory();
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._cpu = group(_('Processor'), [_('Top processes'), _('Per-core load')]);
        this._memory = group(_('Memory'), [_('Top processes')]);
        this._storage = group(_('Storage'));
        this._gpu = group(_('Graphics'));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._sensors = [group(_('Temperatures')), group(_('Fans')), group(_('Voltages and power'))];

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settings = new PopupMenu.PopupMenuItem(_('Settings'));
        settings.connect('activate', () => this._extension.openPreferences());
        menu.addMenuItem(settings);
    }

    /** "Recent alerts": a submenu of the alert history, with a Clear item below the rows. */
    _buildHistory() {
        const title = _('Recent alerts');
        const item = new PopupMenu.PopupSubMenuMenuItem(title);
        this.menu.addMenuItem(item);
        const rows = new PopupMenu.PopupMenuSection(); // keeps the rows above Clear as they grow
        item.menu.addMenuItem(rows);
        const clear = new PopupMenu.PopupMenuItem(_('Clear'));
        clear.connect('activate', () => {
            this._alertHistory.clear();
            this._renderHistory();
        });
        item.menu.addMenuItem(clear);
        item.visible = false;
        return {item, title, rows: new RowList(rows), clear};
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
        this._renderHistory();
        this._renderCpu(s, active);
        this._renderMemory(s, active);
        this._renderStorage(s, active);
        this._renderGpus(s, state);
        this._renderSensors(s, state, active);
    }

    _renderHistory() {
        const entries = this._alertHistory.entries;
        const timeOpts = {
            hour12: this._clockSettings.get_string('clock-format') === '12h',
            now: Date.now(),
        };
        this._history.rows.set(entries.map(entry => ({
            text: this._labels.historyLine(entry, timeOpts),
            bad: entry.end === null,
            dim: entry.dropped,
        })));
        this._history.item.label.text = `${this._history.title} (${formatNumber(entries.length)})`;
        this._history.item.visible = entries.length > 0;
        this._history.clear.visible = entries.some(entry => entry.end !== null);
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
        setGroupTitle(this._cpu, s.cpu
            ? fmt(_('Processor: %s on physical cores'), formatPercent(s.cpu.real, 1)) : this._cpu.title,
        active.has('cpu-pressure'));
        this._cpu.lists[1].set((s.cpu?.perCore ?? []).map((core, i) => ({
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
        setGroupTitle(this._memory, mem
            ? fmt(_('Memory: %s of %s used'), formatBytes(mem.used), formatBytes(mem.total)) : this._memory.title,
        active.has('swap') || active.has('thrash'));
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
        // the title names one filesystem: one with an alert on, else the root
        const filesystems = s.storage?.filesystems ?? [];
        const shown = filesystems.find(fs => active.has(`disk:${fs.mountpoint}`)) ??
            filesystems.find(fs => fs.mountpoint === '/') ?? filesystems[0];
        setGroupTitle(this._storage, shown
            ? fmt(_('Storage: %s free on %s'), formatBytes(shown.free), isolate(shown.mountpoint))
            : this._storage.title,
        rows.some(row => row.bad));
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
        this._gpu.item.visible = rows.length > 0;
        const busy = s.gpus.filter(g => !g.asleep && g.busy !== null).map(g => g.busy);
        setGroupTitle(this._gpu, busy.length
            ? fmt(_('Graphics: busy %s'), formatPercent(Math.max(...busy))) : _('Graphics: asleep'), false);
    }

    _startProcesses() {
        this._stopProcesses();
        this._processes.reset();
        this._renderProcesses(null);
        this._sampleProcesses(this._processRun);
    }

    _stopProcesses() {
        this._processRun++; // a reading still in flight is dropped
        if (this._processTimerId) {
            GLib.source_remove(this._processTimerId);
            this._processTimerId = 0;
        }
    }

    async _sampleProcesses(run) {
        let result = null;
        try {
            result = await this._processes.sample();
        } catch (e) {
            logError(e, 'Core Sentinel: reading processes failed');
        }
        if (run !== this._processRun) // the menu closed, or the button is gone
            return;
        if (result)
            this._renderProcesses(result);
        const delay = result?.cpu ? PROCESS_SECONDS * 1000 : FIRST_SHARES_MS;
        this._processTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._processTimerId = 0;
            this._sampleProcesses(run);
            return GLib.SOURCE_REMOVE;
        });
    }

    /** @param {object|null} result ProcessSampler.sample(); null until the first arrives */
    _renderProcesses(result) {
        const measuring = {text: _('Measuring…'), dim: true};
        let cpuRows = [measuring];
        if (result?.cpu?.length === 0)
            cpuRows = [{text: _('No process is busy'), dim: true}];
        else if (result?.cpu)
            cpuRows = result.cpu.map(p => processRow(p, formatPercent(p.share, 1)));
        this._cpu.lists[0].set([...cpuRows, {text: _('Shares of the load on physical cores'), dim: true}]);

        const memoryRows = result ? result.memory.map(p => processRow(p, formatBytes(p.memory))) : [measuring];
        this._memory.lists[0].set([...memoryRows,
            {text: _('Private memory in RAM; shared memory is not counted'), dim: true}]);
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
            const group = this._sensors[i];
            group.rows.set(rows);
            setGroupTitle(group, `${group.title} (${formatNumber(rows.length)})`, rows.some(row => row.bad));
            group.item.visible = rows.length > 0;
        });
    }
});
