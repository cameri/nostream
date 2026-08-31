import fs from 'fs'
import yaml from 'js-yaml'

import { extname, join } from 'path'

import { createLogger } from '../factories/logger-factory'
import { Settings } from '../@types/settings'
import { loadDefaults, loadMergedSettings } from './settings-config'
import { getConfigBaseDir, getDefaultSettingsFilePath, getSettingsFilePath } from './settings-paths'

const logger = createLogger('settings')

export enum SettingsFileTypes {
  yaml = 'yaml',
  json = 'json',
}

export class SettingsStatic {
  static _settings: Settings | undefined

  public static getSettingsFileBasePath(): string {
    return getConfigBaseDir()
  }

  public static getDefaultSettingsFilePath(): string {
    return getDefaultSettingsFilePath()
  }

  public static loadAndParseYamlFile(path: string): Settings {
    const defaultSettingsFileContent = fs.readFileSync(path, { encoding: 'utf-8' })
    const defaults = yaml.load(defaultSettingsFileContent) as Settings
    return defaults
  }

  public static loadAndParseJsonFile(path: string) {
    return JSON.parse(fs.readFileSync(path, { encoding: 'utf-8' }))
  }

  public static settingsFileType(path: string): SettingsFileTypes | undefined {
    const files: string[] = fs.readdirSync(path)
    const filteredFile = files.find((fn) => fn.startsWith('settings'))
    if (filteredFile) {
      const extension = extname(filteredFile).substring(1)
      if (SettingsFileTypes[extension]) {
        return SettingsFileTypes[extension]
      }
    }

    return SettingsFileTypes.yaml
  }

  public static loadSettings(path: string, fileType: SettingsFileTypes) {
    logger('loading settings from %s', path)

    switch (fileType) {
      case SettingsFileTypes.json: {
        logger.warn('settings.json is deprecated, please use a yaml file based on resources/default-settings.yaml')
        return SettingsStatic.loadAndParseJsonFile(path)
      }
      case SettingsFileTypes.yaml: {
        return SettingsStatic.loadAndParseYamlFile(path)
      }
      default: {
        throw new Error('settings file was missing or did not contain .yaml or .json extensions.')
      }
    }
  }

  public static createSettings(): Settings {
    if (SettingsStatic._settings) {
      return SettingsStatic._settings
    }
    logger('creating settings')

    const basePath = getConfigBaseDir()
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath, { recursive: true })
    }

    const settingsFilePath = getSettingsFilePath()

    try {
      SettingsStatic._settings = loadMergedSettings()

      if (typeof SettingsStatic._settings === 'undefined') {
        throw new Error('Unable to set settings')
      }

      return SettingsStatic._settings
    } catch (error) {
      logger('error reading config file at %s: %o', settingsFilePath, error)

      SettingsStatic._settings = loadDefaults()
      return SettingsStatic._settings
    }
  }

  public static saveSettings(path: string, settings: Settings) {
    logger('saving settings to %s: %o', path, settings)
    return fs.writeFileSync(join(path, 'settings.yaml'), yaml.dump(settings), { encoding: 'utf-8' })
  }

  public static watchSettings() {
    const basePath = getConfigBaseDir()
    const defaultsFilePath = getDefaultSettingsFilePath()
    const fileType = SettingsStatic.settingsFileType(basePath)

    const reload = () => {
      logger('reloading settings')
      SettingsStatic._settings = undefined
      SettingsStatic.createSettings()
    }

    const watchSettingsDirectory = (_eventType: string, filename: string | Buffer | null) => {
      if (filename?.toString() === `settings.${fileType}`) {
        reload()
      }
    }

    return [fs.watch(defaultsFilePath, 'utf8', reload), fs.watch(basePath, 'utf8', watchSettingsDirectory)]
  }
}
