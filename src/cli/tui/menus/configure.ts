import {
  getConfigTopLevelCategories,
  runConfigGet,
  runConfigList,
  runConfigSet,
  runConfigValidate,
} from '../../commands/config'
import { tuiPrompts } from '../prompts'

const toCategoryLabel = (key: string): string => {
  return key
    .split(/[_\-.]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

const getCategoryOptions = () => {
  const categories = getConfigTopLevelCategories().sort((a, b) => a.localeCompare(b))

  return [
    ...categories.map((category) => ({
      value: category,
      label: toCategoryLabel(category),
    })),
    { value: 'other', label: 'Other / full path' },
  ]
}

export const runConfigureMenu = async (): Promise<number> => {
  const action = await tuiPrompts.select({
    message: 'Configuration action',
    options: [
      { value: 'list', label: 'List all settings' },
      { value: 'get', label: 'Get setting by dot-path' },
      { value: 'set', label: 'Set setting by dot-path' },
      { value: 'validate', label: 'Validate settings' },
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

  if (action === 'list') {
    return runConfigList()
  }

  if (action === 'validate') {
    return runConfigValidate()
  }

  const category = await tuiPrompts.select({
    message: 'Configuration category',
    options: [...getCategoryOptions(), { value: 'back', label: 'Back' }],
  })
  if (tuiPrompts.isCancel(category)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }
  if (category === 'back') {
    return 0
  }

  const pathInput = await tuiPrompts.text({
    message: category === 'other' ? 'Full dot-path' : `Path inside ${category} (without "${category}.")`,
    placeholder: category === 'other' ? 'payments.enabled' : 'enabled',
    validate: (input) => (input.trim() ? undefined : 'Path is required'),
  })
  if (tuiPrompts.isCancel(pathInput)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const normalizedPath = pathInput.trim()
  const path = category === 'other' ? normalizedPath : `${category}.${normalizedPath}`

  const confirmedPath = await tuiPrompts.confirm({
    message: `Use path: ${path}?`,
    initialValue: true,
  })
  if (tuiPrompts.isCancel(confirmedPath) || !confirmedPath) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  if (action === 'get') {
    return runConfigGet(path)
  }

  const value = await tuiPrompts.text({ message: 'New value (true/false/number/string/json)' })
  if (tuiPrompts.isCancel(value)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  const restart = await tuiPrompts.confirm({
    message: 'Restart relay after this setting change?',
    initialValue: false,
  })
  if (tuiPrompts.isCancel(restart)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }

  return runConfigSet(path, value, { restart, validate: true, valueType: 'inferred' })
}
