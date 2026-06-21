const { expect } = require('chai')

const { runCommandWithOutput } = require('../../../dist/src/cli/utils/process.js')

describe('runCommandWithOutput', () => {
  it('resolves ok:true with captured stdout, stderr and exit code 0', async () => {
    const result = await runCommandWithOutput('sh', ['-c', 'echo out; echo err >&2'])

    expect(result).to.deep.equal({ ok: true, code: 0, stdout: 'out\n', stderr: 'err\n' })
  })

  it('resolves ok:true with non-zero exit code', async () => {
    const result = await runCommandWithOutput('sh', ['-c', 'exit 2'])

    expect(result.ok).to.equal(true)
    expect(result.code).to.equal(2)
  })

  it('resolves ok:false reason:not-found when command does not exist (ENOENT)', async () => {
    const result = await runCommandWithOutput('__nostream_nonexistent_cmd__', [])

    expect(result).to.deep.equal({ ok: false, reason: 'not-found', stdout: '', stderr: '' })
  })

  it('resolves ok:false reason:timeout when the process exceeds timeoutMs', async () => {
    const result = await runCommandWithOutput('sleep', ['10'], { timeoutMs: 100 })

    expect(result).to.deep.equal({ ok: false, reason: 'timeout', stdout: '', stderr: '' })
  })

  it('resolves ok:false reason:signal when the process is killed by a signal', async () => {
    const result = await runCommandWithOutput('sh', ['-c', 'kill -9 $$'])

    expect(result.ok).to.equal(false)
    expect(result.reason).to.equal('signal')
  })

  it('does not double-settle when ENOENT fires both error and close', async () => {
    const result = await runCommandWithOutput('__nostream_nonexistent_cmd__', [])

    expect(result.ok).to.equal(false)
    expect(result.reason).to.equal('not-found')
  })
})
