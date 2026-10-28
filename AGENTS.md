MuPDF Compress is an AGPL-3.0-or-later Zotero extension. `npm run build` writes the XPI. `mise run check` runs the project checks, and CI runs that same command. A change is done when that command passes.

`typings/prefs.d.ts` and `typings/i10n.d.ts` come from `npm run build`. Leave them to that command. `.scaffold/` is build output, not source.

A lint exception is one path and one rule, with a reason, and it needs a human decision.

## Versions

Pins for this checkout. `scripts/check-versions.sh` fails if this list disagrees with `mise.toml`, `package.json`, or `npm --version`.

- node 26.12.1
- npm 11.20.0
- typescript 5.9.3
- zotero-plugin-scaffold 0.8.2
- zotero-types 4.1.0-beta.4
- commitlint 21.2.4
- hk 2.9.0
- pkl 0.32.2
- oxlint 1.90.0
- typos 1.51.1
- shellcheck 0.11.0
- jactionlint 2.3.0
- betterleaks 1.9.0
- osv-scanner 2.7.0
- agnix 0.59.3

## Agent skills

### Issue tracker

Issues live as GitHub issues in `atsyplenkov/zotero-mupdf-compress`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped 1:1 to GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
