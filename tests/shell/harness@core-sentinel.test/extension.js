// SPDX-License-Identifier: GPL-2.0-or-later
// Test-only extension, loaded next to Core Sentinel in a headless shell by
// tools/shell-test.sh: it waits for a few readings, screenshots the panel, the
// menu, each submenu and the preferences window, and writes a status report.

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

        Main.extensionManager.openExtensionPrefs(UUID, '', {});
        await sleep(8);
        await shot('prefs');

        report({
            state: ext.state,
            extError: ext.error ? `${ext.error}` : null,
            panelVisible: indicator.visible,
            menuItems: indicator.menu._getMenuItems().length,
        });
    }

    disable() {
    }
}
