import chai from 'chai'
import { existsSync, readFileSync } from 'fs'
import { load } from 'js-yaml'
import { join } from 'path'

const { expect } = chai

type Workflow = {
  jobs: Record<
    string,
    {
      if?: string
      needs?: string[]
      permissions?: Record<string, string>
      steps?: Array<{ id?: string; with?: Record<string, string> }>
    }
  >
}

// Changesets tags each workspace package on publish, so a relay release is
// `nostream@X.Y.Z` while a website release is `nostream-website@X.Y.Z`. The
// `if:` expression below is the only thing standing between a website release
// and a relay image built from the wrong commit, so it is exercised rather than
// string-matched: a typo that still contains the right substring would pass a
// `to.include` and skip every relay release.
const evaluateReleaseGate = (tagName: string): boolean => {
  const expression =
    (load(
      readFileSync(join(process.cwd(), '.github', 'workflows', 'release.yml'), 'utf-8'),
    ) as Workflow).jobs['build-and-push-image'].if ?? ''
  // Only the `startsWith(github.event.release.tag_name, '…')` clauses are used
  // in this expression; anything else is a workflow change that needs review.
  const clauses = String(expression)
    .split('||')
    .map((clause) => clause.trim())
  const startsWith = (value: string, prefix: string) => value.startsWith(prefix)
  // Translate the two GitHub expression forms into JavaScript.
  const js = clauses
    .map((clause) =>
      clause.replace(/^startsWith\(github\.event\.release\.tag_name, '([^']*)'\)$/,
        (_, prefix: string) => `startsWith(tagName, ${JSON.stringify(prefix)})`),
    )
    .join(' || ')
  // eslint-disable-next-line no-new-func
  return new Function('tagName', 'startsWith', `return ${js}`)(tagName, startsWith) as boolean
}

const metaTags = (workflow: Workflow): string =>
  ((workflow.jobs['build-and-push-image'].steps ?? []).find((step) => step.id === 'meta')?.with?.tags ?? '')

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

  // The deploy path pulls `:latest`, so the release must actually push it.
  // Without this the metadata action's defaults are the only thing producing
  // the tag, and a silent change in that action would strand every host on the
  // last image it managed to pull.
  it('tags the released image latest, which is what deploys pull', () => {
    const tags = metaTags(releaseWorkflow)
    expect(tags, 'release.yml must declare its tags, not inherit the defaults').to.include('type=raw,value=latest')
  })

  // A semver rule's input comes from the git ref, so a `nostream@X.Y.Z` tag
  // makes it emit nothing - and with no version, the `latest` rule is skipped
  // too. A `match` rule is what produces the version tag for that shape.
  it('derives a version tag from the changesets release tag', () => {
    expect(metaTags(releaseWorkflow)).to.include('type=match,pattern=nostream@(.+),group=1')
  })

  // The release tag is what a host sees on the GitHub release and pins, and no
  // semver rule can reproduce its `nostream@` prefix (a `prefix=` is rendered
  // after parsing, a `value=` replaces the whole tag). The plain ref rule
  // publishes it unchanged.
  it('publishes the release tag name itself, which the deploy docs pull', () => {
    expect(metaTags(releaseWorkflow)).to.include('type=ref,event=tag')
  })
})
