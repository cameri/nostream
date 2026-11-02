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
# One line per attempt, one field per argument: "$*" would join the arguments
# and hide an unquoted "$@" in the script under test.
for arg in "$@"; do printf '%s<ARG>' "$arg" >> "$STUB_ARGS"; done
printf '\\n' >> "$STUB_ARGS"
# BSD wc -l pads its count with leading spaces, which would make every case
# branch miss; the arithmetic expansion normalises it to a plain integer.
attempt=$(( $(wc -l < "$STUB_ARGS") ))
case "$attempt" in
${cases}
    *) echo "deployed"; exit 0;;
esac
`

  fs.writeFileSync(path.join(binDir, 'wrangler'), stub, { mode: 0o755 })
  return binDir
}

const ARG_SEPARATOR = '<ARG>'

const parseAttempts = (recorded: string): string[][] => {
  const trimmed = recorded.trim()
  if (trimmed === '') {
    return []
  }
  return trimmed.split('\n').map((line) => {
    const fields = line.split(ARG_SEPARATOR)
    // Every argument is followed by the separator, so the split leaves a
    // trailing empty field.
    return fields[fields.length - 1] === '' ? fields.slice(0, -1) : fields
  })
}

type Run = {
  status: number | null
  stdout: string
  stderr: string
  attempts: number
  invocations: string[][]
  /** Arguments of the first attempt, the one every test's expectation is about. */
  args: string[]
}

type RunOptions = { env?: NodeJS.ProcessEnv; pathPrefixes?: string[]; systemPath?: boolean }

const runScript = (dir: string, attempts: Attempt[], args: string[], options: RunOptions = {}): Run => {
  const binDir = writeStub(dir, attempts)
  const counter = path.join(dir, 'invocations.txt')
  fs.writeFileSync(counter, '')
  const searchPath = [
    ...(options.pathPrefixes ?? []),
    binDir,
    ...(options.systemPath === false ? [] : [process.env.PATH]),
  ].join(':')
  const result = spawnSync('bash', [scriptPath, ...args], {
    cwd: projectRoot,
    env: {
      ...process.env,
      ...options.env,
      STUB_ARGS: counter,
      PATH: searchPath,
      // The production defaults wait 10 s then 30 s; the tests assert the
      // retry happened, not how long it took.
      DEPLOY_BACKOFFS: '0 0',
    },
    encoding: 'utf-8',
    timeout: 30_000,
  })
  const invocations = parseAttempts(fs.readFileSync(counter, 'utf-8'))

  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    attempts: invocations.length,
    invocations,
    args: invocations[0] ?? [],
  }
}

const WRANGLER_ARGS = [
  'wrangler',
  'deploy',
  '--config',
  'wrangler.router.jsonc',
  '--var',
  'CANONICAL_HOST:nostream.dev',
]

const deploy = (dir: string, attempts: Attempt[], options: RunOptions = {}): Run =>
  runScript(dir, attempts, WRANGLER_ARGS, options)

/** Resolve a command the way a shell would, for building a restricted PATH. */
const resolveOnPath = (command: string): string | undefined => {
  for (const entry of (process.env.PATH ?? '').split(':')) {
    const candidate = path.join(entry, command)
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

// The script also warns when coreutils is absent (stock macOS), and that line is
// present on every run there. Assertions about retries must name the retry line,
// or they would fail on a laptop and pass in CI.
const RETRY_WARNING = /::warning::wrangler deploy attempt/g

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
    expect(result.stdout).to.not.match(RETRY_WARNING)
    expect(result.stderr).to.include('::error::')
  })

  it('does not retry a wrangler validation error', () => {
    const result = deploy(dir, [
      { stderr: '✘ [ERROR] Missing entry-point: The entry-point file at "dist/_worker.js" was not found.', code: 1 },
    ])

    expect(result.status).to.not.equal(0)
    expect(result.attempts).to.equal(1)
    expect(result.stdout).to.not.match(RETRY_WARNING)
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
    expect(result.stdout.match(RETRY_WARNING)).to.have.length(2)
  })

  it('passes the wrangler arguments through unchanged, one argument at a time', () => {
    const result = deploy(dir, [])

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(1)
    expect(result.args).to.deep.equal(['deploy', '--config', 'wrangler.router.jsonc', '--var', 'CANONICAL_HOST:nostream.dev'])
  })

  it('keeps an argument that contains spaces as one argument', () => {
    const args = ['wrangler', 'deploy', '--var', 'SITE_TITLE:Oh My Relay']
    const result = runScript(dir, [], args)

    expect(result.status, result.stderr).to.equal(0)
    // Unquoted `$@` in the script would split this into four arguments.
    expect(result.args).to.deep.equal(['deploy', '--var', 'SITE_TITLE:Oh My Relay'])
  })

  it('still deploys when no timeout command is installed (stock macOS)', () => {
    // A PATH with the tools the script needs and, deliberately, neither
    // `timeout` nor `gtimeout`. The script must degrade to an unbounded
    // attempt and say so, not exit 127 before the deploy runs.
    const restricted = path.join(dir, 'restricted-bin')
    fs.mkdirSync(restricted, { recursive: true })
    for (const tool of ['bash', 'cat', 'grep', 'head', 'mktemp', 'rm', 'sleep', 'tail', 'wc']) {
      const resolved = resolveOnPath(tool)
      if (!resolved) {
        throw new Error(`${tool} not found on PATH; cannot build the restricted environment`)
      }
      fs.symlinkSync(resolved, path.join(restricted, tool))
    }

    const result = deploy(dir, [], { pathPrefixes: [restricted], systemPath: false })

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(1)
    expect(result.stdout).to.match(/::warning::no 'timeout' or 'gtimeout' on PATH/)
  })

  it('retries an attempt that exceeds the per-attempt timeout', function () {
    if (!resolveOnPath('timeout') && !resolveOnPath('gtimeout')) {
      // Only reached on a host without coreutils, where the script has no bound
      // to exceed in the first place.
      this.skip()
    }
    this.timeout(20_000)
    const result = deploy(dir, [{ sleep: 30 }], { env: { DEPLOY_ATTEMPT_TIMEOUT: '1' } })

    expect(result.status, result.stderr).to.equal(0)
    expect(result.attempts).to.equal(2)
    expect(result.stdout).to.match(/::warning::.*timed out after 1s/)
  })
})
