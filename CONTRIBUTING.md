# Contributing

When contributing to this repository, please first discuss the change you wish to make via issue,
email, or any other method with the owners of this repository
before making a change.

Please keep the conversations civil, respectful and focus on the topic being discussed.

## Local Quality Checks

Run dead code and dependency analysis before opening a pull request:

```
pnpm run knip
```

`pnpm run lint` now runs Biome.

## Pull Request Process

1. Update the relevant documentation with details of changes to the interface, this includes new environment
   variables, exposed ports, useful file locations and container parameters.
2. Follow the versioning and changeset process described in [Releases & Versioning](#releases--versioning).
3. You may merge the Pull Request in once you have the sign-off of two other developers, or if you
   do not have permission to do that, you may request the second reviewer to merge it for you.

## Releases & Versioning

This project uses [Changesets](https://github.com/changesets/changesets) for version management.

### For contributors

Every pull request that changes behavior, adds a feature, or fixes a bug **must include a changeset file**. The CI `changeset-check` job will fail if no changeset is present.

To add a changeset:

```bash
pnpm exec changeset
```

This interactive prompt will ask you to:
1. Select the bump type: `major`, `minor`, or `patch`
2. Write a short summary of the change (this becomes the changelog entry)

The command creates a file in `.changeset/` — commit it with your PR.

### Docs-only PRs (no release)

If your PR only updates documentation and should not affect versioning, add an empty changeset:

```bash
pnpm exec changeset --empty
```

Commit the generated `.changeset/*.md` file with your PR. This satisfies CI without producing a version bump or changelog entry.

### Release process

1. Changesets accumulate as PRs are merged to `main`
2. The `Changesets Release` workflow automatically opens a **"Version Packages"** PR that aggregates all pending changesets, bumps `package.json`, and updates `CHANGELOG.md`
3. When a maintainer merges the Version Packages PR, the workflow publishes a GitHub release and creates the corresponding git tag
4. The Docker image is then automatically built and pushed to GHCR via the `release.yml` workflow

## Code Quality

Run Biome checks before opening a pull request:

```
pnpm run lint
pnpm run format:check
```
