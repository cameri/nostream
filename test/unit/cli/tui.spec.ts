import { expect } from 'chai'
import sinon from 'sinon'

import * as configCommands from '../../../src/cli/commands/config'
import * as exportCommand from '../../../src/cli/commands/export'
import * as importCommand from '../../../src/cli/commands/import'
import * as startCommand from '../../../src/cli/commands/start'
import * as configureMenu from '../../../src/cli/tui/menus/configure'
import * as devMenu from '../../../src/cli/tui/menus/dev'
import * as manageMenu from '../../../src/cli/tui/menus/manage'
import * as startMenu from '../../../src/cli/tui/menus/start'
import { tuiPrompts } from '../../../src/cli/tui/prompts'

describe('cli tui menus', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('routes configure list action', async () => {
    sinon.stub(tuiPrompts, 'select').resolves('list' as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)
    const runList = sinon.stub(configCommands, 'runConfigList').resolves(0)

    const code = await configureMenu.runConfigureMenu()

    expect(code).to.equal(0)
    expect(runList.calledOnceWithExactly()).to.equal(true)
  })

  it('handles configure cancellation', async () => {
    sinon.stub(tuiPrompts, 'select').resolves(Symbol('cancel') as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(true)

    const code = await configureMenu.runConfigureMenu()

    expect(code).to.equal(1)
  })

  it('returns to previous menu on configure back selection', async () => {
    sinon.stub(tuiPrompts, 'select').resolves('back' as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const code = await configureMenu.runConfigureMenu()

    expect(code).to.equal(0)
  })

  it('routes start menu prompt values into start command', async () => {
    sinon.stub(tuiPrompts, 'select').resolves('continue' as any)
    sinon
      .stub(tuiPrompts, 'confirm')
      .onFirstCall()
      .resolves(true as any)
      .onSecondCall()
      .resolves(false as any)
      .onThirdCall()
      .resolves(true as any)
      .onCall(3)
      .resolves(false as any)
      .onCall(4)
      .resolves(true as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const runStart = sinon.stub(startCommand, 'runStart').resolves(0)

    const code = await startMenu.runStartMenu()

    expect(code).to.equal(0)
    expect(runStart.calledOnce).to.equal(true)
    expect(runStart.firstCall.args[0]).to.deep.equal({
      tor: true,
      i2p: false,
      debug: true,
      port: undefined,
    })
  })

  it('returns to previous menu on start back selection', async () => {
    sinon.stub(tuiPrompts, 'select').resolves('back' as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const code = await startMenu.runStartMenu()

    expect(code).to.equal(0)
  })

  it('maps manage export format selection to export file format', async () => {
    sinon
      .stub(tuiPrompts, 'select')
      .onFirstCall()
      .resolves('export' as any)
      .onSecondCall()
      .resolves('json' as any)
    sinon.stub(tuiPrompts, 'text').resolves('events.json' as any)
    sinon.stub(tuiPrompts, 'confirm').resolves(true as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const runExport = sinon.stub(exportCommand, 'runExport').resolves(0)

    const code = await manageMenu.runManageMenu()

    expect(code).to.equal(0)
    expect(runExport.calledOnceWithExactly({ output: 'events.json', format: 'json' }, [])).to.equal(true)
  })

  it('maps manage import format selection to import file defaults', async () => {
    sinon
      .stub(tuiPrompts, 'select')
      .onFirstCall()
      .resolves('import' as any)
      .onSecondCall()
      .resolves('json' as any)
    sinon
      .stub(tuiPrompts, 'text')
      .onFirstCall()
      .resolves('events.json' as any)
      .onSecondCall()
      .resolves('500' as any)
    sinon.stub(tuiPrompts, 'confirm').resolves(true as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const runImport = sinon.stub(importCommand, 'runImport').resolves(0)

    const code = await manageMenu.runManageMenu()

    expect(code).to.equal(0)
    expect(runImport.calledOnceWithExactly({ file: 'events.json', batchSize: 500 }, [])).to.equal(true)
  })

  it('returns to previous menu on manage back selection', async () => {
    sinon.stub(tuiPrompts, 'select').resolves('back' as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const code = await manageMenu.runManageMenu()

    expect(code).to.equal(0)
  })

  it('returns to previous menu on dev back selection', async () => {
    sinon.stub(tuiPrompts, 'select').resolves('back' as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)

    const code = await devMenu.runDevMenu()

    expect(code).to.equal(0)
  })
})
