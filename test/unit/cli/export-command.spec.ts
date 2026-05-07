import { expect } from 'chai'
import sinon from 'sinon'

import * as exportEventsModule from '../../../src/scripts/export-events'
import { runExport } from '../../../src/cli/commands/export'

describe('runExport command adapter', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('forwards legacy compression flags to export-events runtime', async () => {
    const runExportEventsStub = sinon.stub(exportEventsModule, 'runExportEvents').resolves(0)

    const code = await runExport(
      {
        output: 'backup.jsonl.gz',
        compress: true,
        compressionFormat: 'gzip',
      },
      [],
    )

    expect(code).to.equal(0)
    expect(runExportEventsStub.calledOnce).to.equal(true)
    expect(runExportEventsStub.firstCall.args[0]).to.deep.equal(['backup.jsonl.gz', '--compress', '--format', 'gzip'])
    expect(runExportEventsStub.firstCall.args[1]).to.deep.equal({ format: undefined })
  })

  it('keeps structured format in options while removing handled raw args', async () => {
    const runExportEventsStub = sinon.stub(exportEventsModule, 'runExportEvents').resolves(0)

    const code = await runExport(
      {
        output: 'backup.json',
        format: 'json',
      },
      ['--format', 'json', '--compress', '-z', '--unknown-flag'],
    )

    expect(code).to.equal(0)
    expect(runExportEventsStub.calledOnce).to.equal(true)
    expect(runExportEventsStub.firstCall.args[0]).to.deep.equal(['backup.json', '--unknown-flag'])
    expect(runExportEventsStub.firstCall.args[1]).to.deep.equal({ format: 'json' })
  })
})
