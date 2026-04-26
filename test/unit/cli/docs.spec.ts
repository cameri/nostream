import { expect } from 'chai'
import fs from 'fs'
import path from 'path'

describe('cli documentation alignment', () => {
  const projectRoot = process.cwd()

  it('documents removed legacy wrapper scripts explicitly', () => {
    const readme = fs.readFileSync(path.join(projectRoot, 'README.md'), 'utf-8')
    const cliDoc = fs.readFileSync(path.join(projectRoot, 'CLI.md'), 'utf-8')

    expect(readme).to.include('The old shell wrapper scripts are no longer shipped in `scripts/`.')
    expect(cliDoc).to.include('The old shell wrapper scripts are no longer shipped in `scripts/`.')
  })

  it('documents the guided TUI configure flow and fallback behavior', () => {
    const cliDoc = fs.readFileSync(path.join(projectRoot, 'CLI.md'), 'utf-8')

    expect(cliDoc).to.include('When run with no arguments in an interactive terminal, `nostream` launches an interactive TUI.')
    expect(cliDoc).to.include('Configure menu offers guided editing for common categories such as payments, network, and limits.')
    expect(cliDoc).to.include('Advanced dot-path get/set remains available for full settings access.')
  })

  it('does not ship removed legacy wrapper scripts', () => {
    const removedWrappers = [
      'start',
      'start_with_tor',
      'start_with_i2p',
      'start_with_nginx',
      'stop',
      'print_tor_hostname',
      'print_i2p_hostname',
      'update',
      'clean',
    ]

    for (const wrapper of removedWrappers) {
      expect(fs.existsSync(path.join(projectRoot, 'scripts', wrapper))).to.equal(false, wrapper)
    }
  })
})
