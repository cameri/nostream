import { spawn } from 'child_process'

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: 'inherit' | 'pipe'
  timeoutMs?: number
}

export type CommandResult =
  | { ok: true; code: number; stdout: string; stderr: string }
  | {
      ok: false
      reason: 'not-found' | 'permission-denied' | 'spawn-error' | 'timeout' | 'signal'
      stdout: string
      stderr: string
    }

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
      if (timer) {
        clearTimeout(timer)
      }
      if (err.code === 'ENOENT') {
        settle({ ok: false, reason: 'not-found', stdout, stderr })
      } else if (err.code === 'EACCES') {
        settle({ ok: false, reason: 'permission-denied', stdout, stderr })
      } else {
        settle({ ok: false, reason: 'spawn-error', stdout, stderr })
      }
    })

    child.on('close', (code, signal) => {
      if (timer) {
        clearTimeout(timer)
      }

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

export type WorkerSpawnErrorReason = 'not-found' | 'permission-denied' | 'spawn-error'

export type WorkerProcessHandle = {
  send: (message: unknown) => void
  onMessage: (handler: (message: unknown) => void) => void
  onExit: (handler: (code: number | null, signal: NodeJS.Signals | null) => void) => void
  onSpawnError: (handler: (reason: WorkerSpawnErrorReason) => void) => void
  kill: () => void
}

/**
 * Spawns a long-lived worker process and frames messages to/from it as
 * newline-delimited JSON over stdin/stdout, so one process can multiplex
 * multiple in-flight jobs. Reuses the same spawn/error-classification
 * conventions as runCommandWithOutput rather than a second spawn pattern.
 */
export const spawnWorkerProcess = (
  command: string,
  args: string[],
  options: Pick<RunOptions, 'cwd' | 'env'> = {},
): WorkerProcessHandle => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: 'pipe',
    shell: false,
  })

  const messageHandlers: Array<(message: unknown) => void> = []
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const spawnErrorHandlers: Array<(reason: WorkerSpawnErrorReason) => void> = []

  let buffer = ''
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (line) {
        try {
          const message = JSON.parse(line)
          messageHandlers.forEach((handler) => handler(message))
        } catch {
          // Malformed line from the worker — drop it rather than crash the relay process.
        }
      }
      newlineIndex = buffer.indexOf('\n')
    }
  })

  child.on('error', (err: NodeJS.ErrnoException) => {
    const reason: WorkerSpawnErrorReason =
      err.code === 'ENOENT' ? 'not-found' : err.code === 'EACCES' ? 'permission-denied' : 'spawn-error'
    spawnErrorHandlers.forEach((handler) => handler(reason))
  })

  child.on('exit', (code, signal) => {
    exitHandlers.forEach((handler) => handler(code, signal))
  })

  return {
    send: (message) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    onMessage: (handler) => {
      messageHandlers.push(handler)
    },
    onExit: (handler) => {
      exitHandlers.push(handler)
    },
    onSpawnError: (handler) => {
      spawnErrorHandlers.push(handler)
    },
    kill: () => {
      child.kill('SIGTERM')
    },
  }
}
