import { expect } from 'chai'
import fs from 'fs'
import os from 'os'
import path from 'path'
import sinon from 'sinon'

import { buildComposeArgs, createPortOverrideComposeFile } from '../../../src/cli/utils/docker'

describe('cli docker utils', () => {
  afterEach(() => {
    sinon.restore()
  })

  it('includes only existing compose files', () => {
    const existsSyncStub = sinon.stub(fs, 'existsSync').callsFake((input) => String(input).includes('docker-compose.yml'))

    const args = buildComposeArgs(['docker-compose.yml', 'docker-compose.tor.yml'], ['up'])

    expect(existsSyncStub.called).to.equal(true)
    expect(args).to.include('up')
    expect(args).to.include(path.join(process.cwd(), 'docker-compose.yml'))
    expect(args).to.not.include(path.join(process.cwd(), 'docker-compose.tor.yml'))
  })

  it('creates a temporary port override compose file', () => {
    const tempFile = createPortOverrideComposeFile(9999)
    const content = fs.readFileSync(tempFile, 'utf-8')

    expect(tempFile.startsWith(os.tmpdir())).to.equal(true)
    expect(content).to.include('127.0.0.1:9999:9999')

    fs.unlinkSync(tempFile)
  })
})
