MuPDF Compress is an AGPL-3.0-or-later Zotero extension. `npm run build` writes the XPI. `mise run check` runs the project checks, and CI runs that same command. A change is done when that command passes.

`npm run build` writes `typings/prefs.d.ts` and an ignored locale file beside it. Leave both to that command. `.scaffold/` is build output, not source.

A lint exception is one path and one rule, with a reason, and it needs a human decision.

## Versions

For version pins, see `mise.toml` for tools, `package.json` for npm and direct npm dependencies, and `package-lock.json` for resolved dependencies.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `atsyplenkov/zotero-mupdf-compress`, driven with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles mapped 1:1 to GitHub labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
