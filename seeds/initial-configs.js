/* eslint-disable @typescript-eslint/no-var-requires */
const { extname, join } = require('path')
const fs = require('fs')
const yaml = require('js-yaml')
const { mergeDeepLeft } = require('ramda')

const SettingsFileTypes = {
  yaml: 'yaml',
  json: 'json',
}

exports.seed = async function (knex) {
  const settingsFilePath = `${process.cwd()}/seeds/configs.json`
  const defaultConfigs = JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'))

  const rawConfigs = getConfigs()
  const parsedConfigs = parseAll(rawConfigs)

  const mergedSettings = mergeDeepLeft(defaultConfigs, parsedConfigs)

  for (const settingKey of Object.keys(mergedSettings)) {
    try {
      //const res = await knex('configs').insert(setting)
      const res = await knex('configs').insert([mergedSettings[settingKey]])
      console.log('knex res', res)
    } catch (err) {
      // TODO remove this log when finished developing
      console.log('Failed to insert config due to error: ', err)
      // Nothing to log as if this fails the config already exists, which is fine
    }
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
      const settingsFileNamePath = `${settingsFilePath}/settings.${extension}`
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
  const flattenedConfigs = Object.keys(configs).map(key => {
    return {
      key,
      value: configs[key],
      category,
    }
  })

  return flattenedConfigs
}


// TODO: fix the key "enabled", as it repeats