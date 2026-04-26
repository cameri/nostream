import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sinon from 'sinon'

import { runImportEvents } from '../../../src/import-events'
import * as dbClient from '../../../src/database/client'
import { EventImportService, EventImportStats } from '../../../src/services/event-import-service'

const makeTempFile = (name: string, content: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-import-runtime-'))
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

const stubDb = () => {
  return {
    destroy: sinon.stub().resolves(),
  } as any
}

const emptyStats = (): EventImportStats => ({
  errors: 0,
  inserted: 0,
  processed: 0,
  skipped: 0,
})

describe('import runtime routing', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('routes .jsonl input to importFromJsonl', async () => {
    const filePath = makeTempFile('events.jsonl', '{"x":1}\n')

    sinon.stub(dbClient, 'getMasterDbClient').returns(stubDb())
    const jsonlStub = sinon.stub(EventImportService.prototype, 'importFromReadable').resolves(emptyStats())
    const jsonArrayStub = sinon.stub(EventImportService.prototype, 'importFromJsonArray').resolves(emptyStats())

    const code = await runImportEvents([filePath])

    expect(code).to.equal(0)
    expect(jsonlStub.calledOnce).to.equal(true)
    expect(jsonArrayStub.called).to.equal(false)
  })

  it('routes .json input to importFromJsonArray', async () => {
    const filePath = makeTempFile('events.json', '[]')

    sinon.stub(dbClient, 'getMasterDbClient').returns(stubDb())
    const jsonlStub = sinon.stub(EventImportService.prototype, 'importFromJsonl').resolves(emptyStats())
    const jsonArrayStub = sinon.stub(EventImportService.prototype, 'importFromJsonArray').resolves(emptyStats())

    const code = await runImportEvents([filePath])

    expect(code).to.equal(0)
    expect(jsonArrayStub.calledOnce).to.equal(true)
    expect(jsonlStub.called).to.equal(false)
  })

  it('rejects unsupported input extensions', async () => {
    const filePath = makeTempFile('events.txt', '')

    try {
      await runImportEvents([filePath])
      expect.fail('Expected unsupported extension to throw')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include('Input file must have a .jsonl or .json extension')
    }
  })

  it('prints help with .json and .jsonl usage', async () => {
    const logStub = sinon.stub(console, 'log')

    const code = await runImportEvents(['--help'])

    expect(code).to.equal(0)
    const output = logStub.getCalls().map((call) => call.args.join(' ')).join('\n')
    expect(output).to.include('file.jsonl|file.json')
    expect(output).to.include('nostream import ./events.json --batch-size 1000')
  })
})
