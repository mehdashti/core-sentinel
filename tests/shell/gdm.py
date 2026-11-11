# SPDX-License-Identifier: GPL-2.0-or-later
"""A python-dbusmock template: just enough GDM for GNOME Shell to have a lock screen.

GNOME Shell builds its lock screen only when GDM answers on the system bus
(LoginManager.canLock() in misc/loginManager.js); a CI container has no GDM.
    python3 -m dbusmock --system --template tests/shell/gdm.py
"""

BUS_NAME = 'org.gnome.DisplayManager'
MAIN_OBJ = '/org/gnome/DisplayManager/Manager'
MAIN_IFACE = 'org.gnome.DisplayManager.Manager'
SYSTEM_BUS = True


def load(mock, parameters):
    mock.AddProperties(MAIN_IFACE, {'Version': parameters.get('Version', '49.0')})
