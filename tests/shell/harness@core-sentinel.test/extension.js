// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only extension, loaded next to Core Sentinel in a headless shell by
// tools/shell-test.sh: it waits for a few readings, screenshots the panel, the
// menu, each submenu, a notification, switching the alert rules off, Recent
// alerts (with a few made-up past alerts), the lock screen and each
// preferences page, and writes a status report.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const UUID = 'core-sentinel@mehdashti.github.io';
const OUT = GLib.getenv('CS_TEST_OUT') ?? '/tmp';

Gio._promisify(Shell.Screenshot.prototype, 'screenshot', 'screenshot_finish');

function sleep(seconds) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, seconds * 1000, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function shot(name) {
    const file = Gio.File.new_for_path(`${OUT}/${name}.png`);
    const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
    await new Shell.Screenshot().screenshot(false, stream);
    stream.close(null);
}

function report(data) {
    GLib.file_set_contents(`${OUT}/report.json`, JSON.stringify(data, null, 2));
}

/**
 * Adds an alert that has already ended to the history, the way extension.js
 * feeds it, so Recent alerts shows each form its rows take.
 *
 * @param {object} ext the Core Sentinel extension object
 * @param {object} alert {key, type, params}
 * @param {number} ago seconds since it began
 * @param {number} lasted seconds it lasted
 */
function pastAlert(ext, alert, ago, lasted) {
    const wall = GLib.get_real_time() / 1000;
    const mono = GLib.get_monotonic_time() / 1e6;
    const raised = {...alert, since: mono - ago};
    ext._history.update({raised: [raised], cleared: [], dropped: []}, wall - ago * 1000, mono - ago);
    ext._history.update({raised: [], cleared: [raised], dropped: []}, wall - (ago - lasted) * 1000,
        mono - ago + lasted);
}

async function click(pointer, x, y) {
    // the first motion of a new virtual pointer lands at y = 0; the second is exact
    for (let i = 0; i < 2; i++) {
        pointer.notify_absolute_motion(GLib.get_monotonic_time(), x, y);
        await sleep(0.3);
    }
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
    await sleep(0.05);
    pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
}

export default class HarnessExtension extends Extension {
    enable() {
        this._run().catch(e => report({error: `${e}\n${e.stack}`}));
    }

    async _run() {
        // Until its startup animation is over the shell covers the screen with
        // an invisible actor, and the clicks on the preferences window below
        // would land on it. Hiding the overview, where the shell starts, while
        // that animation still waits for its first frame stalls it for good
        // (seen with software rendering, as in CI).
        for (let i = 0; i < 30 && Main.layoutManager._startingUp; i++)
            await sleep(1);
        const result = {startupComplete: !Main.layoutManager._startingUp};
        Main.overview.hide();
        await sleep(8);
        const indicator = Main.panel.statusArea[UUID];
        const ext = Main.extensionManager.lookup(UUID);
        if (!indicator) {
            report({error: 'indicator missing', state: ext?.state, extError: `${ext?.error}`});
            return;
        }

        await shot('panel');
        const state = ext.stateObj;
        pastAlert(state, {key: 'harness:fan', type: 'fan-stopped', params: {label: 'Fan 2'}}, 2 * 3600, 120);
        pastAlert(state, {key: 'harness:swap', type: 'swap', params: {used: 2 ** 30}}, 40 * 60, 20);
        pastAlert(state, {key: 'harness:temp', type: 'temp', params: {label: 'CPU', value: 95, limit: 95}},
            26 * 3600, 180);
        indicator.menu.open(false);
        await sleep(3); // one more tick renders the open menu
        await shot('menu');
        // Every group opened in turn. An open group should show its rows, not a
        // sliver: shown is the visible height of its rows, content their full height.
        result.menuHeight = Math.round(indicator.menu.actor.height);
        result.groups = {};
        const groups = {
            cpu: indicator._cpu, memory: indicator._memory, storage: indicator._storage, gpu: indicator._gpu,
            temps: indicator._sensors[0], fans: indicator._sensors[1], others: indicator._sensors[2],
        };
        for (const [name, group] of Object.entries(groups)) {
            if (!group.item.visible)
                continue;
            group.item.setSubmenuShown(true);
            await sleep(2.5); // process lists: a first reading, then shares a second later
            await shot(`menu-${name}`);
            const scroll = group.item.menu.actor.vadjustment;
            result.groups[name] = {shown: Math.round(scroll.page_size), content: Math.round(scroll.upper)};
        }
        indicator.menu.close(false);

        // a notification, to see the source icon
        state._notifier.raise('harness', {title: 'Test alert', body: 'Raised by the test harness.'}, false);
        await sleep(1.5);
        await shot('notification');
        state._notifier.withdraw('harness');

        // A setting applies at once, not at the next reading, and switching the
        // alert rules off takes back the alarms already shown. The highest disk
        // threshold (50% free) raises a disk alert on most machines; the report
        // is meaningful when activeBefore > 0.
        const rules = ['alert-fan', 'alert-temp', 'alert-disk', 'alert-swap', 'alert-thrash'];
        const settle = 0.5; // less than a reading interval
        state._settings.set_uint('disk-free-percent', 50);
        await sleep(settle);
        result.switchOff = {
            activeBefore: state._alerts.active.length,
            notificationsBefore: state._notifier._byKey.size,
        };
        rules.forEach(key => state._settings.set_boolean(key, false));
        await sleep(settle);
        result.switchOff.activeAfter = state._alerts.active.length;
        result.switchOff.notificationsAfter = state._notifier._byKey.size;
        [...rules, 'disk-free-percent'].forEach(key => state._settings.reset(key));
        await sleep(3);

        // Recent alerts: the made-up past alerts above, and the disk alert the
        // switch-off took back (no longer watched)
        const history = indicator._history;
        indicator.menu.open(false);
        history.item.setSubmenuShown(true);
        await sleep(1.5);
        await shot('menu-history');
        // a menu taller than the screen gives the open submenu a scrollbar
        const scroll = history.item.menu.actor.vadjustment;
        scroll.value = scroll.upper - scroll.page_size;
        await sleep(0.5);
        await shot('menu-history-end');
        const entries = () => state._history.entries;
        result.history = {
            entries: entries().length,
            dropped: entries().filter(e => e.dropped).length,
            rows: history.rows.length,
            visible: history.item.visible,
            clearVisible: history.clear.visible,
        };
        history.clear.activate(Clutter.get_current_event()); // closes the menu, as a click does
        result.history.entriesAfterClear = entries().length;
        result.history.ongoingAfterClear = entries().filter(e => e.end === null).length;
        indicator.menu.close(false);

        // Locking must neither disable the extension nor leave the button on the lock screen.
        Main.screenShield.lock(false);
        await sleep(4);
        result.locked = {
            sessionMode: Main.sessionMode.currentMode,
            extensionState: ext.state,
            buttonVisible: indicator.container.visible,
        };
        Main.screenShield.deactivate(false);
        await sleep(4);
        result.unlocked = {
            sessionMode: Main.sessionMode.currentMode,
            sameIndicator: Main.panel.statusArea[UUID] === indicator,
            buttonVisible: indicator.container.visible,
        };

        // a virtual device takes a moment to join the seat; create it early
        const seat = global.stage.context.get_backend().get_default_seat();
        const pointer = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        // a real alert's banner could cover the tabs the clicks below aim at
        Main.messageTray.bannerBlocked = true;
        Main.extensionManager.openExtensionPrefs(UUID, '', {});
        await sleep(8);
        const prefs = global.get_window_actors().map(a => a.meta_window)
            .find(w => w.get_wm_class() === 'org.gnome.Shell.Extensions');
        result.prefsWindow = Boolean(prefs);
        if (prefs) {
            prefs.move_resize_frame(false, 450, 40, 700, 940);
            await sleep(1);
            await shot('prefs');
            const rect = prefs.get_frame_rect();
            result.prefsRect = [rect.x, rect.y, rect.width, rect.height];
            const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
            const tabs = {alerts: 0, sensors: rtl ? -125 : 125}; // the tabs are mirrored in RTL
            for (const [page, dx] of Object.entries(tabs)) {
                await click(pointer, rect.x + rect.width / 2 + dx, rect.y + 28);
                await sleep(1.5);
                await shot(`prefs-${page}`);
            }
        }
        pointer.run_dispose();

        report({
            state: ext.state,
            extError: ext.error ? `${ext.error}` : null,
            panelVisible: indicator.visible,
            menuItems: indicator.menu._getMenuItems().length,
            ...result,
        });
    }

    disable() {
    }
}
