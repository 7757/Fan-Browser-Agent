# Releasing Fan

This document is for project maintainers. Public GitHub Release notes are written in English.

## Prepare a release

1. Start from a clean, up-to-date `main` branch.
2. Choose the next semantic version, for example `0.4.4`.
3. Update the project version:

   ```bash
   node scripts/bump-version.mjs 0.4.4
   ```

4. Write `apps/desktop/release-notes/0.4.4.md` before creating the tag. Put installation warnings first, then downloads and user-visible changes.
5. Run the version consistency check and the relevant local checks:

   ```bash
   node scripts/bump-version.mjs --check
   ```
6. Commit the version and release notes, push them to `main`, and wait for required CI checks.

## Publish the release

Create an annotated tag only after the final release notes are committed:

```bash
git tag -a v0.4.4 -m "Fan 0.4.4"
git push origin v0.4.4
```

The `Release desktop` workflow builds native packages on macOS Apple Silicon, macOS Intel, Windows x64, and Linux x64. It publishes the GitHub Release only after every platform succeeds.

Confirm that the Release contains the expected installers, `latest*.yml` update metadata, blockmaps, and `SHA256SUMS.txt`.

## Handle a failed release

- If no GitHub Release was published, fix the source or workflow on `main`, create a new release candidate version if users may have fetched the tag, and run the workflow again.
- Never move or replace a tag that belongs to a published immutable Release.
- Do not rerun an old tag merely to edit its notes. Edit the GitHub Release description directly when only documentation changes.
- If a published artifact is unsafe, remove the Release from normal distribution and publish a corrected version with a new version number.
