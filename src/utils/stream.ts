import { PassThrough, Transform } from 'stream'

export const streamMap = (fn: (chunk) => any) => new Transform({
  objectMode: true,
  transform(chunk, _encoding, callback) {
    callback(null, fn(chunk))
  }
})

export const streamEach = (writeFn: (chunk: any) => void) => new PassThrough({
  objectMode: true,
  write(chunk, _encoding, callback) {
    writeFn(chunk)
    callback(null)
  },
})

export const streamEnd = (finalFn: () => void) => new PassThrough({
  objectMode: true,
  final(callback) {
    finalFn()
    callback()
  },
})
