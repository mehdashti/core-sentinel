// Real Cores — top-bar CPU meter over PHYSICAL cores (SMT sibling threads merged).
// Stock monitors average the logical cpus; this reads the kernel's sibling map and
// shows one value per physical core. A core's busy% = min(100, sum of its threads'
// busy%) — exact when siblings don't overlap, a slight overcount when they do.
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const TICK_SECONDS = 2;

function readFile(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

function topology() {
    const n = GLib.get_num_processors();
    const map = new Map();
    for (let c = 0; c < n; c++) {
        const core = readFile(`/sys/devices/system/cpu/cpu${c}/topology/core_id`);
        const pkg = readFile(`/sys/devices/system/cpu/cpu${c}/topology/physical_package_id`);
        if (core === null || pkg === null)
            continue;
        const key = `${pkg.trim()}:${core.trim()}`;
        if (!map.has(key))
            map.set(key, []);
        map.get(key).push(c);
    }
    return [...map.values()]
        .map(a => a.sort((x, y) => x - y))
        .sort((a, b) => a[0] - b[0]);
}

function sample() {
    const txt = readFile('/proc/stat');
    const d = new Map();
    if (!txt)
        return d;
    for (const line of txt.split('\n')) {
        const m = line.match(/^cpu(\d+)\s+(.*)$/);
        if (!m)
            continue;
        const f = m[2].trim().split(/\s+/).map(Number);
        const total = f.slice(0, 8).reduce((a, b) => a + b, 0);
        const idle = (f[3] || 0) + (f[4] || 0);
        d.set(Number(m[1]), [total, idle]);
    }
    return d;
}

const BAR_FULL = '▰';
const BAR_EMPTY = '▱';

export default class RealCoresExtension extends Extension {
    enable() {
        this._cores = topology();
        this._prev = sample();

        this._indicator = new PanelMenu.Button(0.0, 'Real Cores', false);
        this._label = new St.Label({
            text: '⬡ …%',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'realcores-panel-label',
        });
        this._indicator.add_child(this._label);

        this._header = new PopupMenu.PopupMenuItem(
            `REAL cores: ${this._cores.length}`, {reactive: false});
        this._header.label.set_style('font-family: monospace; font-weight: bold;');
        this._indicator.menu.addMenuItem(this._header);
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rows = [];
        for (const sibs of this._cores) {
            const item = new PopupMenu.PopupMenuItem('…', {reactive: false});
            item.label.set_style('font-family: monospace;');
            this._indicator.menu.addMenuItem(item);
            this._rows.push(item);
        }
        this._indicator.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._footer = new PopupMenu.PopupMenuItem('…', {reactive: false});
        this._footer.label.set_style('font-family: monospace;');
        this._indicator.menu.addMenuItem(this._footer);

        Main.panel.addToStatusArea('realcores', this._indicator);

        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, TICK_SECONDS, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        this._tick();
    }

    _tick() {
        const cur = sample();
        const busy = new Map();
        for (const [k, [tot, idle]] of cur) {
            const p = this._prev.get(k);
            if (!p) {
                busy.set(k, 0);
                continue;
            }
            const dt = tot - p[0];
            const di = idle - p[1];
            busy.set(k, dt > 0 ? (100 * (dt - di)) / dt : 0);
        }
        this._prev = cur;

        let sumReal = 0;
        let sumLogical = 0;
        let nLogical = 0;
        for (const v of busy.values()) {
            sumLogical += v;
            nLogical += 1;
        }
        this._cores.forEach((sibs, i) => {
            const v = Math.min(100, sibs.reduce((a, c) => a + (busy.get(c) || 0), 0));
            sumReal += v;
            const k = Math.round(v / 10);
            const bar = BAR_FULL.repeat(k) + BAR_EMPTY.repeat(10 - k);
            const cpus = sibs.join(',');
            this._rows[i].label.set_text(
                `core ${String(i).padStart(2)} [${cpus.padEnd(5)}] ${bar} ${v.toFixed(0).padStart(3)}%`);
        });
        const avgReal = this._cores.length ? sumReal / this._cores.length : 0;
        const avgLogical = nLogical ? sumLogical / nLogical : 0;
        this._label.set_text(`⬡ ${avgReal.toFixed(0)}%`);
        this._footer.label.set_text(
            `REAL avg ${avgReal.toFixed(1)}%   (logical ${avgLogical.toFixed(1)}%)`);
    }

    disable() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._label = null;
        this._rows = [];
        this._header = null;
        this._footer = null;
        this._prev = null;
    }
}
