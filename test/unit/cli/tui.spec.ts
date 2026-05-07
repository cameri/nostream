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

  it('routes guided configure values into config set', async () => {
    sinon
      .stub(tuiPrompts, 'select')
      .onFirstCall()
      .resolves('guided' as any)
      .onSecondCall()
      .resolves('payments' as any)
      .onThirdCall()
      .resolves('payments.processor' as any)
      .onCall(3)
      .resolves('lnbits' as any)
    sinon
      .stub(tuiPrompts, 'confirm')
      .onFirstCall()
      .resolves(true as any)
      .onSecondCall()
      .resolves(false as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)
    sinon.stub(configCommands, 'getConfigTopLevelCategories').returns(['payments', 'limits', 'network'])
    const runConfigSet = sinon.stub(configCommands, 'runConfigSet').resolves(0)

    const code = await configureMenu.runConfigureMenu()

    expect(code).to.equal(0)
    expect(runConfigSet.calledOnceWithExactly('payments.processor', 'lnbits', {
      restart: false,
      validate: true,
      valueType: 'inferred',
    })).to.equal(true)
  })

  it('rejects invalid guided numeric input before writing', async () => {
    sinon
      .stub(tuiPrompts, 'select')
      .onFirstCall()
      .resolves('guided' as any)
      .onSecondCall()
      .resolves('limits' as any)
      .onThirdCall()
      .resolves('limits.event.content[0].maxLength' as any)
    const textStub = sinon.stub(tuiPrompts, 'text').callsFake(async (options: any) => {
      expect(options.validate('bad')).to.equal('Value must be a non-negative integer')
      expect(options.validate('2048')).to.equal(undefined)
      return '2048'
    })
    sinon
      .stub(tuiPrompts, 'confirm')
      .onFirstCall()
      .resolves(true as any)
      .onSecondCall()
      .resolves(false as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)
    const runConfigSet = sinon.stub(configCommands, 'runConfigSet').resolves(0)

    const code = await configureMenu.runConfigureMenu()

    expect(code).to.equal(0)
    expect(textStub.calledOnce).to.equal(true)
    expect(runConfigSet.calledOnceWithExactly('limits.event.content[0].maxLength', '2048', {
      restart: false,
      validate: true,
      valueType: 'inferred',
    })).to.equal(true)
  })

  it('keeps advanced configure get action available', async () => {
    sinon
      .stub(tuiPrompts, 'select')
      .onFirstCall()
      .resolves('get' as any)
      .onSecondCall()
      .resolves('other' as any)
    sinon
      .stub(tuiPrompts, 'text')
      .resolves('payments.enabled' as any)
    sinon.stub(tuiPrompts, 'confirm').resolves(true as any)
    sinon.stub(tuiPrompts, 'isCancel').returns(false)
    const runGet = sinon.stub(configCommands, 'runConfigGet').resolves(0)

    const code = await configureMenu.runConfigureMenu()

    expect(code).to.equal(0)
    expect(runGet.calledOnceWithExactly('payments.enabled')).to.equal(true)
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
