import { Transform, Writable } from 'stream'

export const toJSON = (input: any) => JSON.stringify(input)

export const toBuffer = (input: any) => Buffer.from(input, 'hex')

export const fromBuffer = (input: Buffer) => input.toString('hex')

export const streamMap = (fn: (chunk) => any) => new Transform({
  objectMode: true,
  transform(chunk, _encoding, callback) {
    callback(null, fn(chunk))
  }
})

export const streamEach = (writeFn: (chunk: any) => void, finalFn: () => void) => new Writable({
  objectMode: true,
  write(chunk, _encoding, callback) {
    writeFn(chunk)
    callback()
  },
  final(callback) {
    finalFn()
    callback()
  },
})
