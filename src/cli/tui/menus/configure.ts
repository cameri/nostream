import {
  runConfigGet,
  runConfigList,
  runConfigSet,
  runConfigValidate,
} from '../../commands/config'
import { getByPath, getTopLevelSettingCategories, loadMergedSettings, toCategoryLabel } from '../../../utils/settings-config'
import {
  type GuidedSettingField,
  guidedSettingCategories,
} from '../../../utils/settings-guided-schema'
import { tuiPrompts } from '../prompts'

const getCategoryOptions = () => {
  const categories = getTopLevelSettingCategories().sort((a, b) => a.localeCompare(b))

  return [
    ...categories.map((category) => ({
      value: category,
      label: toCategoryLabel(category),
    })),
    { value: 'other', label: 'Other / full path' },
  ]
}

const formatCurrentValue = (value: unknown): string => {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : value.join(', ')
  }

  if (typeof value === 'string') {
    return value
  }

  if (value === undefined) {
    return 'undefined'
  }

  if (value === null) {
    return 'null'
  }

  if (typeof value === 'object') {
    return JSON.stringify(value)
  }

  return String(value)
}

const getGuidedSettingValue = async (setting: GuidedSettingField, currentValue: unknown) => {
  switch (setting.type) {
    case 'boolean': {
      const answer = await tuiPrompts.confirm({
        message: `${setting.label} (current: ${formatCurrentValue(currentValue)})`,
        initialValue: Boolean(currentValue),
      })

      if (tuiPrompts.isCancel(answer)) {
        tuiPrompts.cancel('Cancelled')
        return undefined
      }

      return {
        rawValue: String(answer),
        valueType: 'inferred' as const,
      }
    }
    case 'select': {
      const options = (setting.options ?? []).map((option) => ({
        value: option,
        label: option,
        hint: option === currentValue ? 'current' : undefined,
      }))

      const answer = await tuiPrompts.select({
        message: `${setting.label} (current: ${formatCurrentValue(currentValue)})`,
        options: [...options, { value: 'back', label: 'Back' }],
      })

      if (tuiPrompts.isCancel(answer) || answer === 'back') {
        tuiPrompts.cancel('Cancelled')
        return undefined
      }

      return {
        rawValue: answer,
        valueType: 'inferred' as const,
      }
    }
    case 'stringArray': {
      const defaultValue = Array.isArray(currentValue) ? currentValue.join(', ') : ''
      const answer = await tuiPrompts.text({
        message: `${setting.label} (comma-separated)`,
        defaultValue,
      })

      if (tuiPrompts.isCancel(answer)) {
        tuiPrompts.cancel('Cancelled')
        return undefined
      }

      const parsed = answer
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)

      return {
        rawValue: JSON.stringify(parsed),
        valueType: 'json' as const,
      }
    }
    default: {
      const answer = await tuiPrompts.text({
        message: `${setting.label} (current: ${formatCurrentValue(currentValue)})`,
        defaultValue: currentValue === undefined || currentValue === null ? '' : String(currentValue),
        placeholder: setting.placeholder,
        validate: setting.validate,
      })

      if (tuiPrompts.isCancel(answer)) {
        tuiPrompts.cancel('Cancelled')
        return undefined
      }

      return {
        rawValue: answer,
        valueType: 'inferred' as const,
      }
    }
  }
}

const runGuidedConfigureMenu = async (): Promise<number> => {
  const category = await tuiPrompts.select({
    message: 'Configuration category',
    options: [...guidedSettingCategories.map(({ value, label }) => ({ value, label })), { value: 'back', label: 'Back' }],
  })

  if (tuiPrompts.isCancel(category)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }
  if (category === 'back') {
    return 0
  }

  const selectedCategory = guidedSettingCategories.find((entry) => entry.value === category)
  if (!selectedCategory) {
    tuiPrompts.cancel('Unknown category')
    return 1
  }

  const settings = loadMergedSettings() as unknown as Record<string, unknown>
  const setting = await tuiPrompts.select({
    message: `${selectedCategory.label} setting`,
    options: [
      ...selectedCategory.settings.map((entry) => ({
        value: entry.path,
        label: entry.label,
        hint: `current: ${formatCurrentValue(getByPath(settings, entry.path))}`,
      })),
      { value: 'back', label: 'Back' },
    ],
  })

  if (tuiPrompts.isCancel(setting)) {
    tuiPrompts.cancel('Cancelled')
    return 1
  }
  if (setting === 'back') {
    return 0
  }

  const selectedSetting = selectedCategory.settings.find((entry) => entry.path === setting)
  if (!selectedSetting) {
    tuiPrompts.cancel('Unknown setting')
    return 1
  }

  const currentValue = getByPath(settings, selectedSetting.path)
  const nextValue = await getGuidedSettingValue(selectedSetting, currentValue)
  if (!nextValue) {
    return 1
  }

  const confirmedSave = await tuiPrompts.confirm({
    message: `Save ${selectedSetting.label}?`,
    initialValue: true,
  })
  if (tuiPrompts.isCancel(confirmedSave) || !confirmedSave) {
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

  return runConfigSet(selectedSetting.path, nextValue.rawValue, {
    restart,
    validate: true,
    valueType: nextValue.valueType,
  })
}

export const runConfigureMenu = async (): Promise<number> => {
  const action = await tuiPrompts.select({
    message: 'Configuration action',
    options: [
      { value: 'list', label: 'List all settings' },
      { value: 'guided', label: 'Guided edit (common settings)' },
      { value: 'get', label: 'Advanced get by dot-path' },
      { value: 'set', label: 'Advanced set by dot-path' },
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

  if (action === 'guided') {
    return runGuidedConfigureMenu()
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
