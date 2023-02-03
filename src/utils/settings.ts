import fs from 'fs'
import yaml from 'js-yaml'

import { extname, join } from 'path'
import { mergeDeepRight } from 'ramda'

import { createLogger } from '../factories/logger-factory'
import { Settings } from '../@types/settings'

const debug = createLogger('settings')

export enum SettingsFileTypes {
  yaml = 'yaml',
  json = 'json',
}

export class SettingsStatic {
  static _settings: Settings | undefined

  public static getSettingsFileBasePath(): string {
    return process.env.NOSTR_CONFIG_DIR ?? join(process.cwd(), '.nostr')
  }

  public static getDefaultSettingsFilePath(): string {
    return join(process.cwd(), 'resources', 'default-settings.yaml')
  }

  public static loadAndParseYamlFile(path: string): Settings {
    const defaultSettingsFileContent = fs.readFileSync(path, { encoding: 'utf-8' })
    const defaults = yaml.load(defaultSettingsFileContent) as Settings
    return defaults
  }

  public static loadAndParseJsonFile(path: string) {
    return JSON.parse(
      fs.readFileSync(
        path,
        { encoding: 'utf-8' }
      )
    )
  }

  public static settingsFileType(path: string): SettingsFileTypes | undefined {
    const files: string[] = fs.readdirSync(path)
    const filteredFile = files.find(fn => fn.startsWith('settings'))
    if (filteredFile) {
      const extension = extname(filteredFile).substring(1)
      if (SettingsFileTypes[extension]) {
        return SettingsFileTypes[extension]
      }
    }

    return SettingsFileTypes.yaml
  }

  public static loadSettings(path: string, fileType: SettingsFileTypes) {
    debug('loading settings from %s', path)

    switch (fileType) {
      case SettingsFileTypes.json: {
        console.warn('settings.json is deprecated, please use a yaml file based on resources/default-settings.yaml')
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
    debug('creating settings')

    const basePath = SettingsStatic.getSettingsFileBasePath()
    if (!fs.existsSync(basePath)) {
      fs.mkdirSync(basePath)
    }
    const defaultsFilePath = SettingsStatic.getDefaultSettingsFilePath()
    const fileType = SettingsStatic.settingsFileType(basePath)
    const settingsFilePath = join(basePath, `settings.${fileType}`)

    const defaults = SettingsStatic.loadSettings(defaultsFilePath, SettingsFileTypes.yaml)

    try {
      if (fileType) {
        SettingsStatic._settings = mergeDeepRight(
          defaults,
          SettingsStatic.loadSettings(settingsFilePath, fileType)
        )
      } else {
        SettingsStatic.saveSettings(basePath, defaults)
        SettingsStatic._settings = mergeDeepRight({}, defaults)
      }

      if (typeof SettingsStatic._settings === 'undefined') {
        throw new Error('Unable to set settings')
      }

      return SettingsStatic._settings
    } catch (error) {
      debug('error reading config file at %s: %o', settingsFilePath, error)

      return defaults
    }
  }

  public static saveSettings(path: string, settings: Settings) {
    debug('saving settings to %s: %o', path, settings)
    return fs.writeFileSync(
      join(path, 'settings.yaml'),
      yaml.dump(settings),
      { encoding: 'utf-8' },
    )
  }

  public static watchSettings() {
    const basePath = SettingsStatic.getSettingsFileBasePath()
    const defaultsFilePath = SettingsStatic.getDefaultSettingsFilePath()
    const fileType = SettingsStatic.settingsFileType(basePath)
    const settingsFilePath = join(basePath, `settings.${fileType}`)

    const reload = () => {
      console.log('reloading settings')
      SettingsStatic._settings = undefined
      SettingsStatic.createSettings()
    }

    return [
      fs.watch(defaultsFilePath, 'utf8', reload),
      fs.watch(settingsFilePath, 'utf8', reload),
    ]
  }
}
