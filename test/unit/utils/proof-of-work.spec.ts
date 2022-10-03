import { expect } from 'chai'
import { getLeadingZeroBits } from '../../../src/utils/proof-of-work'

describe('getLeadingZeroBits()', () => {
  ['80', '40', '20', '10', '08', '04', '02', '01', '0080', '0040', '0020', '0010', '0008', '0004', '0002', '0001', '0000'].forEach((input, index) => {
    it(`returns ${index} given ${input}`,  () => {
      expect(getLeadingZeroBits(Buffer.from(input, 'hex'))).to.equal(index)
    })
  })
})
