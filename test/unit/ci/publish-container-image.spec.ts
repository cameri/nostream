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
    }
  >
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
    expect(buildAndPush.if).to.include("startsWith(github.event.release.tag_name, 'v')")
    expect(existsSync(join(process.cwd(), '.github', 'workflows', 'publish-container-image.yml'))).to.equal(false)
  })
})
