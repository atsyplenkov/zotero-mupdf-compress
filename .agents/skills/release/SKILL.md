---
name: release
description: Prepare and publish a MuPDF Compress version through GitHub Actions, with release notes, verification, and confirmed issue closure.
disable-model-invocation: true
---

# Release MuPDF Compress

Require an explicit stable version, for example:

```text
/skill:release 0.1.7
```

Accept an optional leading `v`, then use canonical `X.Y.Z` as `version` and
`v${version}` as `tag`. Ask when the version is missing or malformed. Reject
prerelease and build suffixes. A preparation-only request stops before creating
a tag, pushing, dispatching Actions, or changing a GitHub release. A request to
edit this skill or merge a feature does not authorize a release.

Read `AGENTS.md`, the Releases section of `README.md`,
`.github/workflows/release.yml`, and `scripts/publish-release.mjs` before work.
They define the current checks and publication behavior.

## 1. Validate the release

Complete these checks before editing files:

- Use `main` and the `origin` remote for `atsyplenkov/zotero-mupdf-compress`.
  Verify the remote URL and run `gh auth status`. Specify that repository in
  GitHub commands.
- Require no staged or unstaged tracked changes. Leave unrelated untracked
  files untouched and stage release files by name later.
- Fetch `main` and tags from `origin`. Stop if local `main` is behind or has
  diverged from `origin/main`. Include local commits ahead of the remote in
  the release review.
- Read the version from `package.json` and both root version fields in
  `package-lock.json`. Stop on disagreement. Inspect stable version tags and
  public releases using numeric version ordering. Check that the latest
  version tag is an ancestor of `HEAD`; record it as `previous_tag`.
- Require the requested version to exceed the current package version and
  published stable versions, and require its tag to be absent locally and
  remotely. Fetch release metadata to confirm that no release already uses
  the tag. Authentication and network errors are failures, not evidence of
  absence.
- If the exact version has already been prepared or tagged, inspect its state
  and ask whether to continue that preparation or retry publication. Use the
  retry section below for an existing remote tag; do not bump again or move it.
- If there are no version tags, this is the first tagged release. Use the
  repository history through `HEAD` as the review range and say so explicitly.

Stop when a check fails. Repository repairs, discarded changes, and moved tags
require a separate user decision.

## 2. Prepare the version and notes

Inspect commits and relevant diffs from `previous_tag` through `HEAD`, or the
first-release range. Draft concise Russian notes describing user-visible changes.
Use commit history as evidence; do not copy commit subjects as release notes.

Collect issues explicitly resolved by closing keywords (`Closes`, `Fixes`, or
`Resolves`, including their grammatical variants) in those commit messages.
`Refs #N` is a reference only. Read each issue's title, state, and acceptance
criteria with `gh issue view`. Include additional issues only when the user
identifies them and the completed work supports closure. Keep partly completed
issues open, including issues whose required live checks have not been run.

Update `package.json` and `package-lock.json` together:

```sh
npm version "$version" --no-git-tag-version
```

Create `CHANGELOG.md` with `# История изменений` if absent; otherwise insert the
new entry after its title. Use `date +%F` for the release date. Do not invent
historical entries. Omit empty categories:

```markdown
## [0.1.7] - YYYY-MM-DD

### Добавлено
- Описание изменения (#39).

### Изменено
- Описание изменения.

### Исправлено
- Описание исправления (#40, #41).
```

Use the full `v${version}` as the release title. Reuse the approved changelog
entry as GitHub release notes. The workflow initially generates notes; the
agent replaces only the title and notes after successful publication.

## 3. Verify and request approval

Run `make test`, `make build`, and `git diff --check`. Confirm that the package
and lockfile versions agree and the root artifact is
`mu-pdf-compress_${version}.xpi`. Let the build command manage generated typings;
inspect any tracked generated changes before staging. Inspect the complete diff,
including a new changelog, and ensure only release-related files changed.

Show the version, tag, release title, commits (including unpushed commits), full
release-file diff, Russian notes, proposed issue closures, test results, and XPI
path. Ask for explicit confirmation covering the release commit, all commits to
be pushed, the tag, branch/tag pushes, automatic GitHub publication, replacement
of generated release notes, and any issue comments or closures.

If the user asks for changes, repeat the checks before seeking confirmation.
If they reserve tagging for themselves, leave the tag absent and stop at the
requested preparation boundary.

## 4. Publish through GitHub Actions

After confirmation:

1. Stage only the reviewed release files and commit as
   `chore: release v${version}`.
2. Create a lightweight tag `${tag}` at that commit. Push `main` to `origin`,
   then push only the exact tag. Never push all local tags.
3. Identify the `release.yml` run for this tag and commit with `gh run list`.
   Verify its event, branch/tag, and `headSha`; watch that run with
   `gh run watch <run-id> --exit-status`.
4. Let Actions build, verify, upload the draft's XPI/source/manifest, publish
   it, and refresh the stable feed. Run neither `zotero-plugin release` nor
   `scripts/publish-release.mjs` locally. Do not create or upload releases
   separately with `gh release create` or `gh release upload`.
5. After success, apply the approved title and Russian notes with
   `gh release edit "$tag" --title "$tag" --notes-file <notes-file>`.
   Keep release state, tags, and assets unchanged.

### Retry a partial publication

Inspect the existing tag, Actions run, and version release first. Report which
steps succeeded. Ask for confirmation to retry the existing version. Never
recreate a release commit or tag, bump the version, delete a public release, or
replace public version assets as a retry strategy.

Rerun the failed Actions job with `gh run rerun <run-id> --failed`, or dispatch
`gh workflow run release.yml --ref "$tag"` for an existing remote tag that
matches the package version at that commit. Select the corresponding new run
or attempt and verify its conclusion. The publisher resumes drafts and reuses
published version files unchanged. A retry can replace the stable
`release/update.json` feed; release history blocks a downgrade even if that feed
is missing. An incomplete or corrupt public version needs a separate human
decision. A failure after Actions succeeds may need only the approved notes or
issue operations repeated.

## 5. Verify publication and close confirmed issues

Check the Actions result and the public, non-prerelease version release with
`gh release view`. Confirm the local and remote tags point to the approved
commit. Download assets into a temporary directory, outside `.scaffold/`, and
verify:

- the version release contains `mu-pdf-compress.xpi`, the source archive named
  in `addon/native/digests.json`, and its `update.json`;
- the XPI manifest has the expected add-on ID, version, and stable update URL;
- the stable `release` asset `update.json` matches the version release's manifest,
  offers the expected XPI URL/version, has matching Zotero compatibility bounds,
  and its `update_hash` matches the downloaded XPI's SHA-512 digest;
- the source archive's SHA-256 matches `addon/native/digests.json`.

Only after these checks, comment on and close issues approved in step 3 whose
acceptance criteria are satisfied. Link the release in the comment. Inspect
existing comments/state first so a retry does not duplicate them. Keep issues
with pending live Zotero checks open.

Report the release URL, version, Actions run URL, checks, closed or still-open
issues, and remaining worktree changes. Distinguish verified assets from a live
Zotero update: publication checks alone do not prove client installation. Copies
with the old `example.invalid` update URL require one manual XPI installation.
