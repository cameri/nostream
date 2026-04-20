import fs from 'fs'
import os from 'os'
import { join } from 'path'

import { getProjectPath } from './paths'
import { runCommand } from './process'

export type ComposeOptions = {
  files: string[]
  args: string[]
  env?: NodeJS.ProcessEnv
}

export const resolveComposeFile = (filename: string): string => getProjectPath(filename)

export const buildComposeArgs = (files: string[], args: string[]): string[] => {
  const out: string[] = []

  for (const file of files) {
    const fullPath = resolveComposeFile(file)
    if (fs.existsSync(fullPath)) {
      out.push('-f', fullPath)
    }
  }

  return [...out, ...args]
}

export const runDockerCompose = async ({ files, args, env }: ComposeOptions): Promise<number> => {
  const composeArgs = buildComposeArgs(files, args)
  return runCommand('docker', ['compose', ...composeArgs], { env })
}

export const createPortOverrideComposeFile = (port: number): string => {
  const tempFile = join(os.tmpdir(), `nostream-port-override-${process.pid}-${Date.now()}.yml`)
  const content = [
    'services:',
    '  nostream:',
    '    environment:',
    `      RELAY_PORT: ${port}`,
    '    ports:',
    `      - 127.0.0.1:${port}:${port}`,
  ].join('\n')

  fs.writeFileSync(tempFile, content, { encoding: 'utf-8' })
  return tempFile
}
