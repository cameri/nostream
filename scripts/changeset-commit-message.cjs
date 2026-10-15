/**
 * Conventional-commit messages for Changesets.
 *
 * Changesets' stock messages are `RELEASING: Releasing N package(s)` with a
 * trailing `[skip ci]`. Both halves break the version PR this repo's release
 * flow depends on:
 *
 * - `Lint commits` (commitlint, `@commitlint/config-conventional`) rejects
 *   `RELEASING:` as an unknown type, so a required check fails on a message no
 *   human wrote. It only ever looked green because a `workflow_dispatch` run
 *   carries no pull request context and returns a vacuous pass.
 * - `[skip ci]` makes GitHub skip both push and pull_request runs for that
 *   commit, so the version PR's other five required checks never report either
 *   and the pull request cannot satisfy the branch's required-status-checks
 *   ruleset. Replacing the head commit with a `[skip ci]`-free one is the only
 *   thing that made those checks run.
 *
 * `changeset add` keeps the stock `docs(changeset): <summary>` subject. The
 * version commit becomes `chore: release <package>@<version>`. `skipCI` is
 * still honoured, so the documented option keeps meaning what it says.
 */

const skipCIMarker = (options, phase) =>
  options?.skipCI === true || options?.skipCI === phase ? '\n\n[skip ci]\n' : ''

module.exports = {
  getAddMessage: (changeset, options) => `docs(changeset): ${changeset.summary}${skipCIMarker(options, 'add')}`,

  getVersionMessage: (releasePlan, options) => {
    const released = releasePlan.releases.filter((release) => release.type !== 'none')
    const subject = released.length
      ? `release ${released.map((release) => `${release.name}@${release.newVersion}`).join(', ')}`
      : 'version packages'

    return `chore: ${subject}${skipCIMarker(options, 'version')}`
  },
}
