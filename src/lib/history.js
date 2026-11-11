// SPDX-License-Identifier: GPL-2.0-or-later
// The alerts of this session, newest first, each with when it started and
// when it ended, so after unlocking the screen the menu shows what happened
// while the user was away. Pure: fed with AlertEngine.update() results, and
// the clock is passed in.
//
// Kept in memory only. The extension stays enabled while the screen is locked,
// which is the case this answers; after a shell restart the alerts that are
// still on are raised again, and so start the new history.

export const HISTORY_LIMIT = 20;

/**
 * @typedef {object} HistoryEntry
 * @property {string} key the alert's key (AlertEngine)
 * @property {string} type the alert's message kind
 * @property {object} params values for the message, as last seen
 * @property {number} start wall-clock ms when the condition began
 * @property {number|null} end wall-clock ms when the alert ended; null while it is on
 * @property {boolean} dropped it ended because its subject stopped being
 *   watched (rule switched off, sensor hidden, disk unmounted), not because
 *   the condition was over
 */

export class AlertHistory {
    /** @param {number} limit entries kept; alerts still on are never dropped */
    constructor(limit = HISTORY_LIMIT) {
        this._limit = limit;
        this._entries = [];
    }

    /** @returns {HistoryEntry[]} newest first */
    get entries() {
        return this._entries;
    }

    /**
     * @param {{raised: object[], cleared: object[], dropped: object[]}} events
     *   AlertEngine.update() result
     * @param {number} now wall-clock time, ms since the epoch
     * @param {number} monoNow the monotonic time (s) AlertEngine.update() was given
     */
    update({raised, cleared, dropped}, now, monoNow) {
        for (const alert of cleared)
            this._end(alert, now, false);
        for (const alert of dropped)
            this._end(alert, now, true);
        for (const alert of raised) {
            this._entries.push({
                key: alert.key,
                type: alert.type,
                params: alert.params,
                // `since` is when the condition began, before its hold time
                start: now - Math.max(0, monoNow - alert.since) * 1000,
                end: null,
                dropped: false,
            });
        }
        this._entries.sort((a, b) => b.start - a.start);
        this._trim();
    }

    /** Forgets the alerts that have ended; those still on stay. */
    clear() {
        this._entries = this._entries.filter(entry => entry.end === null);
    }

    _end(alert, now, dropped) {
        const entry = this._entries.find(e => e.key === alert.key && e.end === null);
        if (entry) {
            entry.end = now;
            entry.params = alert.params;
            entry.dropped = dropped;
        }
    }

    _trim() {
        let excess = this._entries.length - this._limit;
        for (let i = this._entries.length - 1; i >= 0 && excess > 0; i--) {
            if (this._entries[i].end !== null) {
                this._entries.splice(i, 1);
                excess--;
            }
        }
    }
}
