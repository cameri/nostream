/* eslint-disable @typescript-eslint/no-var-requires */
const { extname, join } = require('path')
const fs = require('fs')
const yaml = require('js-yaml')
const { v5: uuidv5 } = require('uuid')

const SettingsFileTypes = {
  yaml: 'yaml',
  json: 'json',
}

const NAMESPACE = 'c646b451-db73-47fb-9a70-ea24ce8a225a'

exports.seed = async function (knex) {
  const settingsFilePath = `${process.cwd()}/seeds/configs.json`
  const defaultConfigs = fs.readFileSync(settingsFilePath)
  // await knew.batchInsert('configs', defaultConfigs, 10)

  const rawConfigs = getConfigs()

  const parsedConfigs = parseAll(rawConfigs)

  if (parsedConfigs) {
    // await knex.batchInsert('configs', configsByCategory, 10)
  }
}

const getConfigs = () => {
  const settingsFilePath = process.env.NOSTR_CONFIG_DIR ?? join(process.cwd(), '.nostr')

  const files = fs.readdirSync(settingsFilePath)
  const settingsFilesTotal = files.filter(file => file.match(/settings/))

  if (settingsFilesTotal.length > 1) {
    throw new Error('There are more than 1 settings file, please delete all files that contain the word settings in their name, and restart the relay')
  }

  const filteredFile = files.find(fn => fn.startsWith('settings'))

  let settingsFile
  if (filteredFile) {
    const extension = extname(filteredFile).substring(1)
    if (SettingsFileTypes[extension]) {
      settingsFileNamePath = `${settingsFilePath}/settings.${extension}`
      if (extension === SettingsFileTypes.json) {
        settingsFile = loadAndParseJsonFile(settingsFileNamePath)
      } else {
        settingsFile = loadAndParseYamlFile(settingsFileNamePath)
      }
    }
  }

  return settingsFile
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

const parseAll = (jsonConfigs) => {
  if (!jsonConfigs) return

  const keys = Object.keys(jsonConfigs)

  const configs = keys.map(key => {
    return parseOneLevelDeepConfigs(jsonConfigs[key], key)
  })

  return configs.flat()
}

const parseOneLevelDeepConfigs = (configs, category) => {
  const keys = Object.keys(configs)
  console.log(keys)
  const flattenedConfigs = Object.keys(configs).map(key => {
    return {
      id: uuidv5('id', NAMESPACE),
      key,
      value: configs[key],
      category
    }
  })

  return flattenedConfigs
}
