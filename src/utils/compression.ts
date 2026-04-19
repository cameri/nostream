import { createGunzip, createGzip } from 'zlib'
import { PassThrough, Transform } from 'stream'
import { cpus } from 'os'
import { extname } from 'path'
import { open } from 'fs/promises'

export enum CompressionFormat {
  GZIP = 'gzip',
  XZ = 'xz',
}

const GZIP_MAGIC = Buffer.from([0x1f, 0x8b])
const XZ_MAGIC = Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])

const DEFAULT_XZ_PRESET = 6
const DEFAULT_MAX_XZ_THREADS = 4
const MIN_XZ_PRESET = 0
const MAX_XZ_PRESET = 9

type LzmaNative = {
  createCompressor: (options?: Record<string, unknown>) => Transform
  createDecompressor: (options?: Record<string, unknown>) => Transform
}

type Environment = Record<string, string | undefined>

const getLzmaNative = (): LzmaNative => {
  try {
    return require('lzma-native') as LzmaNative
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)

    throw new Error(`XZ support requires the "lzma-native" package. Install dependencies and try again. (${reason})`)
  }
}

const parseIntegerEnv = (
  key: string,
  env: Environment,
): number | undefined => {
  const rawValue = env[key]
  if (!rawValue || rawValue.trim() === '') {
    return undefined
  }

  if (!/^-?\d+$/.test(rawValue.trim())) {
    throw new Error(`Invalid ${key}: ${rawValue}. Expected an integer.`)
  }

  return Number(rawValue)
}

export const getXzCompressionOptions = (
  cpuCount: number,
  env: Environment = process.env,
): { preset: number; threads: number } => {
  const parsedPreset = parseIntegerEnv('NOSTREAM_XZ_PRESET', env)
  const preset = parsedPreset ?? DEFAULT_XZ_PRESET

  if (preset < MIN_XZ_PRESET || preset > MAX_XZ_PRESET) {
    throw new Error(
      `Invalid NOSTREAM_XZ_PRESET: ${preset}. Expected an integer between ${MIN_XZ_PRESET} and ${MAX_XZ_PRESET}.`,
    )
  }

  const parsedThreadCap = parseIntegerEnv('NOSTREAM_XZ_THREADS', env)
  if (parsedThreadCap !== undefined && parsedThreadCap <= 0) {
    throw new Error('Invalid NOSTREAM_XZ_THREADS: expected a positive integer.')
  }

  // Keep one core available by default to reduce contention with the running relay.
  const availableThreads = Math.max(1, Math.max(1, Math.trunc(cpuCount)) - 1)
  const maxThreads = parsedThreadCap ?? DEFAULT_MAX_XZ_THREADS

  return {
    preset,
    threads: Math.max(1, Math.min(availableThreads, maxThreads)),
  }
}

export const parseCompressionFormat = (input: string): CompressionFormat => {
  switch (input.trim().toLowerCase()) {
    case 'gzip':
    case 'gz':
      return CompressionFormat.GZIP
    case 'xz':
      return CompressionFormat.XZ
    default:
      throw new Error(`Unsupported compression format: ${input}. Use gzip|gz|xz.`)
  }
}

export const getCompressionFormatFromExtension = (
  filePath: string,
): CompressionFormat | undefined => {
  switch (extname(filePath).toLowerCase()) {
    case '.gz':
      return CompressionFormat.GZIP
    case '.xz':
      return CompressionFormat.XZ
    default:
      return undefined
  }
}

export const getCompressionFormatFromHeader = (
  header: Buffer,
): CompressionFormat | undefined => {
  if (header.length >= GZIP_MAGIC.length && header.subarray(0, GZIP_MAGIC.length).equals(GZIP_MAGIC)) {
    return CompressionFormat.GZIP
  }

  if (header.length >= XZ_MAGIC.length && header.subarray(0, XZ_MAGIC.length).equals(XZ_MAGIC)) {
    return CompressionFormat.XZ
  }

  return undefined
}

const readFileHeader = async (filePath: string, bytes = XZ_MAGIC.length): Promise<Buffer> => {
  const fileHandle = await open(filePath, 'r')

  try {
    const header = Buffer.alloc(bytes)
    const { bytesRead } = await fileHandle.read(header, 0, bytes, 0)

    return header.subarray(0, bytesRead)
  } finally {
    await fileHandle.close()
  }
}

export const detectCompressionFormat = async (
  filePath: string,
): Promise<CompressionFormat | undefined> => {
  const extensionFormat = getCompressionFormatFromExtension(filePath)
  const header = await readFileHeader(filePath)
  const headerFormat = getCompressionFormatFromHeader(header)

  if (extensionFormat && headerFormat && extensionFormat !== headerFormat) {
    throw new Error(
      `Compression mismatch for ${filePath}: extension suggests ${extensionFormat} but header is ${headerFormat}.`,
    )
  }

  return headerFormat ?? extensionFormat
}

export const createCompressionStream = (
  format?: CompressionFormat,
): Transform => {
  if (!format) {
    return new PassThrough()
  }

  switch (format) {
    case CompressionFormat.GZIP:
      return createGzip()
    case CompressionFormat.XZ: {
      const lzmaNative = getLzmaNative()
      const { preset, threads } = getXzCompressionOptions(cpus().length)

      return lzmaNative.createCompressor({
        preset,
        threads,
      })
    }
    default:
      throw new Error(`Unsupported compression format: ${String(format)}`)
  }
}

export const createDecompressionStream = (
  format?: CompressionFormat,
): Transform => {
  if (!format) {
    return new PassThrough()
  }

  switch (format) {
    case CompressionFormat.GZIP:
      return createGunzip()
    case CompressionFormat.XZ:
      return getLzmaNative().createDecompressor()
    default:
      throw new Error(`Unsupported compression format: ${String(format)}`)
  }
}
