import chai from 'chai'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { load } from 'js-yaml'
import { tmpdir } from 'os'
import { join } from 'path'

const { expect } = chai

type Workflow = {
  jobs: Record<
    string,
    {
      if?: string
      needs?: string[]
      permissions?: Record<string, string>
      steps?: Array<{ id?: string; run?: string; with?: Record<string, string> }>
    }
  >
}

// Changesets tags each workspace package on publish, so a relay release is
// `nostream@X.Y.Z` while a website release is `nostream-website@X.Y.Z`. The
// `if:` expression below is the only thing standing between a website release
// and a relay image built from the wrong commit, so it is exercised rather than
// string-matched: a typo that still contains the right substring would pass a
// `to.include` and skip every relay release.
const evaluateReleaseGate = (tagName: string, isDispatch = false): boolean => {
  const expression =
    (load(
      readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf-8'),
    ) as Workflow).jobs['build-and-push-image'].if ?? ''
  // Only two clause forms are allowed in this expression; anything else is a
  // workflow change that needs review rather than a silent pass.
  const clauses = String(expression)
    .split('||')
    .map((clause) => clause.trim())
  const startsWith = (value: string, prefix: string) => value.startsWith(prefix)
  const toJs = (clause: string): string => {
    const prefix = clause.match(/^startsWith\(github\.event\.release\.tag_name, '([^']*)'\)$/)
    if (prefix) return `startsWith(tagName, ${JSON.stringify(prefix[1])})`
    const event = clause.match(/^github\.event_name == '([^']*)'$/)
    if (event) return `isDispatch === ${event[1] === 'workflow_dispatch'}`
    throw new Error(`unsupported clause in the release gate: ${clause}`)
  }
  // eslint-disable-next-line no-new-func
  return new Function('tagName', 'startsWith', 'isDispatch', `return ${clauses.map(toJs).join(' || ')}`)(
    tagName,
    startsWith,
    isDispatch,
  ) as boolean
}

// The tags are computed by a `run:` block, not by metadata-action's rules,
// because a changesets release tag is `nostream@X.Y.Z` and `@` is not legal in a
// Docker tag (#964). The block is executed here rather than string-matched: the
// defect it replaced was a tag nobody validated, only compared.
const tagStep = (workflow: Workflow): string => {
  const step = (workflow.jobs['build-and-push-image'].steps ?? []).find((entry) => entry.id === 'tags')
  expect(step, 'release.yml must compute its image tags').to.exist
  const run = step?.run ?? ''
  expect(run, 'the tag step must compute the tags itself, not inherit them').to.not.equal('')
  return run
}

// Executes the step's own `run:` block with the inputs it maps from the release
// event, and returns the tags it wrote to the job output. `undefined` means a
// `workflow_dispatch`, where the event carries no flags at all.
const imageTags = (workflow: Workflow, releaseTag: string, prerelease?: boolean): string[] => {
  const dir = mkdtempSync(join(tmpdir(), 'release-tags-'))
  try {
    const out = join(dir, 'github-output')
    writeFileSync(out, '')
    execFileSync('bash', ['-c', tagStep(workflow)], {
      stdio: 'pipe',
      env: {
        ...process.env,
        REGISTRY: 'ghcr.io',
        IMAGE_NAME: 'cameri/nostream',
        RELEASE_TAG: releaseTag,
        ...(prerelease === undefined ? {} : { PRERELEASE: String(prerelease) }),
        GITHUB_OUTPUT: out,
      },
    })
    const line = readFileSync(out, 'utf-8')
      .split('\n')
      .find((entry) => entry.startsWith('tags='))
    expect(line, 'the step must write its tags to the job output').to.exist
    return (line ?? '')
      .slice('tags='.length)
      .split(',')
      .map((tag) => tag.replace('ghcr.io/cameri/nostream:', ''))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('container image publishing workflow', () => {
  const checksWorkflow = load(
    readFileSync(join(process.cwd(), '.github', 'workflows', 'checks.yml'), 'utf-8'),
  ) as Workflow
  const releaseWorkflow = load(
    readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf-8'),
  ) as Workflow

  it('does not publish container images in checks.yml', () => {
    expect(checksWorkflow.jobs['publish-container-image']).to.be.undefined
    for (const [jobName, job] of Object.entries(checksWorkflow.jobs)) {
      expect(
        job.permissions?.packages,
        `job ${jobName} in checks.yml should not have packages write permission`,
      ).to.not.equal('write')
    }
  })

  it('publishes container image only in release.yml on published releases', () => {
    const buildAndPush = releaseWorkflow.jobs['build-and-push-image']
    expect(buildAndPush).to.exist
    expect(buildAndPush.permissions?.packages).to.equal('write')
    expect(existsSync(join(process.cwd(), '.github', 'workflows', 'publish-container-image.yml'))).to.equal(false)
  })

  it('builds the image for the tag format changesets actually creates', () => {
    // The last six relay releases (v3.0.0 … v3.4.1) were tagged vX.Y.Z and
    // published, but every release since the repo moved to changesets tagging
    // (nostream@3.5.0 onward) was skipped - no image was published for it.
    expect(evaluateReleaseGate('nostream@3.6.2'), 'a relay release must build').to.equal(true)
    expect(evaluateReleaseGate('v3.4.1'), 'a pre-changesets relay release must still build').to.equal(true)
  })

  it('does not build the image for a website release', () => {
    expect(evaluateReleaseGate('nostream-website@1.3.1')).to.equal(false)
  })

  // A published release is immutable, so the build that publishes its image
  // cannot be retried through the same event. The dispatch path is what makes a
  // failed build recoverable; the step's own range check keeps it from building
  // a non-relay tag, since a dispatch carries no release tag at all.
  it('accepts a dispatched run so a failed build can be retried', () => {
    expect(evaluateReleaseGate('', true)).to.equal(true)
  })

  // The deploy path pulls `:latest`, so the release must actually push it.
  it('tags a stable release with its version and latest', () => {
    expect(imageTags(releaseWorkflow, 'nostream@3.7.0', false)).to.deep.equal(['3.7.0', 'latest'])
  })

  // `latest` is the tag both deploy stacks pull, so a prerelease must not move
  // it onto a test build.
  it('does not move latest for a prerelease', () => {
    expect(imageTags(releaseWorkflow, 'nostream@3.8.0-rc.1', true)).to.deep.equal(['3.8.0-rc.1'])
  })

  // Releases cut before the changesets migration are tagged `vX.Y.Z`, and a host
  // pinned to that form must still resolve after one is republished.
  it('keeps the v-prefixed tag for a pre-changesets release', () => {
    expect(imageTags(releaseWorkflow, 'v3.4.1', false)).to.deep.equal(['3.4.1', 'v3.4.1', 'latest'])
  })

  // The defect this replaced: `nostream@3.7.0` is a release tag, not a Docker
  // tag, and `@` is illegal in one. It must fail here, by name, rather than at
  // buildx as `invalid reference format` after the image has been built.
  it('refuses a release tag whose version is not a legal Docker tag', () => {
    expect(() => imageTags(releaseWorkflow, 'nostream@3.7.0+build', false)).to.throw(/not a legal Docker tag/)
  })

  // A published release is immutable, so a failed build has to be re-runnable
  // by hand — that is what workflow_dispatch exists for, and it carries no
  // release flags for the step to read.
  it('builds a dispatched tag with the same tags as the release event', () => {
    expect(imageTags(releaseWorkflow, 'nostream@3.7.0')).to.deep.equal(['3.7.0', 'latest'])
  })

  // Without the event's flag the prerelease has to be read from the tag, or a
  // dispatch of an rc silently moves `latest` onto a test build.
  it('reads a prerelease out of a dispatched tag', () => {
    expect(imageTags(releaseWorkflow, 'nostream@3.8.0-rc.1')).to.deep.equal(['3.8.0-rc.1'])
  })

  // `github.event.release.tag_name` is empty on a dispatch, so a mistyped input
  // is the only thing that would otherwise reach the build.
  it('refuses a dispatched tag that is not a relay release', () => {
    expect(() => imageTags(releaseWorkflow, 'nostream-website@1.3.2')).to.throw(/not a relay release tag/)
  })

  it('builds with the tags the step computed', () => {
    const build = (releaseWorkflow.jobs['build-and-push-image'].steps ?? []).find((step) => step.with?.tags)
    expect(build?.with?.tags, 'the build must consume the computed tags').to.equal('${{ steps.tags.outputs.tags }}')
  })
})
