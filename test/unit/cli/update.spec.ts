import { expect } from 'chai'
import sinon from 'sinon'

import { runUpdate } from '../../../src/cli/commands/update'
import * as processUtils from '../../../src/cli/utils/process'
import * as startCommand from '../../../src/cli/commands/start'
import * as stopCommand from '../../../src/cli/commands/stop'

describe('runUpdate', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('attempts to restore stash when pull fails and stash was created', async () => {
    sinon.stub(stopCommand, 'runStop').resolves(0)
    const runStartStub = sinon.stub(startCommand, 'runStart').resolves(0)
    sinon.stub(processUtils, 'runCommandWithOutput').resolves({
      code: 0,
      stdout: 'Saved working directory and index state WIP on main: abc123',
      stderr: '',
    })
    const runCommandStub = sinon
      .stub(processUtils, 'runCommand')
      .onFirstCall()
      .resolves(1)
      .onSecondCall()
      .resolves(0)

    const code = await runUpdate([])

    expect(code).to.equal(1)
    expect(runCommandStub.firstCall.args).to.deep.equal(['git', ['pull']])
    expect(runCommandStub.secondCall.args).to.deep.equal(['git', ['stash', 'pop']])
    expect(runStartStub.called).to.equal(false)
  })

  it('returns restore failure code when pull and stash restore both fail', async () => {
    sinon.stub(stopCommand, 'runStop').resolves(0)
    const runStartStub = sinon.stub(startCommand, 'runStart').resolves(0)
    sinon.stub(processUtils, 'runCommandWithOutput').resolves({
      code: 0,
      stdout: 'Saved working directory and index state WIP on main: abc123',
      stderr: '',
    })
    const runCommandStub = sinon
      .stub(processUtils, 'runCommand')
      .onFirstCall()
      .resolves(1)
      .onSecondCall()
      .resolves(2)

    const code = await runUpdate([])

    expect(code).to.equal(2)
    expect(runCommandStub.firstCall.args).to.deep.equal(['git', ['pull']])
    expect(runCommandStub.secondCall.args).to.deep.equal(['git', ['stash', 'pop']])
    expect(runStartStub.called).to.equal(false)
  })
})
