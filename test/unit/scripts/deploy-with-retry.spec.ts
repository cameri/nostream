import { expect } from 'chai'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const projectRoot = process.cwd()
const scriptPath = path.join(projectRoot, '.github', 'scripts', 'deploy-with-retry.sh')

/**
 * Each entry describes what the stub `wrangler` does on that attempt: print
 * `stderr` and exit with `code`, or `sleep` for a number of seconds first. An
 * attempt beyond the list succeeds. The stub appends its arguments to a file so
 * the test can check what the caller actually invoked.
 */
type Attempt = { stderr?: string; code?: number; sleep?: number }

const writeStub = (dir: string, attempts: Attempt[]): string => {
  const binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir, { recursive: true })
  const cases = attempts
    .map((attempt, index) => {
      const body = [
        attempt.sleep ? `sleep ${attempt.sleep}` : '',
        attempt.stderr ? `printf '%s\\n' ${JSON.stringify(attempt.stderr)} >&2` : '',
        // A sleep-only attempt is expected to be killed by the attempt timeout,
        // so it never reaches its own exit.
        `exit ${attempt.code ?? 0}`,
      ]
        .filter(Boolean)
        .join('; ')
      return `    ${index + 1}) ${body};;`
    })
    .join('\n')
  const stub = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$STUB_ARGS"
attempt=$(wc -l < "$STUB_ARGS")
case "$attempt" in
${cases}
    *) echo "deployed"; exit 0;;
esac
`

  fs.writeFileSync(path.join(binDir, 'wrangler'), stub, { mode: 0o755 })
  return binDir
}

type Run = { status: number | null; stdout: string; stderr: string; attempts: number; args: string[] }

const runScript = (dir: string, attempts: Attempt[], args: string[], env: NodeJS.ProcessEnv = {}): Run => {
  const binDir = writeStub(dir, attempts)
  const counter = path.join(dir, 'invocations.txt')
  fs.writeFileSync(counter, '')
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...env,
      STUB_ARGS: counter,
      PATH: `${binDir}:${process.env.PATH}`,
      // The production defaults wait 10 s then 30 s; the tests assert the
      // retry happened, not how long it took.
      DEPLOY_BACKOFFS: '0 0',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
  const invocations = fs.readFileSync(counter, 'utf-8').trim()

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    attempts: invocations === '' ? 0 : invocations.split('\n').length,
    args: invocations === '' ? [] : invocations.split('\n'),
  }
}

const deploy = (dir: string, attempts: Attempt[], env: NodeJS.ProcessEnv = {}): Run =>
  runScript(
    dir,
    attempts,
    ['wrangler', 'deploy', '--config', 'wrangler.router.jsonc', '--var', 'CANONICAL_HOST:nostream.dev'],
    env,
  )

describe('deploy-with-retry.sh', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nostream-deploy-retry-'))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('retries a Cloudflare 10013 failure and names the attempt and reason', () => {
    const result = deploy(dir, [
      {
        stderr:
          'A request to the Cloudflare API (/accounts/x/workers/scripts/y/assets-upload-session) failed.\n  An unknown error has occurred. [code: 10013]',
        code: 1,
      },
    ])

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(2)
    expect(result.stdout).to.match(/::warning::wrangler deploy attempt 2\/3.*10013/)
  })

  it('does not retry an authentication failure', () => {
    const result = deploy(dir, [
      { stderr: 'Authentication error [code: 10000]\n  Invalid API Token (HTTP 401)', code: 1 },
    ])

    expect(result.status).to.not.equal(0)
    expect(result.attempts).to.equal(1)
    expect(result.stdout).to.not.include('::warning::')
    expect(result.stderr).to.include('::error::')
  })

  it('does not retry a wrangler validation error', () => {
    const result = deploy(dir, [
      { stderr: '✘ [ERROR] Missing entry-point: The entry-point file at "dist/_worker.js" was not found.', code: 1 },
    ])

    expect(result.status).to.not.equal(0)
    expect(result.attempts).to.equal(1)
    expect(result.stdout).to.not.include('::warning::')
  })

  it('retries an HTTP 5xx from the Cloudflare API', () => {
    const result = deploy(dir, [{ stderr: 'A request to the Cloudflare API failed: HTTP 502', code: 1 }])

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(2)
    expect(result.stdout).to.match(/::warning::.*HTTP 502/)
  })

  it('retries a connection reset', () => {
    const result = deploy(dir, [{ stderr: 'Error: read ECONNRESET: connection reset by peer', code: 1 }])

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(2)
    expect(result.stdout).to.match(/::warning::.*connection reset/)
  })

  it('gives up after the last attempt and keeps the last error on stderr', () => {
    const failing: Attempt = { stderr: 'An unknown error has occurred. [code: 10013]', code: 1 }
    const result = deploy(dir, [failing, failing, failing])

    expect(result.status).to.not.equal(0)
    expect(result.attempts).to.equal(3)
    expect(result.stderr).to.include('::error::deploy failed after 3 attempts')
    expect(result.stderr).to.include('10013')
    // One warning per retry, none for the first attempt.
    expect(result.stdout.match(/::warning::/g)).to.have.length(2)
  })

  it('passes the wrangler arguments through unchanged', () => {
    const result = deploy(dir, [])

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(1)
    expect(result.args[0]).to.equal('deploy --config wrangler.router.jsonc --var CANONICAL_HOST:nostream.dev')
  })

  it('retries an attempt that exceeds the per-attempt timeout', function () {
    this.timeout(20_000)
    const result = deploy(dir, [{ sleep: 30 }], { DEPLOY_ATTEMPT_TIMEOUT: '1' })

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(2)
    expect(result.stdout).to.match(/::warning::.*timed out after 1s/)
  })
})
