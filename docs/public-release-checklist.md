# Public release checklist

Run this checklist before publishing a release or submitting it to the Omarchy
plugin marketplace.

## Repository

- [ ] `git status --short` is clean and `git diff --check` has no output.
- [ ] Reachable Git history has been scanned for secrets.
- [ ] `pnpm verify` passes from a clean dependency install.
- [ ] `preview.png` accurately represents the current version and contains no
      personal data, credentials, or unlicensed assets.
- [ ] README installation, removal, data handling, requirements, and external
      dependencies are current.
- [ ] `CHANGELOG.md` has a dated release entry and `manifest.json` has the same
      release version.

## Manual UAT

- [ ] Install from a fresh Git clone with `omarchy plugin add ... --enable`.
- [ ] Confirm the panel opens, sends, streams, stops, reopens, and resumes.
- [ ] Confirm helpful errors for a missing Codex binary, missing login, exhausted
      quota, and unavailable model.
- [ ] Confirm source links open only after a click and copied text is correct.
- [ ] Check normal and HiDPI display scaling.
- [ ] Uninstall, confirm no configuration was overwritten, and verify the
      documented optional state cleanup.

## Marketplace submission

- [ ] Repository is public, has one root `manifest.json`, a README, and a
      license.
- [ ] Plugin ID is globally unique and outside the reserved `omarchy.*`
      namespace.
- [ ] Choose the `Productivity` category and `ai`, `quickshell` tags.
- [ ] Read the current marketplace submission guide and confirm every checklist
      statement before creating the submission.
- [ ] Record the submitted commit SHA and wait for compatibility validation,
      security baseline results, and maintainer approval.
