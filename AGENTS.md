MuPDF Compress is an AGPL-3.0-or-later Zotero extension. `make test` runs `mise run check`, the same project checks used by CI. A change is done when those checks pass.

## Build output

`.scaffold/` is tool-owned output. Agents may inspect it for diagnostics, but must not create or edit files there directly. Modify source files and regenerate output through the build commands. Build tools may write to `.scaffold/`.

For a human-testable or installable artifact, run `make build` and report the versioned XPI path in the repository root, not the internal `.scaffold/build/` path. `make build` does not replace `make test`.

`npm run build` writes `typings/prefs.d.ts` and an ignored locale file beside it. Leave both to that command.

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
