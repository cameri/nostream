import chai from 'chai'

const { expect } = chai

import * as fs from 'fs'
import { getTemplate } from '../../../src/utils/template-cache'
import { join } from 'path'
import { tmpdir } from 'os'

describe('getTemplate', () => {
  const tmpFile = join(tmpdir(), 'test-template.html')

  beforeEach(() => {
    fs.writeFileSync(tmpFile, 'template content')
  })

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile)
    } catch (_e) {
      /* ignore */
    }
  })

  it('returns the file content', () => {
    const result = getTemplate(tmpFile)
    expect(result).to.equal('template content')
  })

  it('reads the file on every call in non-production mode', () => {
    // NODE_ENV is not 'production' in tests — cache is bypassed
    getTemplate(tmpFile)
    fs.writeFileSync(tmpFile, 'updated content')
    const result2 = getTemplate(tmpFile)

    expect(result2).to.equal('updated content')
  })

  it('propagates errors thrown by readFileSync', () => {
    expect(() => getTemplate('./does-not-exist.html')).to.throw(/ENOENT/)
  })
})
