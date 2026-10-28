MuPDF Compress is an AGPL-3.0-or-later Zotero extension. `npm run build` writes the XPI. `mise run check` runs the project checks, and CI runs that same command. A change is done when that command passes.

`typings/prefs.d.ts` and `typings/i10n.d.ts` come from `npm run build`. Leave them to that command. `.scaffold/` is build output, not source.

A lint exception is one path and one rule, with a reason, and it needs a human decision.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `atsyplenkov/zotero-mupdf-compress`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped 1:1 to GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
