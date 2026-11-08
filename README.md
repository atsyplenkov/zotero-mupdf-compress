# MuPDF Compress for Zotero

[![License: AGPL-3.0-or-later](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)
[![Latest release](https://img.shields.io/github/v/release/atsyplenkov/zotero-mupdf-compress)](https://github.com/atsyplenkov/zotero-mupdf-compress/releases/latest)
[![Total downloads](https://img.shields.io/github/downloads/atsyplenkov/zotero-mupdf-compress/total)](https://github.com/atsyplenkov/zotero-mupdf-compress/releases)
[![Works with Zotero 10](https://img.shields.io/badge/Works_with-Zotero_10-CC2936?logo=zotero)](https://www.zotero.org/)

MuPDF Compress is a [Zotero](https://www.zotero.org/) extension for reducing the
size of PDF attachments directly from your library. It uses a bundled
[MuPDF](https://mupdf.com/) engine to process files locally, without uploading them
to an external service.

Select your items, right-click, and choose **Compress PDF → Compress**. Review the
results and, if needed, use **Revert** to recover the original PDFs during the
same Zotero session.

![MuPDF Compress context menu and settings](assets/interface.png)

## Features

- Compress individual PDFs or process multiple selected items in sequence.
- Work with both stored attachments and linked attachments.
- See the outcome and file-size reduction for each PDF.
- Replace an attachment only when the compressed output passes validation and is
  smaller.
- Keep a verified session backup so you can revert a successful compression before
  closing Zotero.

Compression uses fixed settings, including downsampling color and grayscale
images to 150 DPI and JPEG recompression at quality 85. **Image compression is
lossy:** inspect the results before discarding your originals. Savings depend on
the PDF; some files cannot be made smaller.

## Installation

> [!IMPORTANT]
> This development candidate includes **Linux x86-64** components only and
> targets **glibc 2.35**. Windows, macOS, Linux ARM64, and non-glibc systems are
> not supported by this candidate. Stable publication is blocked until the
> complete four-platform package is available.
>
> The manifest and update metadata allow **Zotero 10.x** only. Earlier
> host-built versions were tested with Zotero 10.0.6; native candidate checks
> do **not** constitute testing this build inside Zotero. See the
> [native build record](addon/BUILD-RECORD.md) for measured requirements.

1. For this development candidate, download the artifact from a successful
   [Linux candidate Actions run](https://github.com/atsyplenkov/zotero-mupdf-compress/actions/workflows/linux-candidate.yml)
   and extract `mu-pdf-compress_<version>.xpi`. Existing published releases
   have their own build records and may contain the earlier host-built engine.
2. In Zotero, open **Tools → Plugins**.
3. Click the gear button, choose **Install Plugin From File…**, and select the
   downloaded `.xpi`.

If Firefox tries to install the file as a browser extension, right-click the
download link and choose **Save Link As…**.

After installation, Zotero can check for plugin updates. See the
[changelog](CHANGELOG.md) for release notes.

## Usage

### Compress PDFs

1. Close the PDFs you want to compress in Zotero’s reader.
2. Select PDF attachments or parent items in your library. Selecting a parent
   item includes its PDF attachments.
3. Right-click and choose **Compress PDF → Compress**.
4. Review the results window for each file’s outcome and size reduction.

![Batch compression results showing outcomes and file-size reductions](assets/batch_compression.png)

Compression keeps the same Zotero attachment item and file path. Stored
attachments are marked for upload through Zotero file sync. Linked attachments
are changed at their existing location.

Encrypted PDFs are not processed. Files open in Zotero’s reader must be closed
before compression or Revert.

### Revert a compression

Select the attachment or its parent item, then choose **Compress PDF → Revert**
from the context menu.

Revert restores the original PDF from its session backup. If the attachment’s
path or contents have changed since compression, Revert is blocked to avoid
overwriting those changes.

> [!WARNING]
> Session backups are temporary. They are removed when Zotero quits or the
> extension shuts down, and Revert is not available after a restart, including
> after a crash. Keep separate backups of important files.

### Temporary folder

Open **Zotero Settings → MuPDF Compress** to choose where session backups are
stored.

Leave **Temporary folder** blank to use Zotero’s temporary directory, or choose
an existing writable folder. Changes take effect the next time Zotero starts;
the current session keeps using its original folder.

## Development

Install [mise](https://mise.jdx.dev/) and GNU Make first. Tool versions are
pinned in [`mise.toml`](mise.toml) and [`package.json`](package.json).
`make setup` installs the pinned tools and npm dependencies.

```sh
make setup
make build
```

The installable extension is written to `mu-pdf-compress_<version>.xpi` in the
repository root.

Run the same checks used by CI:

```sh
make test
```

This runs linting, type checking, tests, the build, and distribution checks.

### Linux development candidates

The read-only `linux-candidate` Actions workflow builds MuPDF and the session-lock
helper in a digest-pinned Ubuntu 22.04 container on an `ubuntu-24.04` runner.
It checks both executables' ELF architecture, loader, runtime libraries, and
GLIBC symbol requirements against the 2.35 target. It then builds one XPI and
runs the real engine and ownership tests against verified files extracted from
that same package in Ubuntu 22.04 and Ubuntu 24.04 containers.

A successful run provides a test XPI, the checksum-verified MuPDF source archive,
component hashes, build records, and test logs as an Actions artifact. These
checks cover native execution and host-API adapters, not Zotero UI integration
or every Linux distribution. Container package versions and compiler commands
are recorded; the build is not claimed to be bit-for-bit reproducible.

The source remains pinned to MuPDF 1.28.5 without patches for this development
slice. [Issue #34](https://github.com/atsyplenkov/zotero-mupdf-compress/issues/34)
tracks the agreed security patch. A final release must rebuild and retest that
agreed source on every supported target; this candidate is not a security fix.

### Stable releases

Stable publication currently refuses this Linux-only package before any release
writes. The remaining platform work must supply all four native component sets
and their required verification before publication can be enabled.

The release workflow accepts only canonical stable tags such as `v0.1.6`, with
no leading zeroes, prerelease suffix, or build metadata. The tag must match the
version in `package.json` and point to the checked-out commit. Annotated tags
are checked by their target commit.

That commit must already be in `main`'s history. The workflow fetches complete
Git history and checks ancestry against `origin/main`; missing main history or
a shallow checkout is rejected. Tags on unmerged branches are not eligible.
An older commit in main can still be released, provided no newer version has
already been published or offered in the update feed.

Pushing an eligible version tag starts the workflow. Creating a local tag
without pushing it does not start GitHub Actions. For a manual retry, select
the existing version tag, or a branch whose selected commit has that matching
tag. Manual dispatch does not create a version tag or bypass the version,
checked-out commit, or main-history checks.

Eligibility is checked before publication writes, including on retries.
Publication remains serialized. Once a version is public, its assets are not
replaced: a retry validates and reuses those assets to repair the update feed.
A successful eligibility check does not prove platform compatibility or bypass
the incomplete-platform publication guard.

## License

Licensed under [AGPL-3.0-or-later](LICENSE), without warranty. The bundled MuPDF
engine and its dependencies are covered by their respective
[licenses and notices](addon/THIRD-PARTY.md). See
[SOURCE.md](addon/SOURCE.md) for source code and build instructions.
