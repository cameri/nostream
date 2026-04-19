import { join } from 'path'

import fs from 'fs'
import os from 'os'
import { Readable } from 'stream'

import { expect } from 'chai'

import {
  CompressionFormat,
  createCompressionStream,
  createDecompressionStream,
  detectCompressionFormat,
  getXzCompressionOptions,
  getCompressionFormatFromExtension,
  getCompressionFormatFromHeader,
  parseCompressionFormat,
} from '../../../src/utils/compression'

const hasLzmaNative = (): boolean => {
  try {
    require.resolve('lzma-native')

    return true
  } catch {
    return false
  }
}

const toBuffer = async (stream: NodeJS.ReadableStream): Promise<Buffer> => {
  const chunks: Buffer[] = []

  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return Buffer.concat(chunks)
}

const expectStreamToFail = async (stream: NodeJS.ReadableStream): Promise<void> => {
  try {
    await toBuffer(stream)
    expect.fail('Expected stream to fail')
  } catch (error) {
    expect(error).to.be.instanceOf(Error)
  }
}

describe('compression utils', () => {
  const xzAvailable = hasLzmaNative()
  const itIfXzAvailable = xzAvailable ? it : it.skip

  const tempDirs: string[] = []

  const createTempFile = (name: string, data: Buffer): string => {
    const tmpDir = fs.mkdtempSync(join(os.tmpdir(), 'nostream-compression-'))
    tempDirs.push(tmpDir)

    const filePath = join(tmpDir, name)
    fs.writeFileSync(filePath, data)

    return filePath
  }

  afterEach(() => {
    for (const tmpDir of tempDirs.splice(0)) {
      fs.rmSync(tmpDir, {
        force: true,
        recursive: true,
      })
    }
  })

  it('parses format aliases', () => {
    expect(parseCompressionFormat('gzip')).to.equal(CompressionFormat.GZIP)
    expect(parseCompressionFormat('gz')).to.equal(CompressionFormat.GZIP)
    expect(parseCompressionFormat('xz')).to.equal(CompressionFormat.XZ)
    expect(parseCompressionFormat('  GZip  ')).to.equal(CompressionFormat.GZIP)
  })

  it('throws when parsing an unsupported format', () => {
    expect(() => parseCompressionFormat('brotli')).to.throw('Unsupported compression format')
  })

  it('detects compression from extension', () => {
    expect(getCompressionFormatFromExtension('events.jsonl.gz')).to.equal(CompressionFormat.GZIP)
    expect(getCompressionFormatFromExtension('events.jsonl.xz')).to.equal(CompressionFormat.XZ)
    expect(getCompressionFormatFromExtension('events.jsonl.GZ')).to.equal(CompressionFormat.GZIP)
    expect(getCompressionFormatFromExtension('events.jsonl')).to.equal(undefined)
  })

  it('detects compression from magic header bytes', () => {
    expect(getCompressionFormatFromHeader(Buffer.from([0x1f, 0x8b, 0x08]))).to.equal(CompressionFormat.GZIP)
    expect(
      getCompressionFormatFromHeader(Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00, 0x00])),
    ).to.equal(CompressionFormat.XZ)
    expect(getCompressionFormatFromHeader(Buffer.from('nostream'))).to.equal(undefined)
  })

  it('computes default xz options and reserves one CPU core', () => {
    expect(getXzCompressionOptions(16, {})).to.deep.equal({
      preset: 6,
      threads: 4,
    })

    expect(getXzCompressionOptions(2, {})).to.deep.equal({
      preset: 6,
      threads: 1,
    })

    expect(getXzCompressionOptions(1, {})).to.deep.equal({
      preset: 6,
      threads: 1,
    })
  })

  it('uses NOSTREAM_XZ_THREADS when provided', () => {
    expect(
      getXzCompressionOptions(8, {
        NOSTREAM_XZ_THREADS: '2',
      }),
    ).to.deep.equal({
      preset: 6,
      threads: 2,
    })
  })

  it('clamps configured xz threads to available CPU cores', () => {
    const options = getXzCompressionOptions(4, {
      NOSTREAM_XZ_THREADS: '99',
    })

    expect(options.threads).to.equal(3)
  })

  it('uses NOSTREAM_XZ_PRESET when provided', () => {
    expect(
      getXzCompressionOptions(8, {
        NOSTREAM_XZ_PRESET: '9',
      }),
    ).to.deep.equal({
      preset: 9,
      threads: 4,
    })
  })

  it('throws on invalid NOSTREAM_XZ_THREADS values', () => {
    expect(() => getXzCompressionOptions(8, {
      NOSTREAM_XZ_THREADS: '0',
    })).to.throw('Invalid NOSTREAM_XZ_THREADS: expected a positive integer.')

    expect(() => getXzCompressionOptions(8, {
      NOSTREAM_XZ_THREADS: 'abc',
    })).to.throw('Invalid NOSTREAM_XZ_THREADS: abc. Expected an integer.')
  })

  it('throws on invalid NOSTREAM_XZ_PRESET values', () => {
    expect(() => getXzCompressionOptions(8, {
      NOSTREAM_XZ_PRESET: '-1',
    })).to.throw('Invalid NOSTREAM_XZ_PRESET: -1. Expected an integer between 0 and 9.')

    expect(() => getXzCompressionOptions(8, {
      NOSTREAM_XZ_PRESET: '10',
    })).to.throw('Invalid NOSTREAM_XZ_PRESET: 10. Expected an integer between 0 and 9.')

    expect(() => getXzCompressionOptions(8, {
      NOSTREAM_XZ_PRESET: 'abc',
    })).to.throw('Invalid NOSTREAM_XZ_PRESET: abc. Expected an integer.')
  })

  it('round-trips data with gzip streams', async () => {
    const input = Buffer.from('nostream-gzip-test\n'.repeat(1024), 'utf-8')

    const compressed = await toBuffer(
      Readable.from([input]).pipe(createCompressionStream(CompressionFormat.GZIP)),
    )

    const decompressed = await toBuffer(
      Readable.from([compressed]).pipe(createDecompressionStream(CompressionFormat.GZIP)),
    )

    expect(decompressed.equals(input)).to.equal(true)
  })

  itIfXzAvailable('round-trips data with xz streams', async () => {
    const input = Buffer.from('nostream-xz-test\n'.repeat(2048), 'utf-8')

    const compressed = await toBuffer(
      Readable.from([input]).pipe(createCompressionStream(CompressionFormat.XZ)),
    )

    const decompressed = await toBuffer(
      Readable.from([compressed]).pipe(createDecompressionStream(CompressionFormat.XZ)),
    )

    expect(decompressed.equals(input)).to.equal(true)
  })

  it('passes data through unchanged when compression is disabled', async () => {
    const input = Buffer.from('nostream passthrough', 'utf-8')

    const compressed = await toBuffer(
      Readable.from([input]).pipe(createCompressionStream()),
    )

    const decompressed = await toBuffer(
      Readable.from([compressed]).pipe(createDecompressionStream()),
    )

    expect(decompressed.equals(input)).to.equal(true)
  })

  it('detects compressed files by header even without compressed extension', async () => {
    const input = Buffer.from('compressed payload\n'.repeat(128), 'utf-8')

    const gzipData = await toBuffer(
      Readable.from([input]).pipe(createCompressionStream(CompressionFormat.GZIP)),
    )

    const filePath = createTempFile('events.backup', gzipData)

    const format = await detectCompressionFormat(filePath)

    expect(format).to.equal(CompressionFormat.GZIP)
  })

  it('falls back to extension-based detection when header is unavailable', async () => {
    const filePath = createTempFile('empty.jsonl.xz', Buffer.alloc(0))

    const format = await detectCompressionFormat(filePath)

    expect(format).to.equal(CompressionFormat.XZ)
  })

  it('throws when extension and file header formats conflict', async () => {
    const input = Buffer.from('compressed payload\n'.repeat(128), 'utf-8')

    const gzipData = await toBuffer(
      Readable.from([input]).pipe(createCompressionStream(CompressionFormat.GZIP)),
    )

    const filePath = createTempFile('events.jsonl.xz', gzipData)

    try {
      await detectCompressionFormat(filePath)
      expect.fail('Expected detectCompressionFormat to throw on header/extension mismatch')
    } catch (error) {
      expect((error as Error).message).to.contain('Compression mismatch')
    }
  })

  it('fails to decompress invalid gzip payloads', async () => {
    const invalidPayload = Buffer.from('not-a-gzip-stream', 'utf-8')

    await expectStreamToFail(
      Readable.from([invalidPayload]).pipe(createDecompressionStream(CompressionFormat.GZIP)),
    )
  })

  itIfXzAvailable('fails to decompress invalid xz payloads', async () => {
    const invalidPayload = Buffer.from('not-an-xz-stream', 'utf-8')

    await expectStreamToFail(
      Readable.from([invalidPayload]).pipe(createDecompressionStream(CompressionFormat.XZ)),
    )
  })

  it('round-trips binary payloads across boundary sizes', async () => {
    const sizes = [0, 1, 2, 31, 32, 33, 1024, 8192]
    const formats = xzAvailable
      ? [CompressionFormat.GZIP, CompressionFormat.XZ]
      : [CompressionFormat.GZIP]

    for (const size of sizes) {
      const input = Buffer.alloc(size)
      for (let index = 0; index < size; index += 1) {
        input[index] = (index * 31 + 17) % 256
      }

      for (const format of formats) {
        const compressed = await toBuffer(
          Readable.from([input]).pipe(createCompressionStream(format)),
        )

        const decompressed = await toBuffer(
          Readable.from([compressed]).pipe(createDecompressionStream(format)),
        )

        expect(decompressed.equals(input)).to.equal(true)
      }
    }
  })
})
