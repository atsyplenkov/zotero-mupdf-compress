# SPDX-License-Identifier: AGPL-3.0-or-later

NAME := mu-pdf-compress
VERSION := $(shell node -p "JSON.parse(require('node:fs').readFileSync('package.json', 'utf8')).version")

XPI := $(NAME)_$(VERSION).xpi
BUILT_XPI := .scaffold/build/$(NAME).xpi

.PHONY: build

build:
	npm run build
	cp $(BUILT_XPI) $(XPI)
	@echo "$(XPI)"
