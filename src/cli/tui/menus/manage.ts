import { runExport } from '../../commands/export'
import { runImport } from '../../commands/import'
import { logError } from '../../utils/output'
import { tuiPrompts } from '../prompts'
import ora from 'ora'

export const runManageMenu = async (): Promise<number> => {
  const action = await tuiPrompts.select({
    message: 'Data management',
    options: [
      { value: 'export', label: 'Export events' },
      { value: 'import', label: 'Import events' },
      { value: 'back', label: 'Back' },
    ],
  })

  if (tuiPrompts.isCancel(action)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }
  if (action === 'back') {
    return 0
  }

  if (action === 'export') {
    const format = await tuiPrompts.select({
      message: 'Output format',
      options: [
        { value: 'jsonl', label: 'JSON Lines (.jsonl)' },
        { value: 'json', label: 'JSON array (.json)' },
        { value: 'back', label: 'Back' },
      ],
    })
    if (tuiPrompts.isCancel(format)) {
      tuiPrompts.cancel('Cancelled')
      return 1
    }
    if (format === 'back') {
      return 0
    }

    const output = await tuiPrompts.text({
      message: 'Output filename',
      defaultValue: format === 'json' ? 'events.json' : 'events.jsonl',
    })
    if (tuiPrompts.isCancel(output)) {
      tuiPrompts.cancel('Cancelled')
      return 1
    }

    const confirmed = await tuiPrompts.confirm({
      message: `Export events to ${output}?`,
      initialValue: true,
    })
    if (tuiPrompts.isCancel(confirmed) || !confirmed) {
      tuiPrompts.cancel('Cancelled')
      return 1
    }

    const spinner = ora('Exporting events...').start()
    const code = await runExport({ output, format: format as 'json' | 'jsonl' }, [])
    if (code === 0) {
      spinner.succeed('Export completed')
    } else {
      spinner.fail('Export failed')
    }
    return code
  }

  const format = await tuiPrompts.select({
    message: 'Input format',
    options: [
      { value: 'jsonl', label: 'JSON Lines (.jsonl)' },
      { value: 'json', label: 'JSON array (.json)' },
      { value: 'back', label: 'Back' },
    ],
  })
  if (tuiPrompts.isCancel(format)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }
  if (format === 'back') {
    return 0
  }

  const file = await tuiPrompts.text({
    message: 'Input file path',
    defaultValue: format === 'json' ? 'events.json' : 'events.jsonl',
  })
  if (tuiPrompts.isCancel(file)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const batchSizeRaw = await tuiPrompts.text({ message: 'Batch size', defaultValue: '1000' })
  if (tuiPrompts.isCancel(batchSizeRaw)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const batchSize = Number(batchSizeRaw)
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    logError('Batch size must be a positive integer')
    return 1
  }

  const confirmed = await tuiPrompts.confirm({
    message: `Import events from ${file}?`,
    initialValue: true,
  })
  if (tuiPrompts.isCancel(confirmed) || !confirmed) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const spinner = ora('Importing events...').start()
  const code = await runImport({ file, batchSize }, [])
  if (code === 0) {
    spinner.succeed('Import completed')
  } else {
    spinner.fail('Import failed')
  }
  return code
}
