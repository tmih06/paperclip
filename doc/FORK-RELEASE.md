# Fork releases (tmih06/paperclip)

The manual **Fork Release** workflow publishes this fork without npmjs.org access
or changes to upstream packages. It is restricted to `tmih06/paperclip` and uses
its repository `GITHUB_TOKEN` with explicit package/release write permissions.

## Version and invocation

Versions follow the existing UTC calendar scheme, `YYYY.MDD.P`. For example,
2026-11-14 becomes `2026.1114.0`; another release on the same date increments
`P`. The tag is `v2026.1114.0`. No `1.0.0` tag is created.

Enable GitHub Actions for the fork, then run:

```sh
gh workflow run fork-release.yml --repo tmih06/paperclip --ref master \
  -f release_date=2026-11-14
```

Omit `release_date` to use the current UTC date. Run only trusted source refs.
The workflow verifies the exact source SHA with the existing Release Verify
workflow, including typecheck, tests, build, and chaos/recovery checks. Native
daemons are built for Linux and macOS on x64 and arm64; Linux provider packs
are built on their native hosts.

## Published outputs

- Every `publishFromCi: true` package in `scripts/release-package-manifest.json`
  is published under `@tmih06` to `https://npm.pkg.github.com`. The CLI becomes
  `@tmih06/paperclipai`. Internal dependency keys keep their original import
  bindings and use npm aliases pointing at this release's fork packages.
- `ghcr.io/tmih06/paperclip:<version>`, `<version>-cloud`, and
  `<version>-runner-artifacts` each include Linux amd64 and arm64 manifests.
  Candidate images are built and startup-tested before release tags are added.
- The GitHub Release attaches package tarballs, native daemons, Linux provider
  packs, the feature catalog, package inventory, registry-byte verification,
  package startup smoke evidence, image metadata, and `SHA256SUMS`.

Publishing is gated on source verification and candidate image startup checks.
After publication, every registry tarball is downloaded and compared with the
staged digest; a clean CLI install must report the release version and start
its installed server and UI. Release assets are uploaded to a draft, downloaded,
and checksum-verified before the release becomes public. Images remain in GHCR;
release attachments contain their manifests, not duplicate image archives.

## Installing

GitHub Packages requires authentication for downloads, including public npm
packages. Configure a classic PAT with `read:packages` locally (never commit it):

```sh
npm config set @tmih06:registry https://npm.pkg.github.com
npm login --scope=@tmih06 --auth-type=legacy --registry=https://npm.pkg.github.com
npx @tmih06/paperclipai@2026.1114.0 onboard
```

Package visibility follows GitHub Packages repository/organization policy; this
workflow does not change visibility or repository security settings.

## Failures and partial publication

A tag alone does not trigger this release. The public release is created last.
A failure may leave immutable package versions or candidate images published;
inspect the failed job before retrying. Never overwrite a published version or
claim a partial run succeeded. If registry publication has started, choose a new
same-day patch slot for the next run rather than reusing immutable versions.
