import { expect } from 'chai'

import { parseCleanDbOptions } from '../../src/clean-db'

describe('parseCleanDbOptions', () => {
  it('parses --all with --force', () => {
    const result = parseCleanDbOptions(['--all', '--force'])

    expect(result).to.deep.equal({
      all: true,
      dryRun: false,
      force: true,
      help: false,
      kinds: [],
    })
  })

  it('parses combined selective filters and deduplicates kinds', () => {
    const result = parseCleanDbOptions(['--older-than=7', '--kinds=1,7,1', '--dry-run'])

    expect(result).to.deep.equal({
      all: false,
      dryRun: true,
      force: false,
      help: false,
      kinds: [1, 7],
      olderThanDays: 7,
    })
  })

  it('parses spaced option values', () => {
    const result = parseCleanDbOptions(['--older-than', '30', '--kinds', '1,2,3'])

    expect(result).to.deep.equal({
      all: false,
      dryRun: false,
      force: false,
      help: false,
      kinds: [1, 2, 3],
      olderThanDays: 30,
    })
  })

  it('accepts --help without requiring target filters', () => {
    const result = parseCleanDbOptions(['--help'])

    expect(result).to.deep.equal({
      all: false,
      dryRun: false,
      force: false,
      help: true,
      kinds: [],
    })
  })

  it('throws when no deletion target is provided', () => {
    expect(() => parseCleanDbOptions(['--force'])).to.throw('Select a target with --all, --older-than, or --kinds')
  })

  it('throws when --all is combined with selective options', () => {
    expect(() => parseCleanDbOptions(['--all', '--older-than=30'])).to.throw(
      '--all cannot be combined with --older-than or --kinds',
    )

    expect(() => parseCleanDbOptions(['--all', '--kinds=1,7'])).to.throw(
      '--all cannot be combined with --older-than or --kinds',
    )
  })

  it('throws on invalid --older-than values', () => {
    expect(() => parseCleanDbOptions(['--older-than=0'])).to.throw('--older-than must be a positive integer')

    expect(() => parseCleanDbOptions(['--older-than=-1'])).to.throw('--older-than must be a positive integer')

    expect(() => parseCleanDbOptions(['--older-than=abc'])).to.throw('--older-than must be a positive integer')
  })

  it('throws on invalid --kinds values', () => {
    expect(() => parseCleanDbOptions(['--kinds='])).to.throw('Missing value for --kinds')

    expect(() => parseCleanDbOptions(['--kinds=1,abc'])).to.throw(
      '--kinds must be a comma-separated list of non-negative integers',
    )
  })

  it('throws on unknown options', () => {
    expect(() => parseCleanDbOptions(['--unknown'])).to.throw('Unknown option: --unknown')
  })

  it('rejects options that only share a prefix with supported flags', () => {
    expect(() => parseCleanDbOptions(['--older-than-days=7'])).to.throw('Unknown option: --older-than-days=7')

    expect(() => parseCleanDbOptions(['--kinds-extra', '1,2,3'])).to.throw('Unknown option: --kinds-extra')
  })
})
