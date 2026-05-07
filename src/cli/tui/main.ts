import { runInfo } from '../commands/info'
import { runStartMenu } from './menus/start'
import { runStopMenu } from './menus/stop'
import { runConfigureMenu } from './menus/configure'
import { runManageMenu } from './menus/manage'
import { runDevMenu } from './menus/dev'
import { createState } from './state'
import { tuiPrompts } from './prompts'

export const runTui = async (): Promise<number> => {
  const state = createState()
  tuiPrompts.intro('Nostream Control Center')

  while (state.running) {
    const action = await tuiPrompts.select({
      message: 'What would you like to do?',
      options: [
        { value: 'start', label: 'Start relay' },
        { value: 'stop', label: 'Stop relay' },
        { value: 'configure', label: 'Configure settings' },
        { value: 'manage', label: 'Manage data (export/import)' },
        { value: 'dev', label: 'Development tools' },
        { value: 'info', label: 'View relay info' },
        { value: 'exit', label: 'Exit' },
      ],
    })

    if (tuiPrompts.isCancel(action) || action === 'exit') {
      state.running = false
      break
    }

    switch (action) {
      case 'start':
        await runStartMenu()
        break
      case 'stop':
        await runStopMenu()
        break
      case 'configure':
        await runConfigureMenu()
        break
      case 'manage':
        await runManageMenu()
        break
      case 'dev':
        await runDevMenu()
        break
      case 'info':
        await runInfo({})
        break
      default:
        tuiPrompts.cancel('Unknown action')
    }
  }

  tuiPrompts.outro('Goodbye')
  return 0
}
