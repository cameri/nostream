import { spawn } from 'child_process'

export type RunOptions = {
  cwd?: string
  env?: NodeJS.ProcessEnv
  stdio?: 'inherit' | 'pipe'
  timeoutMs?: number
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
): Promise<{ code: number; stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: 'pipe',
      shell: false,
    })

    const timer =
      typeof options.timeoutMs === 'number'
        ? setTimeout(() => {
            child.kill('SIGTERM')
          }, options.timeoutMs)
        : undefined

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)
    child.on('close', (code) => {
      if (timer) {
        clearTimeout(timer)
      }

      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      })
    })
  })
}
