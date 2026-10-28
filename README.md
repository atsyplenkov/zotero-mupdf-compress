# MuPDF Compress for Zotero

AGPL-3.0-or-later Zotero extension that compresses one stored or linked PDF
attachment at a time with a bundled MuPDF engine. This checkout currently
implements the plugin lifecycle and the Settings pane (#11). Compression,
context menus, session backups, the bundled engine, and distribution packaging
are later tickets.

The manifest targets Zotero 7 and newer. Only Zotero 10.0.6 has been run so far.

## Build

Node 26.12.1 and npm 11.20.0 were used for the recorded build.

```sh
npm ci
npm run build
```

The XPI is `.scaffold/build/mu-pdf-compress.xpi`. The build uses
`zotero-plugin-scaffold` and TypeScript. The add-on ID is
`mupdf-compress@atsyplenkov.github.io`. The manifest update URL is a reserved
`example.invalid` placeholder until distribution is defined.

## Settings

Selecting MuPDF Compress in Zotero Settings shows one text field, Temporary
folder. A blank value means Zotero's temporary directory. The folder must already
exist and be writable. A change applies on the next Zotero launch. No quality
preset, retention setting, or recovery override is offered.

## Layout

- `addon/` contains the bootstrap lifecycle, manifest, default preferences, and
  the Settings pane markup.
- `src/` contains the TypeScript startup, main-window registration, shutdown,
  and pane registration.
- `typings/` contains the sandbox globals and generated preference typing.
  `npm run build` regenerates `typings/prefs.d.ts` and an excluded
  `typings/i10n.d.ts`.

## Testing

The isolated-profile driver and host scripts are local under
`.local-test/settings-tests/` and are not committed. The reproduction, recorded
checks, artifact hash, and test limits are in
[docs/testing/settings-and-lifecycle.md](docs/testing/settings-and-lifecycle.md).

## License

AGPL-3.0-or-later. The native engine, its notices, and corresponding-source
instructions are added by later tickets.
