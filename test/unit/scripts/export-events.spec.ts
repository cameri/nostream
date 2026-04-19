import { expect } from 'chai'

import { CompressionFormat } from '../../../src/utils/compression'
import {
  formatBytes,
  formatCompressionDelta,
  getRatePerSecond,
  parseCliArgs,
} from '../../../src/scripts/export-events'

describe('parseCliArgs (export-events)', () => {
  it('uses defaults when no args are provided', () => {
    const result = parseCliArgs([])

    expect(result).to.deep.equal({
      compress: false,
      format: undefined,
      outputFilePath: 'events.jsonl',
      showHelp: false,
    })
  })

  it('returns help mode when --help is present', () => {
    const result = parseCliArgs(['--help'])

    expect(result).to.deep.equal({
      compress: false,
      format: undefined,
      outputFilePath: 'events.jsonl',
      showHelp: true,
    })
  })

  it('parses output file without compression', () => {
    const result = parseCliArgs(['backup.jsonl'])

    expect(result).to.deep.equal({
      compress: false,
      format: undefined,
      outputFilePath: 'backup.jsonl',
      showHelp: false,
    })
  })

  it('parses compression flags and explicit format', () => {
    const result = parseCliArgs(['backup.jsonl.gz', '--compress', '--format', 'gz'])

    expect(result).to.deep.equal({
      compress: true,
      format: CompressionFormat.GZIP,
      outputFilePath: 'backup.jsonl.gz',
      showHelp: false,
    })
  })

  it('parses inline --format value', () => {
    const result = parseCliArgs(['backup.jsonl.xz', '-z', '--format=xz'])

    expect(result).to.deep.equal({
      compress: true,
      format: CompressionFormat.XZ,
      outputFilePath: 'backup.jsonl.xz',
      showHelp: false,
    })
  })

  it('infers format from extension when compression is enabled', () => {
    const gzipResult = parseCliArgs(['backup.jsonl.gz', '--compress'])
    const xzResult = parseCliArgs(['backup.jsonl.xz', '-z'])

    expect(gzipResult.format).to.equal(CompressionFormat.GZIP)
    expect(xzResult.format).to.equal(CompressionFormat.XZ)
  })

  it('defaults to gzip when compression is enabled and extension is unknown', () => {
    const result = parseCliArgs(['backup.data', '--compress'])

    expect(result).to.deep.equal({
      compress: true,
      format: CompressionFormat.GZIP,
      outputFilePath: 'backup.data',
      showHelp: false,
    })
  })

  it('throws when --format is provided without --compress', () => {
    expect(() => parseCliArgs(['backup.jsonl', '--format=gzip']))
      .to.throw('--format requires --compress')
  })

  it('throws when --format is missing a value', () => {
    expect(() => parseCliArgs(['--compress', '--format']))
      .to.throw('Missing value for --format')

    expect(() => parseCliArgs(['--compress', '--format=']))
      .to.throw('Missing value for --format')
  })

  it('throws on unknown options', () => {
    expect(() => parseCliArgs(['--unknown']))
      .to.throw('Unknown option: --unknown')
  })

  it('throws on unexpected extra positional arguments', () => {
    expect(() => parseCliArgs(['backup.jsonl', 'extra.jsonl']))
      .to.throw('Unexpected extra argument: extra.jsonl')
  })
})

describe('export metrics helpers', () => {
  it('formats bytes using binary units', () => {
    expect(formatBytes(0)).to.equal('0 B')
    expect(formatBytes(1023)).to.equal('1023 B')
    expect(formatBytes(1024)).to.equal('1 KiB')
    expect(formatBytes(1536)).to.equal('1.5 KiB')
    expect(formatBytes(1048576)).to.equal('1 MiB')
  })

  it('formats compression delta for smaller output', () => {
    expect(formatCompressionDelta(1000, 250)).to.equal('75% smaller')
  })

  it('formats compression delta for larger output', () => {
    expect(formatCompressionDelta(1000, 1200)).to.equal('20% larger')
  })

  it('returns undefined compression delta when raw bytes are zero', () => {
    expect(formatCompressionDelta(0, 100)).to.equal(undefined)
  })

  it('calculates per-second rates safely', () => {
    expect(getRatePerSecond(400, 2000)).to.equal(200)
    expect(getRatePerSecond(0, 2000)).to.equal(0)
    expect(getRatePerSecond(1000, 0)).to.equal(1000000)
  })
})
