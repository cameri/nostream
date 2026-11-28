import { expect } from 'chai'

import { runImport } from '../../../src/cli/commands/import'

describe('runImport', () => {
  it('shows control characters of a rejected import as visible escapes', async () => {
    const file = 'missing-\u001b]52;c;ZXZpbA\u0007.jsonl'

    try {
      await runImport({ file }, [])
      expect.fail('Expected the import to reject')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include('Input file does not exist')
      expect(message).to.include('missing-\\x1b]52;c;ZXZpbA\\x07.jsonl')
      expect(message).to.not.match(/[\u0000-\u001f\u007f-\u009f]/)
    }
  })
})
