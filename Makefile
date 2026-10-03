# SPDX-License-Identifier: GPL-2.0-or-later
UUID    := core-sentinel@mehdashti.github.io
DOMAIN  := core-sentinel
SRC     := src
DIST    := dist
ZIP     := $(DIST)/$(UUID).shell-extension.zip
DEVLINK := $(HOME)/.local/share/gnome-shell/extensions/$(UUID)
JS      := $(wildcard $(SRC)/*.js $(SRC)/lib/*.js $(SRC)/ui/*.js)

.PHONY: all check test lint schemas translations pot pack install install-dev uninstall-dev nested snapshot clean

all: schemas translations

check: lint test pack

test:
	gjs -m tests/run.js

lint:
	npx eslint .

snapshot:
	gjs -m tools/snapshot.js

schemas:
	glib-compile-schemas --strict $(SRC)/schemas

# Compiled catalogs for running straight from the source tree (install-dev)
translations:
	@for po in $(wildcard po/*.po); do \
		lang=$$(basename $$po .po); \
		mkdir -p $(SRC)/locale/$$lang/LC_MESSAGES; \
		msgfmt --check -o $(SRC)/locale/$$lang/LC_MESSAGES/$(DOMAIN).mo $$po; \
	done

pot:
	xgettext --from-code=UTF-8 --language=JavaScript --keyword=_ --add-comments=Translators \
		--package-name="Core Sentinel" --msgid-bugs-address="https://github.com/mehdashti/core-sentinel/issues" \
		--output=po/$(DOMAIN).pot $(JS)
	@for po in $(wildcard po/*.po); do msgmerge --update --backup=none --quiet $$po po/$(DOMAIN).pot; done

pack:
	mkdir -p $(DIST)
	gnome-extensions pack $(SRC) --force --out-dir=$(DIST) --podir=../po \
		--extra-source=lib --extra-source=ui --extra-source=icons

install: pack
	gnome-extensions install --force $(ZIP)

# Run from the working tree: edits take effect on the next shell start.
install-dev: schemas translations
	@if [ -e "$(DEVLINK)" ] && [ ! -L "$(DEVLINK)" ]; then \
		echo "$(DEVLINK) exists and is not a symlink; remove it first"; exit 1; fi
	ln -sfn "$(CURDIR)/$(SRC)" "$(DEVLINK)"

uninstall-dev:
	@if [ -L "$(DEVLINK)" ]; then rm "$(DEVLINK)"; fi

# A throwaway GNOME Shell in a window (needs the mutter-dev-bin package).
nested: install-dev
	MUTTER_DEBUG_DUMMY_MODE_SPECS=1600x1000 dbus-run-session -- gnome-shell --devkit --wayland

clean:
	rm -rf $(DIST) $(SRC)/locale $(SRC)/schemas/gschemas.compiled
