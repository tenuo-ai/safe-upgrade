# Releasing safe-upgrade

Releases are started by a maintainer from a clean, current `main` checkout:

```bash
pnpm release patch
```

Use `minor` or `major` instead when the change calls for it. Add `--dry-run` to
run every local check without changing the version or pushing anything.

The command verifies that `main` exactly matches `origin/main`, confirms that
the next version and tag are unused, runs typechecking, tests, and package
inspection, then creates the version commit and tag. It pushes both atomically.

The tag starts `.github/workflows/publish.yml`. A maintainer must approve the
protected `npm-publish` environment in GitHub Actions. The workflow publishes
through npm trusted publishing, so no npm token is stored in GitHub.

If the atomic push fails, the version commit and tag remain local. Resolve the
push problem, verify the tag still points at the version commit, and retry:

```bash
git push --atomic origin main vX.Y.Z
```
