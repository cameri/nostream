import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

import chai from 'chai'
import { load } from 'js-yaml'

const { expect } = chai

type Workflow = {
  jobs: Record<string, { if?: string; needs?: string[] }>
}

describe('container image publishing workflow', () => {
  const workflow = load(readFileSync(join(process.cwd(), '.github', 'workflows', 'checks.yml'), 'utf-8')) as Workflow

  it('publishes only on main after all CI checks complete', () => {
    const publish = workflow.jobs['publish-container-image']

    expect(publish.needs).to.deep.equal([
      'changes',
      'lint',
      'build-check',
      'test-units-and-cover',
      'test-integrations-and-cover',
      'post-tests',
    ])
    expect(publish.if).to.include("always() && github.event_name == 'push' && github.ref == 'refs/heads/main'")
    for (const job of publish.needs.filter((job) => job !== 'post-tests')) {
      expect(publish.if).to.include(`needs.${job}.result == 'success' || needs.${job}.result == 'skipped'`)
    }
    expect(publish.if).to.include("needs.post-tests.result == 'success'")
    expect(existsSync(join(process.cwd(), '.github', 'workflows', 'publish-container-image.yml'))).to.equal(false)
  })
})
