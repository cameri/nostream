/* eslint-disable @typescript-eslint/no-var-requires */
import { Category } from '../@types/category'

const SettingsFileTypes = {
  yaml: 'yaml',
  json: 'json',
}
const NAMESPACE = 'c646b451-db73-47fb-9a70-ea24ce8a225a'
exports.seed = async function (knex) {
  const { v5: uuidv5 } = require('uuid')

  const rawConfigs = getConfigs()

  const categories = Object.keys(Category)

  // TODO: Finish logic
  // Do we want to flatten settings so that we can look them up by key more easily
  // Or do we organize by category? If by category
  const configsByCategory = categories.map(category => {
    return {
      id: uuidv5(event.id, NAMESPACE),
      value: rawConfigs[category],
      category,
    }
  })

  await knex.batchInsert('configs', configsByCategory, 10)
}

const getConfigs = () => {
  const settingsFilePath = process.env.NOSTR_CONFIG_DIR ?? join(process.cwd(), '.nostr')

  const files = fs.readdirSync(settingsFilePath)
  const filteredFile = files.find(fn => fn.startsWith('settings'))

  let settingsFile
  if (filteredFile) {
    const extension = extname(filteredFile).substring(1)
    if (SettingsFileTypes[extension]) {
      const extension = SettingsFileTypes[extension]
      settingsFileNamePath = `${settingsFilePath}/settings.${extension}`
      if (extension === SettingsFileTypes.json) {
        settingsFile = loadAndParseJsonFile(settingsFileNamePath)
      } else {
        settingsFile = loadAndParseYamlFile(settingsFileNamePath)
      }
    }
  } else {
    settingsFile = loadAndParseYamlFile('')
  }
}

const loadAndParseJsonFile = path => {
  return JSON.parse(
    fs.readFileSync(
      path,
      { encoding: 'utf-8' }
    )
  )
}

const loadAndParseYamlFile = path => {
  const defaultSettingsFileContent = fs.readFileSync(path, { encoding: 'utf-8' })
  const defaults = yaml.load(defaultSettingsFileContent)
  return defaults
}