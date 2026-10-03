// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only extension, loaded next to Core Sentinel in a headless shell by
// tools/shell-test.sh: it waits for a few readings, screenshots the panel, the
// menu, each submenu, a notification, the lock screen and each preferences
// page, and writes a status report.

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
        Main.overview.hide();
        await sleep(8);
        const indicator = Main.panel.statusArea[UUID];
        const ext = Main.extensionManager.lookup(UUID);
        if (!indicator) {
            report({error: 'indicator missing', state: ext?.state, extError: `${ext?.error}`});
            return;
        }
        const result = {};

        await shot('panel');
        indicator.menu.open(false);
        await sleep(3); // one more tick renders the open menu
        await shot('menu');
        const subs = [...indicator._cpu.subs, ...indicator._sensors.subs];
        for (const [i, sub] of subs.entries()) {
            sub.item.setSubmenuShown(true);
            await sleep(1.5);
            await shot(`menu-sub${i}`);
        }
        indicator.menu.close(false);

        // a notification, to see the source icon
        ext.stateObj._notifier.raise('harness', {title: 'Test alert', body: 'Raised by the test harness.'}, false);
        await sleep(1.5);
        await shot('notification');
        ext.stateObj._notifier.withdraw('harness');

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
        const seat = Clutter.get_default_backend().get_default_seat();
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
