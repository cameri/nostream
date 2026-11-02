import { expect } from 'chai'

import { BANNER_WIDTH, centre, isStructuredLogFormat, RELAY_BANNER_LINES } from '../../../src/utils/banner'

describe('startup banner', () => {
  // The banner is printed to stdout as text. A line wider than the block would
  // wrap in a terminal and turn the logo into noise.
  it('fits every line inside the banner width', () => {
    for (const line of RELAY_BANNER_LINES) {
      expect(line.length, line).to.be.at.most(BANNER_WIDTH)
    }
  })

  it('centres a short line', () => {
    const padded = centre('v1.2.3')

    expect(padded).to.equal(' '.repeat((BANNER_WIDTH - 6) >> 1) + 'v1.2.3')
    expect(padded.trimEnd()).to.equal(padded)
  })

  // Half a logo is worse than a wide one, so an overlong line is left alone
  // rather than cut to fit.
  it('never truncates a line longer than the width', () => {
    const long = 'x'.repeat(BANNER_WIDTH + 10)

    expect(centre(long)).to.equal(long)
  })

  it('pads nothing when the line is exactly the width', () => {
    const exact = 'x'.repeat(BANNER_WIDTH)

    expect(centre(exact)).to.equal(exact)
  })

  // LOG_FORMAT=json is a promise made to a log pipeline, so it is read strictly:
  // an unrecognised value falls back to the banner a person can read.
  it('reads LOG_FORMAT=json, trimmed and case-insensitively', () => {
    expect(isStructuredLogFormat('json')).to.equal(true)
    expect(isStructuredLogFormat(' JSON ')).to.equal(true)
  })

  it('keeps the banner for anything else', () => {
    expect(isStructuredLogFormat(undefined)).to.equal(false)
    expect(isStructuredLogFormat('')).to.equal(false)
    expect(isStructuredLogFormat('pretty')).to.equal(false)
    expect(isStructuredLogFormat('jsonlines')).to.equal(false)
  })
})
