import { spawn } from 'child_process'

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: 'inherit' | 'pipe'
  timeoutMs?: number
}

export type CommandResult =
  | { ok: true; code: number; stdout: string; stderr: string }
  | { ok: false; reason: 'not-found' | 'permission-denied' | 'spawn-error' | 'timeout' | 'signal'; stdout: string; stderr: string }

export const runCommand = (command: string, args: string[], options: RunOptions = {}): Promise<number> => {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? 'inherit',
      shell: false,
    })

    const timer =
      typeof options.timeoutMs === 'number'
        ? setTimeout(() => {
            child.kill('SIGTERM')
          }, options.timeoutMs)
        : undefined

    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer)
      }

      resolve(code ?? 1)
    })
  })
}

export const runCommandWithOutput = (
  command: string,
  args: string[],
  options: RunOptions = {},
): Promise<CommandResult> => {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const settle = (result: CommandResult) => {
      if (!settled) {
        settled = true
        resolve(result)
      }
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: 'pipe',
      shell: false,
    })

    const timer =
      typeof options.timeoutMs === 'number'
        ? setTimeout(() => {
            timedOut = true
            child.kill('SIGTERM')
          }, options.timeoutMs)
        : undefined

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timer) { clearTimeout(timer) }
      if (err.code === 'ENOENT') {
        settle({ ok: false, reason: 'not-found', stdout, stderr })
      } else if (err.code === 'EACCES') {
        settle({ ok: false, reason: 'permission-denied', stdout, stderr })
      } else {
        settle({ ok: false, reason: 'spawn-error', stdout, stderr })
      }
    })

    child.on('close', (code, signal) => {
      if (timer) { clearTimeout(timer) }

      if (timedOut) {
        settle({ ok: false, reason: 'timeout', stdout, stderr })
        return
      }

      if (signal !== null && code === null) {
        settle({ ok: false, reason: 'signal', stdout, stderr })
        return
      }

      settle({ ok: true, code: code ?? 1, stdout, stderr })
    })
  })
}
