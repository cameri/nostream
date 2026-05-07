import { expect } from 'chai'

import { parseCliArgs } from '../../src/import-events'

describe('parseCliArgs (import-events)', () => {
  it('parses a basic file argument with default batch size', () => {
    const result = parseCliArgs(['./events.jsonl'])

    expect(result).to.deep.equal({
      batchSize: 1000,
      filePath: './events.jsonl',
      showHelp: false,
    })
  })

  it('parses --batch-size with spaced value', () => {
    const result = parseCliArgs(['./events.jsonl', '--batch-size', '500'])

    expect(result).to.deep.equal({
      batchSize: 500,
      filePath: './events.jsonl',
      showHelp: false,
    })
  })

  it('parses --batch-size with inline value', () => {
    const result = parseCliArgs(['./events.jsonl', '--batch-size=250'])

    expect(result).to.deep.equal({
      batchSize: 250,
      filePath: './events.jsonl',
      showHelp: false,
    })
  })

  it('returns help mode when --help is present', () => {
    const result = parseCliArgs(['--help'])

    expect(result).to.deep.equal({
      batchSize: 1000,
      filePath: '',
      showHelp: true,
    })
  })

  it('throws when input file path is missing', () => {
    expect(() => parseCliArgs([])).to.throw('Missing path to .jsonl or .json file')
  })

  it('throws on unknown options including short options', () => {
    expect(() => parseCliArgs(['./events.jsonl', '--unknown']))
      .to.throw('Unknown option: --unknown')

    expect(() => parseCliArgs(['./events.jsonl', '-z']))
      .to.throw('Unknown option: -z')
  })

  it('throws when --batch-size value is missing', () => {
    expect(() => parseCliArgs(['./events.jsonl', '--batch-size']))
      .to.throw('Missing value for --batch-size')
  })

  it('throws when --batch-size is invalid', () => {
    expect(() => parseCliArgs(['./events.jsonl', '--batch-size=0']))
      .to.throw('Invalid --batch-size value: 0')

    expect(() => parseCliArgs(['./events.jsonl', '--batch-size=abc']))
      .to.throw('Invalid --batch-size value: abc')
  })

  it('throws when extra positional arguments are provided', () => {
    expect(() => parseCliArgs(['./events.jsonl', './more.jsonl']))
      .to.throw('Unexpected extra argument: ./more.jsonl')
  })
})
