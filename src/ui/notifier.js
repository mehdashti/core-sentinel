// SPDX-License-Identifier: GPL-2.0-or-later
// Desktop notifications for alerts. One notification per alert key: a
// recovery replaces the alarm it answers instead of piling up next to it.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export class Notifier {
    constructor(title) {
        this._title = title;
        this._source = null;
        this._byKey = new Map();
    }

    _getSource() {
        if (!this._source) {
            this._source = new MessageTray.Source({
                title: this._title,
                iconName: 'computer-symbolic',
            });
            this._source.connect('destroy', () => {
                this._source = null;
                this._byKey.clear();
            });
            Main.messageTray.add(this._source);
        }
        return this._source;
    }

    _show(key, {title, body}, params) {
        this.withdraw(key);
        const source = this._getSource();
        const notification = new MessageTray.Notification({
            source,
            title,
            body,
            // hardware state is not private to the user: fine on the lock screen
            privacyScope: MessageTray.PrivacyScope.SYSTEM,
            ...params,
        });
        notification.connect('destroy', () => {
            if (this._byKey.get(key) === notification)
                this._byKey.delete(key);
        });
        this._byKey.set(key, notification);
        source.addNotification(notification);
    }

    /** @param {boolean} critical stays on screen until dismissed */
    raise(key, message, critical) {
        this._show(key, message, {
            urgency: critical ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.HIGH,
        });
    }

    recover(key, message) {
        this._show(key, message, {urgency: MessageTray.Urgency.NORMAL, isTransient: true});
    }

    withdraw(key) {
        this._byKey.get(key)?.destroy();
        this._byKey.delete(key);
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
        this._byKey.clear();
    }
}
